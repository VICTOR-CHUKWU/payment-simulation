import {
  baseConfigSchema,
  jwtConfigSchema,
  resolveJwtSecret,
  storageConfigSchema,
} from "@payment-be/shared";
import { z } from "zod";

const milliseconds = (min: number, fallback: number) =>
  z.coerce.number().int().min(min).default(fallback);

const rate = (fallback: number) =>
  z.coerce.number().min(0).max(1).default(fallback);

export const paymentConfigSchema = baseConfigSchema
  .extend(storageConfigSchema.shape)
  .extend(jwtConfigSchema.shape)
  .extend({
    GATEWAY_FAILURE_RATE: rate(0.2),
    GATEWAY_MAX_DELAY_MS: milliseconds(0, 5000),
    GATEWAY_MIN_DELAY_MS: milliseconds(0, 1000),
    GATEWAY_TIMEOUT_MS: milliseconds(1, 10_000),
    GATEWAY_TIMEOUT_RATE: rate(0.05),
    OUTBOX_RELAY_INTERVAL_MS: milliseconds(10, 1000),
    PAYMENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
    PROCESSOR_CONCURRENCY: z.coerce.number().int().min(1).default(5),
    PROCESSOR_POLL_INTERVAL_MS: milliseconds(10, 1000),
  })
  .superRefine((config, ctx) => {
    if (config.GATEWAY_MIN_DELAY_MS > config.GATEWAY_MAX_DELAY_MS) {
      ctx.addIssue({
        code: "custom",
        message: "Must be at least GATEWAY_MIN_DELAY_MS",
        path: ["GATEWAY_MAX_DELAY_MS"],
      });
    }
    if (config.GATEWAY_TIMEOUT_MS <= config.GATEWAY_MAX_DELAY_MS) {
      ctx.addIssue({
        code: "custom",
        message: "Must be greater than GATEWAY_MAX_DELAY_MS",
        path: ["GATEWAY_TIMEOUT_MS"],
      });
    }
  })
  .transform((config, ctx) => ({
    ...config,
    JWT_SECRET: resolveJwtSecret(config, ctx),
  }));
