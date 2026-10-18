import {
  healthRouter,
  httpLogger,
  type Logger,
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
  return app;
}
