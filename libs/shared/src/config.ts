import { z } from "zod";

export const baseConfigSchema = z.object({
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NATS_URL: z.url().default("nats://localhost:4222"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export function loadConfig<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration\n${z.prettifyError(result.error)}`
    );
  }
  return result.data;
}
