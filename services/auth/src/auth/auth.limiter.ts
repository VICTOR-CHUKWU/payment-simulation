import { type Logger, tooManyRequests } from "@payment-be/shared";
import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";

export interface LoginRateLimit {
  max: number;
  windowMs: number;
}

export function createLoginLimiter({
  logger,
  max,
  windowMs,
}: LoginRateLimit & { logger: Logger }): RequestHandler {
  return rateLimit({
    handler: (_req, _res, next) => {
      next(tooManyRequests("Too many failed login attempts. Try again later."));
    },
    legacyHeaders: false,
    limit: max,
    logger: {
      error: (err, message) => logger.error({ err }, message),
      warn: (err, message) => logger.warn({ err }, message),
    },
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    // trust proxy is unset, so forwarding headers are ignored on purpose and the warnings would only be noise.
    validate: { forwardedHeader: false, xForwardedForHeader: false },
    windowMs,
  });
}
