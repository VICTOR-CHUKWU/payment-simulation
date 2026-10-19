import {
  connectNats,
  createLogger,
  drainNats,
  ensureConsumer,
  ensureStream,
  jetstream,
  jetstreamManager,
  listen,
  loadConfig,
  natsCheck,
  onShutdown,
  openRepository,
  PAYMENTS_STREAM,
  startConsumer,
} from "@payment-be/shared";
import { createApp } from "./app.js";
import { notificationConfigSchema } from "./config/index.js";
import {
  CHANNEL_CONSUMERS,
  CHANNELS,
  consumersCheck,
  createEventHandler,
} from "./consumer/index.js";
import { inboxRecordSchema } from "./inbox/index.js";
import {
  createNotificationService,
  notificationSchema,
} from "./notification/index.js";

const config = loadConfig(notificationConfigSchema);

const docs = config.NODE_ENV === "development";

const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
  service: "notification",
});

try {
  const nc = await connectNats({ name: "notification", url: config.NATS_URL });
  const inbox = await openRepository({
    config,
    logger,
    name: "inbox",
    schema: inboxRecordSchema,
  });
  const notifications = await openRepository({
    config,
    logger,
    name: "notifications",
    schema: notificationSchema,
  });
  const service = createNotificationService(notifications.repository);
  // openRepository names every check "storage", and readiness keys checks by name.
  const storage = {
    check: async () => {
      const results = await Promise.all([
        inbox.check.check(),
        notifications.check.check(),
      ]);
      return results.every((ok) => ok === true);
    },
    name: "storage",
  };
  const jsm = await jetstreamManager(nc);
  const stream = await ensureStream(jsm, PAYMENTS_STREAM);
  logger.info({ result: stream, stream: PAYMENTS_STREAM.name }, "stream ready");
  for (const channel of CHANNELS) {
    const consumer = CHANNEL_CONSUMERS[channel].durable_name;
    // biome-ignore lint/performance/noAwaitInLoops: one log line per consumer, in order
    const result = await ensureConsumer(
      jsm,
      PAYMENTS_STREAM.name,
      CHANNEL_CONSUMERS[channel]
    );
    logger.info({ consumer, result }, "consumer ready");
  }
  const js = jetstream(nc);
  const consumers = await Promise.all(
    CHANNELS.map((channel) =>
      startConsumer({
        durable: CHANNEL_CONSUMERS[channel].durable_name,
        handle: createEventHandler({
          channel,
          inbox: inbox.repository,
          logger,
          ...(channel === "inapp"
            ? { onEvent: (event) => service.record(event) }
            : {}),
        }),
        js,
        logger,
        stream: PAYMENTS_STREAM.name,
      })
    )
  );
  const server = await listen(
    createApp({
      checks: [natsCheck(nc), consumersCheck(consumers), storage],
      docs,
      jwtSecret: config.JWT_SECRET,
      logger,
      notifications: notifications.repository,
    }),
    config.NOTIFICATION_PORT
  );
  logger.info(
    { port: config.NOTIFICATION_PORT, ...(docs ? { docs: "/docs" } : {}) },
    "listening"
  );
  onShutdown({
    logger,
    server,
    tasks: [
      ...consumers.map((consumer) => consumer.stop),
      () => drainNats(nc),
      inbox.close,
      notifications.close,
    ],
  });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
