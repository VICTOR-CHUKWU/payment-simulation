import {
  baseConfigSchema,
  jwtConfigSchema,
  loadConfig,
  resolveJwtSecret,
} from "@payment-be/shared";
import { paymentConfigSchema } from "./config.js";

const JWT_SECRET_NAMED = /JWT_SECRET/;
const STORAGE_DRIVER_NAMED = /STORAGE_DRIVER/;
const FAILURE_RATE_NAMED = /GATEWAY_FAILURE_RATE/;
const MAX_DELAY_NAMED = /GATEWAY_MAX_DELAY_MS/;
const TIMEOUT_NAMED = /GATEWAY_TIMEOUT_MS/;
const CONCURRENCY_NAMED = /PROCESSOR_CONCURRENCY/;
const RELAY_INTERVAL_NAMED = /OUTBOX_RELAY_INTERVAL_MS/;

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

  it("applies the processor and gateway defaults", () => {
    expect(load({})).toMatchObject({
      GATEWAY_FAILURE_RATE: 0.2,
      GATEWAY_MAX_DELAY_MS: 5000,
      GATEWAY_MIN_DELAY_MS: 1000,
      GATEWAY_TIMEOUT_MS: 10_000,
      GATEWAY_TIMEOUT_RATE: 0.05,
      PROCESSOR_CONCURRENCY: 5,
      PROCESSOR_POLL_INTERVAL_MS: 1000,
    });
  });

  it("defaults the outbox relay interval to 1000 ms and coerces it", () => {
    expect(load({}).OUTBOX_RELAY_INTERVAL_MS).toBe(1000);
    expect(
      load({ OUTBOX_RELAY_INTERVAL_MS: "10" }).OUTBOX_RELAY_INTERVAL_MS
    ).toBe(10);
  });

  it.each(["9", "1.5", "abc"])(
    "rejects an outbox relay interval of %s and names it",
    (value) => {
      expect(() => load({ OUTBOX_RELAY_INTERVAL_MS: value })).toThrow(
        RELAY_INTERVAL_NAMED
      );
    }
  );

  it("coerces processor and gateway values from strings", () => {
    expect(
      load({
        GATEWAY_FAILURE_RATE: "0.5",
        GATEWAY_MAX_DELAY_MS: "200",
        GATEWAY_MIN_DELAY_MS: "100",
        GATEWAY_TIMEOUT_MS: "300",
        GATEWAY_TIMEOUT_RATE: "1",
        PROCESSOR_CONCURRENCY: "2",
        PROCESSOR_POLL_INTERVAL_MS: "50",
      })
    ).toMatchObject({
      GATEWAY_FAILURE_RATE: 0.5,
      GATEWAY_MAX_DELAY_MS: 200,
      GATEWAY_MIN_DELAY_MS: 100,
      GATEWAY_TIMEOUT_MS: 300,
      GATEWAY_TIMEOUT_RATE: 1,
      PROCESSOR_CONCURRENCY: 2,
      PROCESSOR_POLL_INTERVAL_MS: 50,
    });
  });

  it.each(["-0.1", "1.5", "abc"])(
    "rejects a failure rate of %s and names it",
    (value) => {
      expect(() => load({ GATEWAY_FAILURE_RATE: value })).toThrow(
        FAILURE_RATE_NAMED
      );
    }
  );

  it("rejects a concurrency below 1 and names it", () => {
    expect(() => load({ PROCESSOR_CONCURRENCY: "0" })).toThrow(
      CONCURRENCY_NAMED
    );
  });

  it("rejects a minimum delay above the maximum and names the maximum", () => {
    expect(() =>
      load({ GATEWAY_MAX_DELAY_MS: "100", GATEWAY_MIN_DELAY_MS: "200" })
    ).toThrow(MAX_DELAY_NAMED);
  });

  it.each(["5000", "4000"])(
    "rejects a timeout of %s that is not above the maximum delay",
    (value) => {
      expect(() => load({ GATEWAY_TIMEOUT_MS: value })).toThrow(TIMEOUT_NAMED);
    }
  );
});
