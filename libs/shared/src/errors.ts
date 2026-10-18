import { STATUS_CODES } from "node:http";
import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import { ZodError, z } from "zod";

export const problemDetailsSchema = z.object({
  code: z.string(),
  detail: z.string().optional(),
  errors: z
    .array(
      z.object({ code: z.string(), detail: z.string(), pointer: z.string() })
    )
    .optional(),
  instance: z.string(),
  requestId: z.string(),
  status: z.int().min(400).max(599),
  title: z.string(),
  type: z.string(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ProblemFieldError = NonNullable<ProblemDetails["errors"]>[number];

type Problem = Omit<ProblemDetails, "instance" | "requestId">;

const PLAIN_TYPE = "about:blank";
const TYPE_PREFIX = "tag:payment-be,2026:";
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const TILDE = /~/g;
const SLASH = /\//g;

const CLIENT_CODES: Record<number, string> = {
  413: "payload-too-large",
  415: "unsupported-media-type",
};

const CLIENT_DETAILS: Record<string, string> = {
  "malformed-json": "The request body is not valid JSON.",
  "payload-too-large": "The request body is too large.",
  "unsupported-media-type":
    "The request body's media type, charset or encoding is not supported.",
};

const INTERNAL_PROBLEM: Problem = {
  code: "internal-error",
  detail: "An unexpected error occurred.",
  status: 500,
  title: "Internal Server Error",
  type: PLAIN_TYPE,
};

const kebab = (text: string): string =>
  text.toLowerCase().replace(NON_ALPHANUMERIC, "-");

const statusPhrase = (status: number): string =>
  STATUS_CODES[status] ?? "Error";

export interface AppErrorOptions {
  cause?: unknown;
  code: string;
  detail?: string;
  errors?: ProblemFieldError[];
  headers?: Record<string, string>;
  plain?: boolean;
  status: number;
  title?: string;
}

export class AppError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  readonly errors: ProblemFieldError[] | undefined;
  readonly headers: Record<string, string>;
  readonly status: number;
  readonly title: string;
  readonly type: string;

  constructor({
    cause,
    code,
    detail,
    errors,
    headers = {},
    plain = false,
    status,
    title,
  }: AppErrorOptions) {
    const resolvedTitle = plain
      ? statusPhrase(status)
      : (title ?? statusPhrase(status));
    super(detail ?? resolvedTitle, cause === undefined ? undefined : { cause });
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.errors = errors;
    this.headers = headers;
    this.status = status;
    this.title = resolvedTitle;
    this.type = plain ? PLAIN_TYPE : `${TYPE_PREFIX}${code}`;
  }
}

export interface ProblemOverrides {
  cause?: unknown;
  code?: string;
  headers?: Record<string, string>;
  title?: string;
}

export type ProblemFactory = (
  detail?: string,
  overrides?: ProblemOverrides
) => AppError;

function problemFactory(status: number): ProblemFactory {
  return (detail, { code, ...overrides } = {}) =>
    new AppError({
      ...overrides,
      code: code ?? kebab(statusPhrase(status)),
      detail,
      plain: code === undefined,
      status,
    });
}

export const badRequest: ProblemFactory = problemFactory(400);
export const unauthorized: ProblemFactory = problemFactory(401);
export const forbidden: ProblemFactory = problemFactory(403);
export const notFound: ProblemFactory = problemFactory(404);
export const conflict: ProblemFactory = problemFactory(409);
export const unprocessable: ProblemFactory = problemFactory(422);
export const tooManyRequests: ProblemFactory = problemFactory(429);
export const serviceUnavailable: ProblemFactory = problemFactory(503);

export function toJsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map(
      (segment) =>
        `/${String(segment).replace(TILDE, "~0").replace(SLASH, "~1")}`
    )
    .join("");
}

function validationProblem(err: ZodError): Problem {
  return {
    code: "validation-error",
    detail: "The request is invalid.",
    errors: err.issues.map((issue) => ({
      code: issue.code,
      detail: issue.message,
      pointer: toJsonPointer(issue.path),
    })),
    status: 400,
    title: "Validation failed",
    type: `${TYPE_PREFIX}validation-error`,
  };
}

interface HttpErrorShape {
  expose?: unknown;
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

function clientStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return;
  }
  const { expose, status, statusCode } = err as HttpErrorShape;
  const value = typeof status === "number" ? status : statusCode;
  if (
    typeof value !== "number" ||
    value < 400 ||
    value > 499 ||
    expose === false
  ) {
    return;
  }
  return value;
}

function clientProblem(err: HttpErrorShape, status: number): Problem {
  const title = STATUS_CODES[status];
  if (!title) {
    return clientProblem(err, 400);
  }
  let code = CLIENT_CODES[status] ?? kebab(title);
  if (status === 400 && err.type === "entity.parse.failed") {
    code = "malformed-json";
  }
  const detail = CLIENT_DETAILS[code];
  return {
    code,
    ...(detail === undefined ? {} : { detail }),
    status,
    title,
    type: PLAIN_TYPE,
  };
}

function appProblem(err: AppError): Problem {
  return {
    code: err.code,
    ...(err.detail === undefined ? {} : { detail: err.detail }),
    ...(err.errors === undefined ? {} : { errors: err.errors }),
    status: err.status,
    title: err.title,
    type: err.type,
  };
}

const isProblemStatus = (status: number): boolean =>
  Number.isInteger(status) && status >= 400 && status <= 599;

function toProblem(err: unknown): Problem {
  if (err instanceof AppError) {
    return isProblemStatus(err.status) ? appProblem(err) : INTERNAL_PROBLEM;
  }
  if (err instanceof ZodError) {
    return validationProblem(err);
  }
  const status = clientStatus(err);
  if (status !== undefined) {
    return clientProblem(err as HttpErrorShape, status);
  }
  return INTERNAL_PROBLEM;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

const toError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(safeString(err));

const instancePath = (req: Request): string =>
  req.originalUrl.split("?", 1)[0] ?? "/";

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound("The requested resource does not exist."));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    res.err = toError(err);
    res.destroy();
    return;
  }
  const problem = toProblem(err);
  if (problem.status >= 500) {
    res.err = toError(err);
  }
  if (err instanceof AppError && problem.status === err.status) {
    res.set(err.headers);
  }
  const body: ProblemDetails = {
    ...problem,
    instance: instancePath(req),
    requestId: String(req.id),
  };
  res
    .status(problem.status)
    .set("cache-control", "no-store")
    .type("application/problem+json")
    .json(body);
};
