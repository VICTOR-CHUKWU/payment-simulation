import { baseConfigSchema, loadConfig, onShutdown } from "@payment-be/shared";
import { z } from "zod";
import { createApp } from "./app.js";

const config = loadConfig(
  baseConfigSchema.extend({
    AUTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  })
);

const server = createApp({ checks: [] }).listen(config.AUTH_PORT);
onShutdown({ server });
