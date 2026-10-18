import {
  docsRouter,
  errorHandler,
  healthRouter,
  httpLogger,
  type Logger,
  notFoundHandler,
  type ReadinessCheck,
} from "@payment-be/shared";
import express, { type Express } from "express";
import { buildDocument } from "./openapi.js";

export function createApp({
  checks,
  docs,
  logger,
}: {
  checks: ReadinessCheck[];
  docs: boolean;
  logger: Logger;
}): Express {
  const app = express();
  app.use(httpLogger(logger));
  app.use(healthRouter(checks));
  if (docs) {
    app.use(docsRouter(buildDocument()));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
