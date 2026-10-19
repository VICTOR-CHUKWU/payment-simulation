import {
  baseConfigSchema,
  jwtConfigSchema,
  resolveJwtSecret,
  storageConfigSchema,
} from "@payment-be/shared";
import { z } from "zod";

export const notificationConfigSchema = baseConfigSchema
  .extend(storageConfigSchema.shape)
  .extend(jwtConfigSchema.shape)
  .extend({
    NOTIFICATION_PORT: z.coerce.number().int().min(1).max(65_535).default(3003),
    SMTP_FROM: z
      .string()
      .min(1)
      .default("Payment Simulation <no-reply@payment-simulation.local>"),
    SMTP_HOST: z.string().min(1).default("localhost"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  })
  .transform((config, ctx) => ({
    ...config,
    JWT_SECRET: resolveJwtSecret(config, ctx),
  }));
