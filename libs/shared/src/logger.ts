import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type DestinationStream, type Logger, pino } from "pino";
import { type HttpLogger, pinoHttp } from "pino-http";

export type { Logger } from "pino";

export interface LoggerOptions {
  destination?: DestinationStream;
  level: string;
  pretty: boolean;
  service: string;
}

export interface LogUser {
  role: string;
  userId: string;
}

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SENSITIVE_KEYS = ["password", "token", "accessToken", "email"];

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

const boundUsers = new WeakMap<ServerResponse, LogUser>();

export function createLogger({
  destination,
  level,
  pretty,
  service,
}: LoggerOptions): Logger {
  const options = {
    base: { service },
    level,
    redact: { censor: "[Redacted]", paths: REDACT_PATHS },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (destination) {
    return pino(options, destination);
  }
  if (pretty) {
    return pino({ ...options, transport: { target: "pino-pretty" } });
  }
  return pino(options);
}

function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

function logLevel(_req: IncomingMessage, res: ServerResponse, err?: Error) {
  if (err || res.err || res.statusCode >= 500) {
    return "error";
  }
  if (res.statusCode >= 400) {
    return "warn";
  }
  return "info";
}

function withUser(res: ServerResponse, val: object): object {
  const user = boundUsers.get(res);
  return user ? { ...val, role: user.role, userId: user.userId } : val;
}

export function httpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    autoLogging: { ignore: (req) => req.url?.startsWith("/health/") ?? false },
    customErrorObject: (_req, res, _err, val) => withUser(res, val),
    customLogLevel: logLevel,
    customProps: (req) => ({ correlationId: req.id }),
    customSuccessObject: (_req, res, val) => withUser(res, val),
    genReqId: requestId,
    logger,
  });
}

export function bindLogUser(
  req: IncomingMessage,
  res: ServerResponse,
  { role, userId }: LogUser
): void {
  boundUsers.set(res, { role, userId });
  req.log = req.log.child({ role, userId });
}
