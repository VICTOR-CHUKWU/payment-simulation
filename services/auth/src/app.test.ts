import { createLogger, type ReadinessCheck } from "@payment-be/shared";
import request from "supertest";
import { createApp } from "./app.js";

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
    const res = await request(createApp({ checks: [], logger })).get(
      "/health/live"
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("sets an x-request-id on responses", async () => {
    const res = await request(createApp({ checks: [], logger })).get(
      "/health/live"
    );
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("is ready when checks pass", async () => {
    const res = await request(createApp({ checks: [check(true)], logger })).get(
      "/health/ready"
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checks: { dep: "ok" }, status: "ok" });
  });

  it("is not ready when a check fails", async () => {
    const res = await request(
      createApp({ checks: [check(false)], logger })
    ).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ checks: { dep: "fail" }, status: "fail" });
  });

  it("returns 404 for an unknown path", async () => {
    const res = await request(createApp({ checks: [], logger })).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("not-found");
  });
});
