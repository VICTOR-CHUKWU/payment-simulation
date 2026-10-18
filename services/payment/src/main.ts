import {
  connectNats,
  createLogger,
  drainNats,
  listen,
  loadConfig,
  natsCheck,
  onShutdown,
  openRepository,
} from "@payment-be/shared";
import { createApp } from "./app.js";
import { paymentConfigSchema } from "./config/index.js";
import { paymentSchema } from "./payment/index.js";

const config = loadConfig(paymentConfigSchema);

const docs = config.NODE_ENV === "development";

const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
  service: "payment",
});

try {
  const nc = await connectNats({ name: "payment", url: config.NATS_URL });
  const { check, close, repository } = await openRepository({
    config,
    logger,
    name: "payments",
    schema: paymentSchema,
  });
  const server = await listen(
    createApp({
      checks: [natsCheck(nc), check],
      docs,
      jwtSecret: config.JWT_SECRET,
      logger,
      payments: repository,
    }),
    config.PAYMENT_PORT
  );
  logger.info(
    { port: config.PAYMENT_PORT, ...(docs ? { docs: "/docs" } : {}) },
    "listening"
  );
  onShutdown({ logger, server, tasks: [() => drainNats(nc), close] });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
