import {
  connectNats,
  createLogger,
  DLQ_STREAM,
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
import { createDeadLetterPublisher, createDlqService } from "./dlq/index.js";
import {
  createEmailChannel,
  createEmailService,
  createMailer,
} from "./email/index.js";
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
  const mailer = createMailer({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
  });
  const emailService = createEmailService({
    from: config.SMTP_FROM,
    mailer,
  });
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
  for (const definition of [PAYMENTS_STREAM, DLQ_STREAM]) {
    // biome-ignore lint/performance/noAwaitInLoops: one log line per stream, in order
    const result = await ensureStream(jsm, definition);
    logger.info({ result, stream: definition.name }, "stream ready");
  }
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
  const emailChannel = createEmailChannel({
    deadLetter: createDeadLetterPublisher(js),
    delays: config.EMAIL_RETRY_DELAYS_MS,
    emailService,
    maxAttempts: config.EMAIL_MAX_ATTEMPTS,
  });
  const consumers = await Promise.all(
    CHANNELS.map((channel) =>
      startConsumer({
        durable: CHANNEL_CONSUMERS[channel].durable_name,
        handle: createEventHandler({
          channel,
          inbox: inbox.repository,
          logger,
          onEvent:
            channel === "inapp"
              ? (event) => service.record(event)
              : emailChannel.onEvent,
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
      dlq: createDlqService({ emailService, jsm }),
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
      mailer.close,
    ],
  });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
