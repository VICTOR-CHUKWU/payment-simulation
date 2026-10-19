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

  it("keeps internal outbox fields out of the Payment schema", async () => {
    const res = await request(app({ docs: true })).get("/docs/openapi.json");
    const { properties } = res.body.components.schemas.Payment;
    expect(properties).not.toHaveProperty("outbox");
    expect(properties).not.toHaveProperty("correlationId");
    expect(properties).not.toHaveProperty("idempotencyKey");
    expect(properties).not.toHaveProperty("version");
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

  it("documents GET /payments/{id} with bearer auth and its errors", async () => {
    const res = await request(app({ docs: true })).get("/docs/openapi.json");
    const operation = res.body.paths["/payments/{id}"].get;
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "404",
    ]);
    expect(operation.parameters).toEqual([
      expect.objectContaining({ in: "path", name: "id", required: true }),
    ]);
  });

  it("documents PATCH /payments/{id}/status as admin-only with its errors", async () => {
    const res = await request(app({ docs: true })).get("/docs/openapi.json");
    const operation = res.body.paths["/payments/{id}/status"].patch;
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "413",
      "415",
    ]);
    expect(operation.parameters).toEqual([
      expect.objectContaining({ in: "path", name: "id", required: true }),
    ]);
    expect(operation.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/UpdatePaymentStatusRequest" },
        },
      },
      required: true,
    });
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/PaymentResponse" });
    expect(
      res.body.components.schemas.UpdatePaymentStatusRequest.properties.status
        .enum
    ).toEqual(["cancelled", "succeeded", "failed"]);
  });

  it("documents payment success responses inside the envelope", async () => {
    const res = await request(app({ docs: true })).get("/docs/openapi.json");
    const ref = { $ref: "#/components/schemas/PaymentResponse" };
    const post = res.body.paths["/payments"].post.responses;
    const get = res.body.paths["/payments/{id}"].get.responses;
    for (const response of [post["200"], post["201"], get["200"]]) {
      expect(response.content["application/json"].schema).toEqual(ref);
    }
    expect(res.body.components.schemas.PaymentResponse).toMatchObject({
      properties: {
        data: { $ref: "#/components/schemas/Payment" },
        success: { enum: [true] },
      },
    });
    expect(post["401"].content["application/problem+json"].example.status).toBe(
      401
    );
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
