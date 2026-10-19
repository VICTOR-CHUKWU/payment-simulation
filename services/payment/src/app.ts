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
import { buildDocument } from "./openapi.js";
import {
  createPaymentController,
  createPaymentService,
  type Payment,
  paymentRouter,
} from "./payment/index.js";

export function createApp({
  checks,
  docs,
  jwtSecret,
  logger,
  onOutbox,
  payments,
}: {
  checks: ReadinessCheck[];
  docs: boolean;
  jwtSecret: string;
  logger: Logger;
  onOutbox?: () => void;
  payments: Repository<Payment>;
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
    paymentRouter(
      createPaymentController(createPaymentService(payments, { onOutbox })),
      jwtSecret
    )
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
