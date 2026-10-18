import {
  baseConfigSchema,
  jwtConfigSchema,
  resolveJwtSecret,
} from "@payment-be/shared";
import { z } from "zod";

export const paymentConfigSchema = baseConfigSchema
  .extend(jwtConfigSchema.shape)
  .extend({
    PAYMENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  })
  .transform((config, ctx) => ({
    ...config,
    JWT_SECRET: resolveJwtSecret(config, ctx),
  }));
