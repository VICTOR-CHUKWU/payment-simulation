import {
  baseConfigSchema,
  jwtConfigSchema,
  loadConfig,
  resolveJwtSecret,
} from "@payment-be/shared";
import { paymentConfigSchema } from "./config.js";

const JWT_SECRET_NAMED = /JWT_SECRET/;
const STORAGE_DRIVER_NAMED = /STORAGE_DRIVER/;

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
      DATA_DIR: "data",
      JWT_SECRET: sharedDevSecret(),
      PAYMENT_PORT: 3002,
      STORAGE_DRIVER: "file",
    });
  });

  it("accepts the memory storage driver", () => {
    expect(load({ STORAGE_DRIVER: "memory" }).STORAGE_DRIVER).toBe("memory");
  });

  it("rejects an unknown storage driver", () => {
    expect(() => load({ STORAGE_DRIVER: "redis" })).toThrow(
      STORAGE_DRIVER_NAMED
    );
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
