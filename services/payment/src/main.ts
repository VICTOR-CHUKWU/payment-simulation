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
import {
  createPaymentProcessor,
  createSimulatedGateway,
} from "./processor/index.js";

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
  const processor = createPaymentProcessor({
    concurrency: config.PROCESSOR_CONCURRENCY,
    gateway: createSimulatedGateway({
      failureRate: config.GATEWAY_FAILURE_RATE,
      maxDelayMs: config.GATEWAY_MAX_DELAY_MS,
      minDelayMs: config.GATEWAY_MIN_DELAY_MS,
      timeoutRate: config.GATEWAY_TIMEOUT_RATE,
    }),
    logger,
    payments: repository,
    pollIntervalMs: config.PROCESSOR_POLL_INTERVAL_MS,
    timeoutMs: config.GATEWAY_TIMEOUT_MS,
  });
  processor.start();
  onShutdown({
    logger,
    server,
    tasks: [processor.stop, () => drainNats(nc), close],
  });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
