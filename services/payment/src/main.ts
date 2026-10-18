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
import { paymentConfigSchema } from "./config/index.js";

const config = loadConfig(paymentConfigSchema);

const docs = config.NODE_ENV === "development";

const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
  service: "payment",
});

try {
  const nc = await connectNats({ name: "payment", url: config.NATS_URL });
  const server = await listen(
    createApp({ checks: [natsCheck(nc)], docs, logger }),
    config.PAYMENT_PORT
  );
  logger.info(
    { port: config.PAYMENT_PORT, ...(docs ? { docs: "/docs" } : {}) },
    "listening"
  );
  onShutdown({ logger, server, tasks: [() => drainNats(nc)] });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
