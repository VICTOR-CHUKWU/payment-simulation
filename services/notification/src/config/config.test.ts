import {
  baseConfigSchema,
  jwtConfigSchema,
  loadConfig,
  resolveJwtSecret,
} from "@payment-be/shared";
import { notificationConfigSchema } from "./config.js";

const JWT_SECRET_NAMED = /JWT_SECRET/;

const load = (env: Record<string, string>) =>
  loadConfig(notificationConfigSchema, env);

const sharedDevSecret = () =>
  loadConfig(
    baseConfigSchema
      .extend(jwtConfigSchema.shape)
      .transform((config, ctx) => resolveJwtSecret(config, ctx)),
    { NODE_ENV: "development" }
  );

describe("notificationConfigSchema", () => {
  it("applies defaults outside production", () => {
    expect(load({ NODE_ENV: "development" })).toMatchObject({
      JWT_SECRET: sharedDevSecret(),
      NOTIFICATION_PORT: 3003,
    });
  });

  it("applies the storage defaults", () => {
    expect(load({ NODE_ENV: "development" })).toMatchObject({
      DATA_DIR: "data",
      STORAGE_DRIVER: "file",
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
