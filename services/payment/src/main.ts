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
    PAYMENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  })
);

const nc = await connectNats({ name: "payment", url: config.NATS_URL });

const server = createApp({ checks: [natsCheck(nc)] }).listen(
  config.PAYMENT_PORT
);
onShutdown({ server, tasks: [() => drainNats(nc)] });
