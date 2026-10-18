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
  authRouter,
  createAuthController,
  createAuthService,
  createLoginLimiter,
  type LoginRateLimit,
} from "./auth/index.js";
import { buildDocument } from "./openapi.js";
import { createUserService, type User } from "./user/index.js";

export function createApp({
  checks,
  docs,
  jwtSecret,
  logger,
  loginRateLimit,
  users,
}: {
  checks: ReadinessCheck[];
  docs: boolean;
  jwtSecret: string;
  logger: Logger;
  loginRateLimit: LoginRateLimit;
  users: Repository<User>;
}): Express {
  const authService = createAuthService({
    jwtSecret,
    userService: createUserService(users),
  });
  const app = express();
  app.use(httpLogger(logger));
  app.use(securityHeaders());
  app.use(corsPolicy());
  app.use(healthRouter(checks));
  if (docs) {
    app.use(docsRouter(buildDocument()));
  }
  app.use("/auth", express.json({ limit: "16kb" }));
  app.use(
    authRouter(
      createAuthController(authService),
      createLoginLimiter({ ...loginRateLimit, logger })
    )
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
