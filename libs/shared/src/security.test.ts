import express from "express";
import request from "supertest";
import { corsPolicy, securityHeaders } from "./security.js";

const app = express();
app.use(securityHeaders());
app.use(corsPolicy());
app.get("/thing", (_req, res) => {
  res.json({ ok: true });
});

describe("securityHeaders", () => {
  it("sets helmet's headers and removes x-powered-by", async () => {
    const res = await request(app).get("/thing");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toEqual(expect.any(String));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers).not.toHaveProperty("x-powered-by");
  });
});

describe("corsPolicy", () => {
  it("allows any origin without credentials and exposes the client headers", async () => {
    const res = await request(app)
      .get("/thing")
      .set("origin", "https://example.test");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-expose-headers"]).toBe(
      "x-request-id,retry-after,ratelimit,ratelimit-policy,www-authenticate"
    );
    expect(res.headers).not.toHaveProperty("access-control-allow-credentials");
  });

  it("answers a preflight with 204", async () => {
    const res = await request(app)
      .options("/thing")
      .set("origin", "https://example.test")
      .set("access-control-request-method", "PATCH");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
  });
});
