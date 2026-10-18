import cors from "cors";
import type { RequestHandler } from "express";
import helmet from "helmet";

const EXPOSED_HEADERS = [
  "x-request-id",
  "retry-after",
  "ratelimit",
  "ratelimit-policy",
  "www-authenticate",
];

export function securityHeaders(): RequestHandler {
  return helmet();
}

export function corsPolicy(): RequestHandler {
  return cors({ exposedHeaders: EXPOSED_HEADERS });
}
