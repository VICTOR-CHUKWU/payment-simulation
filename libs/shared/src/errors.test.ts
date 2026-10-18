import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { z } from "zod";
import {
  AppError,
  badRequest,
  conflict,
  errorHandler,
  forbidden,
  notFound,
  notFoundHandler,
  problemDetailsSchema,
  serviceUnavailable,
  toJsonPointer,
  tooManyRequests,
  unauthorized,
  unprocessable,
} from "./errors.js";
import { createLogger, httpLogger } from "./logger.js";

const PROBLEM_JSON = /^application\/problem\+json/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const itemSchema = z.object({
  "a/b": z.string(),
  items: z.array(z.object({ currency: z.string().length(3) })),
});

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
  app.use(express.json({ limit: "100b" }));
  app.get("/sync", () => {
    throw conflict("Version mismatch.", { code: "version-conflict" });
  });
  app.get("/async", async () => {
    await Promise.resolve();
    throw conflict("Version mismatch.", { code: "version-conflict" });
  });
  app.get("/auth", () => {
    throw unauthorized("Missing token.", {
      headers: { "WWW-Authenticate": "Bearer" },
    });
  });
  app.post("/validate", (req, res) => {
    res.json(itemSchema.parse(req.body));
  });
  app.post("/echo", (req, res) => {
    res.json(req.body);
  });
  app.get("/boom", () => {
    throw new Error("db exploded at /var/secret");
  });
  app.get("/unavailable", () => {
    throw serviceUnavailable();
  });
  app.get("/partial", (_req, res, next) => {
    res.write("partial");
    next(new Error("late failure"));
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  const lines = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  const completion = () => lines().filter((line) => "responseTime" in line);
  return { app, completion, raw };
}

describe("errorHandler", () => {
  it.each(["/sync", "/async"])(
    "maps an AppError from %s to a problem response",
    async (path) => {
      const { app } = setup();
      const res = await request(app).get(path);
      expect(res.status).toBe(409);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(problemDetailsSchema.parse(res.body)).toEqual({
        code: "version-conflict",
        detail: "Version mismatch.",
        instance: path,
        requestId: res.headers["x-request-id"],
        status: 409,
        title: "Conflict",
        type: "tag:payment-be,2026:version-conflict",
      });
    }
  );

  it("reuses the client's request ID and drops the query string", async () => {
    const { app } = setup();
    const res = await request(app)
      .get("/sync?token=abc")
      .set("x-request-id", "abc-123");
    expect(res.headers["x-request-id"]).toBe("abc-123");
    expect(res.body).toMatchObject({ instance: "/sync", requestId: "abc-123" });
  });

  it("sends AppError headers", async () => {
    const { app } = setup();
    const res = await request(app).get("/auth");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.body).toMatchObject({
      code: "unauthorized",
      title: "Unauthorized",
      type: "about:blank",
    });
  });

  it("maps a ZodError to a validation problem with JSON Pointers", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/validate")
      .send({ items: [{ currency: "NGNX" }] });
    expect(res.status).toBe(400);
    expect(problemDetailsSchema.parse(res.body)).toMatchObject({
      code: "validation-error",
      detail: "The request is invalid.",
      title: "Validation failed",
      type: "tag:payment-be,2026:validation-error",
    });
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_type", pointer: "/a~1b" }),
        expect.objectContaining({
          code: "too_big",
          pointer: "/items/0/currency",
        }),
      ])
    );
  });

  it("keeps a malformed JSON body out of the response and logs", async () => {
    const { app, raw } = setup();
    const res = await request(app)
      .post("/echo")
      .set("content-type", "application/json")
      .send('{"password":"hunter2"');
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({
      code: "malformed-json",
      detail: "The request body is not valid JSON.",
      title: "Bad Request",
      type: "about:blank",
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(raw.join("\n")).not.toContain("hunter2");
  });

  it("maps an oversized body to 413", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/echo")
      .send({ data: "x".repeat(200) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: "payload-too-large",
      title: "Payload Too Large",
    });
  });

  it("hides an unexpected error from the client and logs it", async () => {
    const { app, completion } = setup();
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(problemDetailsSchema.parse(res.body)).toMatchObject({
      code: "internal-error",
      detail: "An unexpected error occurred.",
      title: "Internal Server Error",
      type: "about:blank",
    });
    expect(res.text).not.toContain("exploded");
    const [done] = completion();
    expect(done?.level).toBe(50);
    expect(done?.err).toMatchObject({
      message: "db exploded at /var/secret",
      stack: expect.stringContaining("db exploded"),
    });
  });

  it("logs a 5xx AppError with its error", async () => {
    const { app, completion } = setup();
    const res = await request(app).get("/unavailable");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("service-unavailable");
    expect(completion()[0]?.err).toBeDefined();
  });

  it("logs a 4xx AppError at warn without the error", async () => {
    const { app, completion } = setup();
    await request(app).get("/sync");
    const [done] = completion();
    expect(done?.level).toBe(40);
    expect(done).not.toHaveProperty("err");
  });

  it("returns a not-found problem for an unknown route", async () => {
    const { app } = setup();
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({
      code: "not-found",
      instance: "/nope",
      title: "Not Found",
      type: "about:blank",
    });
    expect(res.body.requestId).toMatch(UUID_PATTERN);
  });

  it("destroys a response that already started and logs the error", async () => {
    const { app, completion } = setup();
    await expect(request(app).get("/partial")).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    const [done] = completion();
    expect(done?.level).toBe(50);
    expect(done?.err).toMatchObject({ message: "late failure" });
  });
});

