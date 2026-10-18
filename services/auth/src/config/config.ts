import {
  baseConfigSchema,
  jwtConfigSchema,
  resolveJwtSecret,
  storageConfigSchema,
} from "@payment-be/shared";
import { z } from "zod";
import { passwordSchema } from "../core/index.js";
import { normalizeEmail } from "../user/index.js";

const SEED_PASSWORD_KEYS = [
  "SEED_ADMIN_PASSWORD",
  "SEED_USER_PASSWORD",
] as const;

const seedPassword = passwordSchema.optional();

export const authConfigSchema = baseConfigSchema
  .extend(storageConfigSchema.shape)
  .extend(jwtConfigSchema.shape)
  .extend({
    AUTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(2_147_483_647)
      .default(900_000),
    SEED_ADMIN_EMAIL: z.email().default("admin@example.com"),
    SEED_ADMIN_PASSWORD: seedPassword,
    SEED_USER_EMAIL: z.email().default("user@example.com"),
    SEED_USER_PASSWORD: seedPassword,
  })
  .transform((config, ctx) => {
    if (config.NODE_ENV === "production") {
      for (const key of SEED_PASSWORD_KEYS) {
        if (config[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "Required in production",
            path: [key],
          });
        }
      }
    }
    if (
      normalizeEmail(config.SEED_ADMIN_EMAIL) ===
      normalizeEmail(config.SEED_USER_EMAIL)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Must differ from SEED_ADMIN_EMAIL",
        path: ["SEED_USER_EMAIL"],
      });
    }
    return {
      ...config,
      JWT_SECRET: resolveJwtSecret(config, ctx),
      SEED_ADMIN_PASSWORD: config.SEED_ADMIN_PASSWORD ?? "Admin123!",
      SEED_USER_PASSWORD: config.SEED_USER_PASSWORD ?? "User123!",
    };
  });
