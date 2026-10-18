import {
  createLogger,
  createMemoryRepository,
  type ReadinessCheck,
} from "@payment-be/shared";
import request from "supertest";
import { createApp } from "./app.js";
import type { Payment } from "./payment/index.js";

const HTML = /^text\/html/;
const PROBLEM_JSON = /^application\/problem\+json/;

const logger = createLogger({
  level: "silent",
  pretty: false,
  service: "test",
});

const app = ({
  checks = [],
  docs = false,
}: {
  checks?: ReadinessCheck[];
  docs?: boolean;
} = {}) =>
  createApp({
    checks,
    docs,
    jwtSecret: "s".repeat(32),
    logger,
    payments: createMemoryRepository<Payment>(),
  });

const check = (ok: boolean): ReadinessCheck => ({
  check: () => ok,
  name: "dep",
});

describe("payment app", () => {
  it("reports live", async () => {
    const res = await request(app()).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("sets an x-request-id on responses", async () => {
    const res = await request(app()).get("/health/live");
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("is ready when checks pass", async () => {
    const res = await request(app({ checks: [check(true)] })).get(
      "/health/ready"
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checks: { dep: "ok" }, status: "ok" });
  });

  it("is not ready when a check fails", async () => {
    const res = await request(app({ checks: [check(false)] })).get(
      "/health/ready"
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ checks: { dep: "fail" }, status: "fail" });
  });

  it("returns 404 for an unknown path", async () => {
    const res = await request(app()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("not-found");
  });

  it("serves the OpenAPI document when docs are enabled", async () => {
    const res = await request(app({ docs: true })).get("/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe("payment service");
    expect(res.body.components.securitySchemes).toHaveProperty("bearerAuth");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/health/live", "/health/ready", "/payments"])
    );
  });

  it("documents POST /payments with bearer auth and its errors", async () => {
    const res = await request(app({ docs: true })).get("/docs/openapi.json");
    const operation = res.body.paths["/payments"].post;
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      "200",
      "201",
      "400",
      "401",
      "413",
      "415",
      "422",
    ]);
    expect(operation.parameters).toEqual([
      expect.objectContaining({
        in: "header",
        name: "Idempotency-Key",
        required: false,
      }),
    ]);
  });

  it("serves Swagger UI when docs are enabled", async () => {
    const res = await request(app({ docs: true })).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(HTML);
  });

  it.each(["/docs/", "/docs/openapi.json"])(
    "returns 404 for %s when docs are disabled",
    async (path) => {
      const res = await request(app()).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("not-found");
    }
  );

  it.each(["/health/live", "/nope"])(
    "sends security and CORS headers on %s",
    async (path) => {
      const res = await request(app()).get(path);
      expect(res.headers["content-security-policy"]).toEqual(
        expect.any(String)
      );
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers).not.toHaveProperty("x-powered-by");
    }
  );
});
