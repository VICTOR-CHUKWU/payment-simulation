import {
  connectNats,
  createLogger,
  drainNats,
  listen,
  loadConfig,
  natsCheck,
  onShutdown,
} from "@payment-be/shared";
import { createApp } from "./app.js";
import { notificationConfigSchema } from "./config/index.js";

const config = loadConfig(notificationConfigSchema);

const docs = config.NODE_ENV === "development";

const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
  service: "notification",
});

try {
  const nc = await connectNats({ name: "notification", url: config.NATS_URL });
  const server = await listen(
    createApp({ checks: [natsCheck(nc)], docs, logger }),
    config.NOTIFICATION_PORT
  );
  logger.info(
    { port: config.NOTIFICATION_PORT, ...(docs ? { docs: "/docs" } : {}) },
    "listening"
  );
  onShutdown({ logger, server, tasks: [() => drainNats(nc)] });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
