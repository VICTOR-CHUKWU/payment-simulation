import {
  baseConfigSchema,
  jwtConfigSchema,
  loadConfig,
  resolveJwtSecret,
} from "@payment-be/shared";
import { notificationConfigSchema } from "./config.js";

const JWT_SECRET_NAMED = /JWT_SECRET/;
const SMTP_PORT_NAMED = /SMTP_PORT/;
const DELAYS_NAMED = /EMAIL_RETRY_DELAYS_MS/;
const ATTEMPTS_NAMED = /EMAIL_MAX_ATTEMPTS/;

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

  it("applies the email retry defaults", () => {
    expect(load({ NODE_ENV: "development" })).toMatchObject({
      EMAIL_MAX_ATTEMPTS: 5,
      EMAIL_RETRY_DELAYS_MS: [5000, 30_000, 120_000, 600_000],
    });
  });

  it("parses a custom delay list", () => {
    expect(
      load({ EMAIL_RETRY_DELAYS_MS: "1000,2000", NODE_ENV: "development" })
        .EMAIL_RETRY_DELAYS_MS
    ).toEqual([1000, 2000]);
  });

  it.each(["5000,abc", "", "5000,-1", "1.5"])(
    "rejects EMAIL_RETRY_DELAYS_MS=%j and names it",
    (value) => {
      expect(() =>
        load({ EMAIL_RETRY_DELAYS_MS: value, NODE_ENV: "development" })
      ).toThrow(DELAYS_NAMED);
    }
  );

  it.each(["0", "21", "x"])(
    "rejects EMAIL_MAX_ATTEMPTS=%s and names it",
    (value) => {
      expect(() =>
        load({ EMAIL_MAX_ATTEMPTS: value, NODE_ENV: "development" })
      ).toThrow(ATTEMPTS_NAMED);
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
