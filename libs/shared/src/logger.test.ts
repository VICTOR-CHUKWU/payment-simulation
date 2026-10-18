import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { bindLogUser, createLogger, httpLogger } from "./logger.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function capture() {
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      raw.push(...chunk.toString().split("\n").filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({
    destination,
    level: "info",
    pretty: false,
    service: "test",
  });
  const lines = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, logger, raw };
}

function setup() {
  const { lines, logger, raw } = capture();
  const app = express();
  app.use(httpLogger(logger));
  app.get("/health/live", (_req, res) => {
    res.sendStatus(200);
  });
  app.get("/ok", (_req, res) => {
    res.sendStatus(200);
  });
  app.get("/login", (_req, res) => {
    res.cookie("session", "secret").sendStatus(200);
  });
  app.get("/fail", (_req, res) => {
    res.sendStatus(500);
  });
  app.get("/flagged", (_req, res) => {
    res.err = new Error("flagged");
    res.sendStatus(200);
  });
  app.get("/me", (req, res) => {
    bindLogUser(req, res, { role: "user", userId: "u_1" });
    req.log.info("handler line");
    res.sendStatus(200);
  });
  return { app, lines, raw };
}

const completion = (lines: Record<string, unknown>[]) =>
  lines.filter((line) => "responseTime" in line);

describe("httpLogger", () => {
  it("reuses a valid x-request-id, echoes it and logs it as correlationId", async () => {
    const { app, lines } = setup();
    const res = await request(app).get("/ok").set("x-request-id", "abc-123");
    expect(res.headers["x-request-id"]).toBe("abc-123");
    expect(completion(lines())[0]?.correlationId).toBe("abc-123");
  });

  it.each([
    ["missing", undefined],
    ["too long", "a".repeat(129)],
    ["bad characters", "abc 123;&<>"],
  ])("replaces a %s x-request-id with a UUID", async (_label, header) => {
    const { app, lines } = setup();
    const req = request(app).get("/ok");
    const res = await (header === undefined
      ? req
      : req.set("x-request-id", header));
    const id = res.headers["x-request-id"];
    expect(id).toMatch(UUID_PATTERN);
    expect(completion(lines())[0]?.correlationId).toBe(id);
  });

  it("redacts the authorization, cookie and set-cookie headers", async () => {
    const { app, lines, raw } = setup();
    await request(app)
      .get("/login")
      .set("authorization", "Bearer secret")
      .set("cookie", "session=secret");
    const [done] = completion(lines());
    expect(done).toMatchObject({
      req: {
        headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
      },
      res: { headers: { "set-cookie": "[Redacted]" } },
    });
    expect(raw.join("\n")).not.toContain("secret");
  });

  it("adds a bound user to the completion line and handler lines once", async () => {
    const { app, lines, raw } = setup();
    await request(app).get("/me");
    const handler = lines().find((line) => line.msg === "handler line");
    const [done] = completion(lines());
    expect(handler).toMatchObject({ role: "user", userId: "u_1" });
    expect(done).toMatchObject({ role: "user", userId: "u_1" });
    const doneRaw = raw.find((line) => line.includes("responseTime")) ?? "";
    expect(doneRaw.match(/"correlationId"/g)).toHaveLength(1);
    for (const line of lines()) {
      expect(line.service).toBe("test");
      expect(line).not.toHaveProperty("pid");
      expect(line).not.toHaveProperty("hostname");
    }
  });

  it("leaves user fields off an unbound request", async () => {
    const { app, lines } = setup();
    await request(app).get("/ok");
    const [done] = completion(lines());
    expect(done).not.toHaveProperty("userId");
    expect(done).not.toHaveProperty("role");
  });

  it("skips the completion line for health probes but sets the header", async () => {
    const { app, lines } = setup();
    const res = await request(app).get("/health/live");
    expect(res.headers["x-request-id"]).toMatch(UUID_PATTERN);
    expect(completion(lines())).toHaveLength(0);
  });

  it.each([
    ["/ok", 30],
    ["/nope", 40],
    ["/fail", 50],
    ["/flagged", 50],
  ])("logs %s at level %d", async (path, level) => {
    const { app, lines } = setup();
    await request(app).get(path);
    expect(completion(lines())[0]?.level).toBe(level);
  });
});

describe("createLogger", () => {
  it("redacts sensitive keys at the top level and nested", () => {
    const { lines, logger, raw } = capture();
    logger.info(
      {
        email: "a@b.co",
        token: "t",
        user: { email: "a@b.co", password: "p" },
      },
      "msg"
    );
    expect(lines()[0]).toMatchObject({
      email: "[Redacted]",
      token: "[Redacted]",
      user: { email: "[Redacted]", password: "[Redacted]" },
    });
    expect(raw[0]).not.toContain("a@b.co");
  });

  it("binds service and an ISO time, without pid or hostname", () => {
    const { lines, logger } = capture();
    logger.info("msg");
    const [line] = lines();
    expect(line?.service).toBe("test");
    expect(new Date(line?.time as string).toISOString()).toBe(line?.time);
    expect(line).not.toHaveProperty("pid");
    expect(line).not.toHaveProperty("hostname");
  });
});
