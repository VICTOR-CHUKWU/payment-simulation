import {
  baseConfigSchema,
  jwtConfigSchema,
  loadConfig,
  resolveJwtSecret,
} from "@payment-be/shared";
import { paymentConfigSchema } from "./config.js";

const JWT_SECRET_NAMED = /JWT_SECRET/;

const load = (env: Record<string, string>) =>
  loadConfig(paymentConfigSchema, env);

const sharedDevSecret = () =>
  loadConfig(
    baseConfigSchema
      .extend(jwtConfigSchema.shape)
      .transform((config, ctx) => resolveJwtSecret(config, ctx)),
    { NODE_ENV: "development" }
  );

describe("paymentConfigSchema", () => {
  it("applies defaults outside production", () => {
    expect(load({ NODE_ENV: "development" })).toMatchObject({
      JWT_SECRET: sharedDevSecret(),
      PAYMENT_PORT: 3002,
    });
  });

  it("requires JWT_SECRET in production and names it", () => {
    expect(() => load({ NODE_ENV: "production" })).toThrow(JWT_SECRET_NAMED);
  });

  it("accepts production with JWT_SECRET", () => {
    const secret = "s".repeat(32);
    expect(load({ JWT_SECRET: secret, NODE_ENV: "production" })).toMatchObject({
      JWT_SECRET: secret,
    });
  });
});
