import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import { SignJWT, UnsecuredJWT } from "jose";
import request from "supertest";
import { authenticate, getAuth, requireRole } from "./auth-middleware.js";
import { errorHandler } from "./errors.js";
import { createLogger, httpLogger } from "./logger.js";

const SECRET = "test-secret-at-least-32-characters-long";
const PROBLEM_JSON = /^application\/problem\+json/;

const now = () => Math.floor(Date.now() / 1000);

interface TokenOptions {
  alg?: string;
  claims?: Record<string, unknown>;
  exp?: number | null;
  secret?: string;
}

function sign({
  alg = "HS256",
  claims = {},
  exp = now() + 3600,
  secret = SECRET,
}: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ email: "ada@example.com", role: "user", ...claims })
    .setProtectedHeader({ alg, typ: "JWT" })
    .setSubject(String(claims.sub ?? randomUUID()))
    .setIssuedAt(now() - 10);
  if (exp !== null) {
    jwt.setExpirationTime(exp);
  }
  return jwt.sign(new TextEncoder().encode(secret));
}

function setup() {
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
  const app = express();
  app.use(httpLogger(logger));
  app.get("/me", authenticate(SECRET), (req, res) => {
    res.json(getAuth(req));
  });
  app.get("/admin", authenticate(SECRET), requireRole("admin"), (_req, res) => {
    res.sendStatus(200);
  });
  app.get(
    "/any",
    authenticate(SECRET),
    requireRole("user", "admin"),
    (_req, res) => {
      res.sendStatus(200);
    }
  );
  app.get("/unwired-role", requireRole("admin"), (_req, res) => {
    res.sendStatus(200);
  });
  app.get("/unwired-get", (req, res) => {
    res.json(getAuth(req));
  });
  app.use(errorHandler);
  const lines = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, lines, raw };
}

const withoutRequestId = (body: Record<string, unknown>) => {
  const { requestId: _requestId, ...rest } = body;
  return rest;
};

describe("authenticate", () => {
  it("accepts a valid token and exposes its claims through getAuth", async () => {
    const sub = randomUUID();
    const token = await sign({ claims: { sub } });
    const res = await request(setup().app)
      .get("/me")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: "ada@example.com",
      role: "user",
      sub,
    });
  });

  it("accepts the scheme in lower case", async () => {
    const res = await request(setup().app)
      .get("/me")
      .set("authorization", `bearer ${await sign()}`);
    expect(res.status).toBe(200);
  });

  it.each([
    ["no header", undefined],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["Bearer with no token", "Bearer "],
  ])("rejects %s as unauthorized", async (_label, header) => {
    const req = request(setup().app).get("/me");
    const res = await (header === undefined
      ? req
      : req.set("authorization", header));
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.body).toMatchObject({
      code: "unauthorized",
      type: "about:blank",
    });
  });

  it("rejects every bad token with the same invalid-token response", async () => {
    const tokens: [string, string][] = [
      ["malformed", "not.a.jwt"],
      ["wrong secret", await sign({ secret: "x".repeat(32) })],
      ["expired", await sign({ exp: now() - 1 })],
      ["HS512", await sign({ alg: "HS512" })],
      [
        "alg none",
        new UnsecuredJWT({ email: "ada@example.com", role: "admin" })
          .setSubject(randomUUID())
          .setIssuedAt()
          .setExpirationTime("1h")
          .encode(),
      ],
      ["no exp", await sign({ exp: null })],
      ["non-uuid sub", await sign({ claims: { sub: "42" } })],
      ["unknown role", await sign({ claims: { role: "owner" } })],
    ];
    const { app } = setup();
    const responses = await Promise.all(
      tokens.map(async ([label, token]) => ({
        label,
        res: await request(app)
          .get("/me")
          .set("authorization", `Bearer ${token}`),
      }))
    );
    const first = withoutRequestId(responses[0]?.res.body);
    for (const { label, res } of responses) {
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.headers["www-authenticate"]).toBe(
        'Bearer error="invalid_token"'
      );
      expect(res.body).toMatchObject({ code: "invalid-token" });
      expect(withoutRequestId(res.body)).toEqual(first);
    }
  });

  it("binds userId and role to the log line without the token or email", async () => {
    const sub = randomUUID();
    const token = await sign({ claims: { role: "admin", sub } });
    const { app, lines, raw } = setup();
    await request(app).get("/admin").set("authorization", `Bearer ${token}`);
    const completion = lines().find((line) => "responseTime" in line);
    expect(completion).toMatchObject({ role: "admin", userId: sub });
    const output = raw.join("\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain("ada@example.com");
  });
});

describe("requireRole", () => {
  it("forbids a role that is not listed", async () => {
    const res = await request(setup().app)
      .get("/admin")
      .set("authorization", `Bearer ${await sign()}`);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ code: "forbidden", type: "about:blank" });
  });

  it("allows a listed role", async () => {
    const token = await sign({ claims: { role: "admin" } });
    const res = await request(setup().app)
      .get("/admin")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it.each(["user", "admin"])(
    "allows %s when both roles are listed",
    async (role) => {
      const token = await sign({ claims: { role } });
      const res = await request(setup().app)
        .get("/any")
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
  );
});

describe("getAuth", () => {
  it.each(["/unwired-role", "/unwired-get"])(
    "fails with 500 on %s when authenticate did not run",
    async (path) => {
      const token = await sign({ claims: { role: "admin" } });
      const res = await request(setup().app)
        .get(path)
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: "internal-error" });
    }
  );
});
