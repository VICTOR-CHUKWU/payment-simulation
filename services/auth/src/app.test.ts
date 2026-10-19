import {
  createLogger,
  createMemoryRepository,
  type ReadinessCheck,
} from "@payment-be/shared";
import request from "supertest";
import { createApp } from "./app.js";
import type { User } from "./user/index.js";

const HTML = /^text\/html/;
const PROBLEM_JSON = /^application\/problem\+json/;

const logger = createLogger({
  level: "silent",
  pretty: false,
  service: "test",
});

const deps = () => ({
  jwtSecret: "s".repeat(32),
  loginRateLimit: { max: 1000, windowMs: 60_000 },
  users: createMemoryRepository<User>(),
});

const check = (ok: boolean): ReadinessCheck => ({
  check: () => ok,
  name: "dep",
});

describe("auth app", () => {
  it("reports live", async () => {
    const res = await request(
      createApp({ checks: [], docs: false, logger, ...deps() })
    ).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("sets an x-request-id on responses", async () => {
    const res = await request(
      createApp({ checks: [], docs: false, logger, ...deps() })
    ).get("/health/live");
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("is ready when checks pass", async () => {
    const res = await request(
      createApp({ checks: [check(true)], docs: false, logger, ...deps() })
    ).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checks: { dep: "ok" }, status: "ok" });
  });

  it("is not ready when a check fails", async () => {
    const res = await request(
      createApp({ checks: [check(false)], docs: false, logger, ...deps() })
    ).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ checks: { dep: "fail" }, status: "fail" });
  });

  it("returns 404 for an unknown path", async () => {
    const res = await request(
      createApp({ checks: [], docs: false, logger, ...deps() })
    ).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("not-found");
  });

  it("returns 404 for an unknown path even with a malformed JSON body", async () => {
    const res = await request(
      createApp({ checks: [], docs: false, logger, ...deps() })
    )
      .post("/nope")
      .set("content-type", "application/json")
      .send("{");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
  });

  it("serves the OpenAPI document when docs are enabled", async () => {
    const res = await request(
      createApp({ checks: [], docs: true, logger, ...deps() })
    ).get("/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe("auth service");
    expect(res.body.components.securitySchemes).toHaveProperty("bearerAuth");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        "/auth/login",
        "/auth/register",
        "/health/live",
        "/health/ready",
      ])
    );
    expect(Object.keys(res.body.paths["/auth/login"].post.responses)).toEqual(
      expect.arrayContaining(["401", "429"])
    );
  });

  it("documents success responses inside the envelope", async () => {
    const res = await request(
      createApp({ checks: [], docs: true, logger, ...deps() })
    ).get("/docs/openapi.json");
    const schemaOf = (path: string, status: string) =>
      res.body.paths[path].post.responses[status].content["application/json"]
        .schema;
    expect(schemaOf("/auth/register", "201")).toEqual({
      $ref: "#/components/schemas/UserResponse",
    });
    expect(schemaOf("/auth/login", "200")).toEqual({
      $ref: "#/components/schemas/AccessTokenResponse",
    });
    expect(res.body.components.schemas.UserResponse.properties.data).toEqual({
      $ref: "#/components/schemas/User",
    });
  });

  it("serves Swagger UI when docs are enabled", async () => {
    const res = await request(
      createApp({ checks: [], docs: true, logger, ...deps() })
    ).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(HTML);
  });

  it.each(["/docs/", "/docs/openapi.json"])(
    "returns 404 for %s when docs are disabled",
    async (path) => {
      const res = await request(
        createApp({ checks: [], docs: false, logger, ...deps() })
      ).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("not-found");
    }
  );

  it.each(["/health/live", "/nope"])(
    "sends security and CORS headers on %s",
    async (path) => {
      const res = await request(
        createApp({ checks: [], docs: false, logger, ...deps() })
      ).get(path);
      expect(res.headers["content-security-policy"]).toEqual(
        expect.any(String)
      );
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers).not.toHaveProperty("x-powered-by");
    }
  );
});
