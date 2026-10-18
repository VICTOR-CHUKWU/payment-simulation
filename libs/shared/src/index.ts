// biome-ignore lint/performance/noBarrelFile: package entry point
export { baseConfigSchema, loadConfig } from "./config.js";
export {
  AppError,
  type AppErrorOptions,
  badRequest,
  conflict,
  errorHandler,
  forbidden,
  notFound,
  notFoundHandler,
  type ProblemDetails,
  type ProblemFactory,
  type ProblemFieldError,
  type ProblemOverrides,
  problemDetailsSchema,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "./errors.js";
export {
  createEvent,
  type EventEnvelope,
  eventEnvelopeSchema,
} from "./events.js";
export { healthRouter, natsCheck, type ReadinessCheck } from "./health.js";
export {
  bindLogUser,
  createLogger,
  httpLogger,
  type Logger,
  type LoggerOptions,
  type LogUser,
} from "./logger.js";
export {
  CORRELATION_ID_HEADER,
  connectNats,
  drainNats,
  parseEvent,
  publishEvent,
} from "./nats.js";
export { listen } from "./server.js";
export {
  type ClosableServer,
  createShutdown,
  onShutdown,
  type ShutdownOptions,
  type ShutdownTask,
} from "./shutdown.js";
