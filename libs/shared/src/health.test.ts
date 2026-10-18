import express from "express";
import request from "supertest";
import { healthRouter, natsCheck, type ReadinessCheck } from "./health.js";

function app(checks: ReadinessCheck[]) {
  return express().use(healthRouter(checks));
}

const pass = (name: string): ReadinessCheck => ({ check: () => true, name });

describe("healthRouter", () => {
  it("reports live", async () => {
    const res = await request(app([])).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("is ready with no checks", async () => {
    const res = await request(app([])).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checks: {}, status: "ok" });
  });

  it("is ready when every check passes", async () => {
    const res = await request(
      app([pass("a"), { check: () => Promise.resolve(true), name: "b" }])
    ).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checks: { a: "ok", b: "ok" }, status: "ok" });
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("boom");
      },
    ],
    ["rejects", () => Promise.reject(new Error("boom"))],
  ])("is not ready when a check %s", async (_label, check) => {
    const res = await request(app([pass("a"), { check, name: "b" }])).get(
      "/health/ready"
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      checks: { a: "ok", b: "fail" },
      status: "fail",
    });
  });
});

describe("natsCheck", () => {
  function stub(
    overrides: {
      closed?: boolean;
      draining?: boolean;
      flush?: () => Promise<void>;
    } = {}
  ) {
    return {
      flush: overrides.flush ?? (() => Promise.resolve()),
      isClosed: () => overrides.closed ?? false,
      isDraining: () => overrides.draining ?? false,
    };
  }

  it("is named nats", () => {
    expect(natsCheck(stub()).name).toBe("nats");
  });

  it("passes when open and flush resolves", async () => {
    await expect(natsCheck(stub()).check()).resolves.toBe(true);
  });

  it("fails when closed", async () => {
    await expect(natsCheck(stub({ closed: true })).check()).resolves.toBe(
      false
    );
  });

  it("fails when draining", async () => {
    await expect(natsCheck(stub({ draining: true })).check()).resolves.toBe(
      false
    );
  });

  it("fails when flush rejects", async () => {
    const nc = stub({ flush: () => Promise.reject(new Error("down")) });
    await expect(natsCheck(nc).check()).resolves.toBe(false);
  });

  it("fails when flush does not resolve in time", async () => {
    const nc = stub({ flush: () => new Promise(() => undefined) });
    await expect(natsCheck(nc, 20).check()).resolves.toBe(false);
  });
});
