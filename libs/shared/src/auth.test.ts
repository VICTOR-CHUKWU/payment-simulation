import {
  accessTokenClaimsSchema,
  jwtConfigSchema,
  resolveJwtSecret,
} from "./auth.js";
import { baseConfigSchema, loadConfig } from "./config.js";

const JWT_SECRET_NAMED = /JWT_SECRET/;
const REQUIRED_IN_PRODUCTION = /Required in production/;

const schema = baseConfigSchema
  .extend(jwtConfigSchema.shape)
  .transform((config, ctx) => ({
    ...config,
    JWT_SECRET: resolveJwtSecret(config, ctx),
  }));

const load = (env: Record<string, string>) => loadConfig(schema, env);

const claims = {
  email: "ada@example.com",
  exp: 1_700_086_400,
  iat: 1_700_000_000,
  role: "user",
  sub: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
};

describe("accessTokenClaimsSchema", () => {
  it("accepts valid claims", () => {
    expect(accessTokenClaimsSchema.parse(claims)).toEqual(claims);
  });

  it.each([
    ["an unknown role", { role: "owner" }],
    ["a missing exp", { exp: undefined }],
    ["a non-uuid sub", { sub: "42" }],
  ])("rejects %s", (_label, override) => {
    expect(
      accessTokenClaimsSchema.safeParse({ ...claims, ...override }).success
    ).toBe(false);
  });
});

describe("resolveJwtSecret", () => {
  it("requires JWT_SECRET in production and names it", () => {
    expect(() => load({ NODE_ENV: "production" })).toThrow(JWT_SECRET_NAMED);
    expect(() => load({ NODE_ENV: "production" })).toThrow(
      REQUIRED_IN_PRODUCTION
    );
  });

  it("uses the given secret", () => {
    const secret = "s".repeat(32);
    expect(load({ JWT_SECRET: secret, NODE_ENV: "production" })).toMatchObject({
      JWT_SECRET: secret,
    });
  });

  it("rejects a secret under 32 characters without echoing it", () => {
    const secret = "short-secret-value";
    expect(() => load({ JWT_SECRET: secret })).toThrow(JWT_SECRET_NAMED);
    expect(() => load({ JWT_SECRET: secret })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(secret),
      })
    );
  });

  it("falls back to a dev default of at least 32 characters outside production", () => {
    const { JWT_SECRET } = load({ NODE_ENV: "development" });
    expect(JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(load({ NODE_ENV: "test" }).JWT_SECRET).toBe(JWT_SECRET);
  });
});
