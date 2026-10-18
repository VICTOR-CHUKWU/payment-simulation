import {
  baseConfigSchema,
  createLogger,
  listen,
  loadConfig,
  onShutdown,
} from "@payment-be/shared";
import { z } from "zod";
import { createApp } from "./app.js";

const config = loadConfig(
  baseConfigSchema.extend({
    AUTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  })
);

const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
  service: "auth",
});

try {
  const server = await listen(
    createApp({ checks: [], logger }),
    config.AUTH_PORT
  );
  logger.info({ port: config.AUTH_PORT }, "listening");
  onShutdown({ logger, server });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
