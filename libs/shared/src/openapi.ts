import { STATUS_CODES } from "node:http";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type ResponseConfig,
} from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { type ProblemDetails, problemDetailsSchema } from "./errors.js";

export type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

export type OpenApiDocument = ReturnType<
  OpenApiGeneratorV31["generateDocument"]
>;

export interface OpenApiInfo {
  description?: string;
  title: string;
  version: string;
}

const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

const problemDetails = problemDetailsSchema.meta({ id: "ProblemDetails" });

const checkStatusSchema = z.enum(["ok", "fail"]);

const liveSchema = z
  .object({ status: z.literal("ok") })
  .meta({ example: { status: "ok" }, id: "Liveness" });

const readySchema = z
  .object({
    checks: z.record(z.string(), checkStatusSchema),
    status: checkStatusSchema,
  })
  .meta({
    example: { checks: { nats: "ok", storage: "ok" }, status: "ok" },
    id: "Readiness",
  });

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

function problemExample(status: number): ProblemDetails {
  const title = STATUS_CODES[status] ?? "Error";
  return {
    code: title.toLowerCase().replace(NON_ALPHANUMERIC, "-"),
    detail: title,
    instance: "/path",
    requestId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    status,
    title,
    type: "about:blank",
  };
}

export const bearerSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }];

export function problemResponses(
  ...statuses: number[]
): Record<string, ResponseConfig> {
  return Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        content: {
          "application/problem+json": {
            example: problemExample(status),
            schema: problemDetails,
          },
        },
        description: STATUS_CODES[status] ?? "Error",
      },
    ])
  );
}

export function createOpenApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "bearerAuth", {
    bearerFormat: "JWT",
    description:
      "Access token returned by `POST /auth/login` on the auth service.",
    scheme: "bearer",
    type: "http",
  });
  registry.registerPath({
    description:
      "Returns `200` while the process is up. It checks no dependencies, so a failing dependency never restarts the service.",
    method: "get",
    path: "/health/live",
    responses: {
      200: { content: json(liveSchema), description: "The process is up" },
    },
    summary: "Liveness",
    tags: ["health"],
  });
  registry.registerPath({
    description:
      "Runs every dependency check of this service (for example `nats`, `storage` or `consumers`) and returns `200` when all pass, or `503` with the failing ones marked `fail`.",
    method: "get",
    path: "/health/ready",
    responses: {
      200: {
        content: json(readySchema),
        description: "Every dependency check passed",
      },
      503: {
        content: json(readySchema),
        description: "At least one dependency check failed",
      },
    },
    summary: "Readiness",
    tags: ["health"],
  });
  return registry;
}

export function buildOpenApiDocument(
  registry: OpenAPIRegistry,
  info: OpenApiInfo
): OpenApiDocument {
  // Passed explicitly so ProblemDetails is emitted before any route references it.
  const generator = new OpenApiGeneratorV31([
    ...registry.definitions,
    { schema: problemDetails, type: "schema" },
  ]);
  return generator.generateDocument({
    info: { ...info },
    openapi: "3.1.0",
    servers: [{ url: "/" }],
  });
}

const swaggerUiOptions = {
  swaggerOptions: {
    displayRequestDuration: true,
    persistAuthorization: true,
    tryItOutEnabled: true,
  },
};

export function docsRouter(document: OpenApiDocument): Router {
  const router = Router();
  router.get("/docs/openapi.json", (_req, res) => {
    res.json(document);
  });
  // serveFiles builds an init script per document; the bare `serve` shares one across every setup call.
  router.use(
    "/docs",
    swaggerUi.serveFiles(document, swaggerUiOptions),
    swaggerUi.setup(document, swaggerUiOptions)
  );
  return router;
}

export type OperationAccess = "public" | "bearer" | "admin";

interface OperationObject {
  description?: string;
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
  security?: unknown;
  summary?: string;
  tags?: string[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function resolveSchema(
  document: OpenApiDocument,
  schema: unknown
): Record<string, unknown> | undefined {
  if (typeof schema !== "object" || schema === null) {
    return;
  }
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref !== "string") {
    return schema as Record<string, unknown>;
  }
  const name = ref.replace("#/components/schemas/", "");
  return document.components?.schemas?.[name] as
    | Record<string, unknown>
    | undefined;
}

const hasExample = (
  document: OpenApiDocument,
  content: Record<string, { schema?: unknown; example?: unknown }> | undefined
): boolean =>
  Object.values(content ?? {}).some(
    (media) =>
      media.example !== undefined ||
      resolveSchema(document, media.schema)?.example !== undefined
  );

const ERROR_STATUS = /^[45]/;

const isHealth = (path: string) => path.startsWith("/health/");

function describeIssues(operation: OperationObject): string[] {
  return [
    ...(operation.summary ? [] : ["no summary"]),
    ...(operation.description ? [] : ["no description"]),
    ...(operation.tags?.length ? [] : ["no tag"]),
  ];
}

function responseIssues(
  document: OpenApiDocument,
  path: string,
  operation: OperationObject
): string[] {
  const issues: string[] = [];
  if (
    operation.requestBody &&
    !hasExample(document, operation.requestBody.content)
  ) {
    issues.push("request body has no example");
  }
  const responses = operation.responses ?? {};
  for (const [status, response] of Object.entries(responses)) {
    if (status.startsWith("2") && !hasExample(document, response.content)) {
      issues.push(`${status} response has no example`);
    }
    if (
      ERROR_STATUS.test(status) &&
      !isHealth(path) &&
      response.content?.["application/problem+json"] === undefined
    ) {
      issues.push(`${status} response is not problem+json`);
    }
  }
  if (!(isHealth(path) || "500" in responses)) {
    issues.push("does not document 500");
  }
  return issues;
}

function accessIssues(
  operation: OperationObject,
  access: OperationAccess
): string[] {
  const statuses = Object.keys(operation.responses ?? {});
  if (access === "public") {
    return operation.security === undefined
      ? []
      : ["public operation has security"];
  }
  const secured =
    JSON.stringify(operation.security ?? []) === JSON.stringify(bearerSecurity);
  return [
    ...(secured ? [] : ["missing bearer security"]),
    ...(statuses.includes("401") ? [] : ["does not document 401"]),
    ...(access === "admin" && !statuses.includes("403")
      ? ["does not document 403"]
      : []),
  ];
}

function operationsOf(
  document: OpenApiDocument
): { key: string; operation: OperationObject; path: string }[] {
  return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = (item as Record<string, OperationObject | undefined>)[
        method
      ];
      return operation === undefined
        ? []
        : [{ key: `${method.toUpperCase()} ${path}`, operation, path }];
    })
  );
}

export function findOpenApiIssues(
  document: OpenApiDocument,
  expected: Record<string, OperationAccess>
): string[] {
  const operations = operationsOf(document);
  const issues = operations.flatMap(({ key, operation, path }) => {
    const access = expected[key];
    if (access === undefined) {
      return [`${key}: not in the expected operations`];
    }
    return [
      ...describeIssues(operation),
      ...responseIssues(document, path, operation),
      ...accessIssues(operation, access),
    ].map((issue) => `${key}: ${issue}`);
  });
  const documented = new Set(operations.map(({ key }) => key));
  return [
    ...issues,
    ...Object.keys(expected)
      .filter((key) => !documented.has(key))
      .map((key) => `${key}: expected but not documented`),
  ];
}
