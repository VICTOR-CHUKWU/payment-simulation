// biome-ignore lint/performance/noBarrelFile: package entry point
export { baseConfigSchema, loadConfig } from "./config.js";
export {
  createEvent,
  type EventEnvelope,
  eventEnvelopeSchema,
} from "./events.js";
export { healthRouter, natsCheck, type ReadinessCheck } from "./health.js";
export {
  CORRELATION_ID_HEADER,
  connectNats,
  drainNats,
  parseEvent,
  publishEvent,
} from "./nats.js";
export {
  type ClosableServer,
  createShutdown,
  onShutdown,
  type ShutdownOptions,
  type ShutdownTask,
} from "./shutdown.js";