describe("client errors by shape", () => {
  function appThrowing(err: unknown) {
    const app = express();
    app.get("/", () => {
      throw err;
    });
    app.use(errorHandler);
    return app;
  }

  it.each([
    [{ expose: true, status: 415 }, 415, "unsupported-media-type"],
    [{ expose: true, statusCode: 405 }, 405, "method-not-allowed"],
    [{ expose: true, status: 418 }, 418, "i-m-a-teapot"],
    [{ expose: true, status: 499 }, 400, "bad-request"],
  ])("maps %o to %d %s", async (err, status, code) => {
    const res = await request(appThrowing(err)).get("/");
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code, type: "about:blank" });
  });

  it.each([
    { expose: false, status: 400 },
    { status: 502 },
    "a thrown string",
    Object.create(null),
    new AppError({ code: "moved", headers: { location: "/x" }, status: 302 }),
  ])("treats %o as an internal error", async (err) => {
    const res = await request(appThrowing(err)).get("/");
    expect(res.status).toBe(500);
    expect(res.headers.location).toBeUndefined();
    expect(problemDetailsSchema.parse(res.body).code).toBe("internal-error");
  });

  it("never sends an http-error's message", async () => {
    const res = await request(
      appThrowing(
        Object.assign(new Error("secret detail"), { expose: true, status: 400 })
      )
    ).get("/");
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("secret detail");
  });
});

describe("problem helpers", () => {
  it.each([
    [badRequest, 400, "bad-request", "Bad Request"],
    [unauthorized, 401, "unauthorized", "Unauthorized"],
    [forbidden, 403, "forbidden", "Forbidden"],
    [notFound, 404, "not-found", "Not Found"],
    [conflict, 409, "conflict", "Conflict"],
    [unprocessable, 422, "unprocessable-entity", "Unprocessable Entity"],
    [tooManyRequests, 429, "too-many-requests", "Too Many Requests"],
    [serviceUnavailable, 503, "service-unavailable", "Service Unavailable"],
  ])(
    "builds a plain HTTP problem by default",
    (factory, status, code, title) => {
      const err = factory("Some detail.");
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code,
        detail: "Some detail.",
        name: "AppError",
        status,
        title,
        type: "about:blank",
      });
    }
  );

  it("uses a tag URI and keeps the cause when a code is given", () => {
    const cause = new Error("root");
    const err = unprocessable(undefined, {
      cause,
      code: "invalid-transition",
      title: "Invalid status transition",
    });
    expect(err).toMatchObject({
      cause,
      code: "invalid-transition",
      detail: undefined,
      title: "Invalid status transition",
      type: "tag:payment-be,2026:invalid-transition",
    });
  });

  it("ignores a title override on a plain problem", () => {
    expect(notFound(undefined, { title: "Gone fishing" }).title).toBe(
      "Not Found"
    );
  });
});

describe("toJsonPointer", () => {
  it.each([
    [[], ""],
    [["items", 0, "currency"], "/items/0/currency"],
    [[Symbol("s")], "/Symbol(s)"],
    [["a/b"], "/a~1b"],
    [["a~b"], "/a~0b"],
    [["~1"], "/~01"],
    [["/~"], "/~1~0"],
  ] as [PropertyKey[], string][])("converts %p to %p", (path, pointer) => {
    expect(toJsonPointer(path)).toBe(pointer);
  });
});
