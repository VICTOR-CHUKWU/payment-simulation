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
export {
  createFileRepository,
  type FileRepository,
  type FileRepositoryOptions,
  type FileSystem,
  storageCheck,
} from "./file-repository.js";
export { healthRouter, natsCheck, type ReadinessCheck } from "./health.js";
export {
  bindLogUser,
  createLogger,
  httpLogger,
  type Logger,
  type LoggerOptions,
  type LogUser,
} from "./logger.js";
export { createMemoryRepository } from "./memory-repository.js";
export {
  CORRELATION_ID_HEADER,
  connectNats,
  drainNats,
  parseEvent,
  publishEvent,
} from "./nats.js";
export {
  bearerSecurity,
  buildOpenApiDocument,
  createOpenApiRegistry,
  docsRouter,
  type OpenAPIRegistry,
  type OpenApiDocument,
  type OpenApiInfo,
  problemResponses,
} from "./openapi.js";
export {
  DuplicateRecordError,
  type NewRecord,
  RecordNotFoundError,
  type RecordPatch,
  type Repository,
  VersionConflictError,
  type Versioned,
} from "./repository.js";
export { listen } from "./server.js";
export {
  type ClosableServer,
  createShutdown,
  onShutdown,
  type ShutdownOptions,
  type ShutdownTask,
} from "./shutdown.js";
export {
  type OpenedRepository,
  openRepository,
  type StorageConfig,
  storageConfigSchema,
} from "./storage.js";
