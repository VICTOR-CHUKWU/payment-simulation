import {
  createLogger,
  listen,
  loadConfig,
  onShutdown,
  openRepository,
} from "@payment-be/shared";
import { createApp } from "./app.js";
import { authConfigSchema } from "./config/index.js";
import { seedUsers } from "./seed/index.js";
import { userSchema } from "./user/index.js";

const config = loadConfig(authConfigSchema);

const docs = config.NODE_ENV === "development";

const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
  service: "auth",
});

try {
  const { check, close, repository } = await openRepository({
    config,
    logger,
    name: "users",
    schema: userSchema,
  });
  await seedUsers({
    accounts: [
      {
        email: config.SEED_ADMIN_EMAIL,
        password: config.SEED_ADMIN_PASSWORD,
        role: "admin",
      },
      {
        email: config.SEED_USER_EMAIL,
        password: config.SEED_USER_PASSWORD,
        role: "user",
      },
    ],
    logger,
    users: repository,
  });
  const server = await listen(
    createApp({ checks: [check], docs, logger }),
    config.AUTH_PORT
  );
  logger.info(
    { port: config.AUTH_PORT, ...(docs ? { docs: "/docs" } : {}) },
    "listening"
  );
  onShutdown({ logger, server, tasks: [close] });
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}
