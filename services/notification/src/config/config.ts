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
  })
  .transform((config, ctx) => ({
    ...config,
    JWT_SECRET: resolveJwtSecret(config, ctx),
  }));
