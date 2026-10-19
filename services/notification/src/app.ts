import {
  corsPolicy,
  docsRouter,
  errorHandler,
  healthRouter,
  httpLogger,
  type Logger,
  notFoundHandler,
  type ReadinessCheck,
  type Repository,
  securityHeaders,
} from "@payment-be/shared";
import express, { type Express } from "express";
import {
  createDlqController,
  type DlqService,
  dlqRouter,
} from "./dlq/index.js";
import {
  createNotificationController,
  createNotificationService,
  type Notification,
  notificationRouter,
} from "./notification/index.js";
import { buildDocument } from "./openapi.js";

export function createApp({
  checks,
  dlq,
  docs,
  jwtSecret,
  logger,
  notifications,
}: {
  checks: ReadinessCheck[];
  dlq: DlqService;
  docs: boolean;
  jwtSecret: string;
  logger: Logger;
  notifications: Repository<Notification>;
}): Express {
  const app = express();
  app.use(httpLogger(logger));
  app.use(securityHeaders());
  app.use(corsPolicy());
  app.use(healthRouter(checks));
  if (docs) {
    app.use(docsRouter(buildDocument()));
  }
  app.use(
    notificationRouter(
      createNotificationController(createNotificationService(notifications)),
      jwtSecret
    )
  );
  app.use(dlqRouter(createDlqController(dlq), jwtSecret));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
