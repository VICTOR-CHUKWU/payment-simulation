import type { ReadinessCheck } from "@payment-be/shared";
import request from "supertest";
import { createApp } from "./app.js";

const check = (ok: boolean): ReadinessCheck => ({
  check: () => ok,
  name: "dep",
});

describe("payment app", () => {
  it("reports live", async () => {
    const res = await request(createApp({ checks: [] })).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("is ready when checks pass", async () => {
    const res = await request(createApp({ checks: [check(true)] })).get(
      "/health/ready"
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checks: { dep: "ok" }, status: "ok" });
  });

  it("is not ready when a check fails", async () => {
    const res = await request(createApp({ checks: [check(false)] })).get(
      "/health/ready"
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ checks: { dep: "fail" }, status: "fail" });
  });

  it("returns 404 for an unknown path", async () => {
    const res = await request(createApp({ checks: [] })).get("/nope");
    expect(res.status).toBe(404);
  });
});
