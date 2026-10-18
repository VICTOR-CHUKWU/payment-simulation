import { healthRouter, type ReadinessCheck } from "@payment-be/shared";
import express, { type Express } from "express";

export function createApp({ checks }: { checks: ReadinessCheck[] }): Express {
  const app = express();
  app.use(healthRouter(checks));
  return app;
}
