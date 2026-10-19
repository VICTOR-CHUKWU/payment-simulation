import {
  connectNats,
  createLogger,
  drainNats,
  ensureStream,
  jetstream,
  jetstreamManager,
  listen,
  loadConfig,
  natsCheck,
  onShutdown,
  openRepository,
  PAYMENTS_STREAM,
} from "@payment-be/shared";
import { createApp } from "./app.js";
import { paymentConfigSchema } from "./config/index.js";
import { createOutboxRelay } from "./outbox/index.js";
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
  const stream = await ensureStream(
    await jetstreamManager(nc),
    PAYMENTS_STREAM
  );
  logger.info({ result: stream, stream: PAYMENTS_STREAM.name }, "stream ready");
  const { check, close, repository } = await openRepository({
    config,
    logger,
    name: "payments",
    schema: paymentSchema,
  });
  const relay = createOutboxRelay({
    intervalMs: config.OUTBOX_RELAY_INTERVAL_MS,
    js: jetstream(nc),
    logger,
    payments: repository,
  });
  const server = await listen(
    createApp({
      checks: [natsCheck(nc), check],
      docs,
      jwtSecret: config.JWT_SECRET,
      logger,
      onOutbox: relay.kick,
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
    onOutbox: relay.kick,
    payments: repository,
    pollIntervalMs: config.PROCESSOR_POLL_INTERVAL_MS,
    timeoutMs: config.GATEWAY_TIMEOUT_MS,
  });
  relay.start();
  processor.start();
  onShutdown({
    logger,
    server,
    tasks: [processor.stop, relay.stop, () => drainNats(nc), close],
  });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
