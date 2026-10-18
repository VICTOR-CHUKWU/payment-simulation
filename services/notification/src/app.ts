import {
  errorHandler,
  healthRouter,
  httpLogger,
  type Logger,
  notFoundHandler,
  type ReadinessCheck,
} from "@payment-be/shared";
import express, { type Express } from "express";

export function createApp({
  checks,
  logger,
}: {
  checks: ReadinessCheck[];
  logger: Logger;
}): Express {
  const app = express();
  app.use(httpLogger(logger));
  app.use(healthRouter(checks));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
