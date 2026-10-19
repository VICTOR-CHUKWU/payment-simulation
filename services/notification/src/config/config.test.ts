import {
  baseConfigSchema,
  jwtConfigSchema,
  loadConfig,
  resolveJwtSecret,
} from "@payment-be/shared";
import { notificationConfigSchema } from "./config.js";

const JWT_SECRET_NAMED = /JWT_SECRET/;
const SMTP_PORT_NAMED = /SMTP_PORT/;

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

  it("applies the SMTP defaults", () => {
    expect(load({ NODE_ENV: "development" })).toMatchObject({
      SMTP_FROM: "Payment Simulation <no-reply@payment-simulation.local>",
      SMTP_HOST: "localhost",
      SMTP_PORT: 1025,
    });
  });

  it.each(["0", "70000", "abc"])(
    "rejects SMTP_PORT=%s and names it",
    (port) => {
      expect(() => load({ NODE_ENV: "development", SMTP_PORT: port })).toThrow(
        SMTP_PORT_NAMED
      );
    }
  );

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
