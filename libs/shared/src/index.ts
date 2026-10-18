// biome-ignore lint/performance/noBarrelFile: package entry point
export { baseConfigSchema, loadConfig } from "./config.js";
export {
  createEvent,
  type EventEnvelope,
  eventEnvelopeSchema,
} from "./events.js";
export {
  CORRELATION_ID_HEADER,
  connectNats,
  parseEvent,
  publishEvent,
} from "./nats.js";

export const SHARED_PACKAGE_NAME = "@payment-be/shared";
