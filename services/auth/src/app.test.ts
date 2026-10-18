import { createLogger, type ReadinessCheck } from "@payment-be/shared";
import request from "supertest";
import { createApp } from "./app.js";

const HTML = /^text\/html/;
const PROBLEM_JSON = /^application\/problem\+json/;

const logger = createLogger({
  level: "silent",
  pretty: false,
  service: "test",
});

const check = (ok: boolean): ReadinessCheck => ({
  check: () => ok,
  name: "dep",
});

describe("auth app", () => {
  it("reports live", async () => {
    const res = await request(
      createApp({ checks: [], docs: false, logger })
    ).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("sets an x-request-id on responses", async () => {
    const res = await request(
      createApp({ checks: [], docs: false, logger })
    ).get("/health/live");
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("is ready when checks pass", async () => {
    const res = await request(
      createApp({ checks: [check(true)], docs: false, logger })
    ).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checks: { dep: "ok" }, status: "ok" });
  });

  it("is not ready when a check fails", async () => {
    const res = await request(
      createApp({ checks: [check(false)], docs: false, logger })
    ).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ checks: { dep: "fail" }, status: "fail" });
  });

  it("returns 404 for an unknown path", async () => {
    const res = await request(
      createApp({ checks: [], docs: false, logger })
    ).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("not-found");
  });

  it("serves the OpenAPI document when docs are enabled", async () => {
    const res = await request(
      createApp({ checks: [], docs: true, logger })
    ).get("/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe("auth service");
    expect(res.body.components.securitySchemes).toHaveProperty("bearerAuth");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/health/live", "/health/ready"])
    );
  });

  it("serves Swagger UI when docs are enabled", async () => {
    const res = await request(
      createApp({ checks: [], docs: true, logger })
    ).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(HTML);
  });

  it.each(["/docs/", "/docs/openapi.json"])(
    "returns 404 for %s when docs are disabled",
    async (path) => {
      const res = await request(
        createApp({ checks: [], docs: false, logger })
      ).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("not-found");
    }
  );
});
