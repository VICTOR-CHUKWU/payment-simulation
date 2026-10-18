import {
  baseConfigSchema,
  connectNats,
  drainNats,
  loadConfig,
  natsCheck,
  onShutdown,
} from "@payment-be/shared";
import { z } from "zod";
import { createApp } from "./app.js";

const config = loadConfig(
  baseConfigSchema.extend({
    NOTIFICATION_PORT: z.coerce.number().int().min(1).max(65_535).default(3003),
  })
);

const nc = await connectNats({ name: "notification", url: config.NATS_URL });

const server = createApp({ checks: [natsCheck(nc)] }).listen(
  config.NOTIFICATION_PORT
);
onShutdown({ server, tasks: [() => drainNats(nc)] });
