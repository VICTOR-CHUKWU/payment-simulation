import {
  baseConfigSchema,
  connectNats,
  createLogger,
  drainNats,
  listen,
  loadConfig,
  natsCheck,
  onShutdown,
} from "@payment-be/shared";
import { z } from "zod";
import { createApp } from "./app.js";

const config = loadConfig(
  baseConfigSchema.extend({
    PAYMENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  })
);

const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
  service: "payment",
});

try {
  const nc = await connectNats({ name: "payment", url: config.NATS_URL });
  const server = await listen(
    createApp({ checks: [natsCheck(nc)], logger }),
    config.PAYMENT_PORT
  );
  logger.info({ port: config.PAYMENT_PORT }, "listening");
  onShutdown({ logger, server, tasks: [() => drainNats(nc)] });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
