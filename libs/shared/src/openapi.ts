import { STATUS_CODES } from "node:http";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type ResponseConfig,
} from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { problemDetailsSchema } from "./errors.js";

export type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

export type OpenApiDocument = ReturnType<
  OpenApiGeneratorV31["generateDocument"]
>;

export interface OpenApiInfo {
  description?: string;
  title: string;
  version: string;
}

const problemDetails = problemDetailsSchema.meta({ id: "ProblemDetails" });

const checkStatusSchema = z.enum(["ok", "fail"]);

const liveSchema = z.object({ status: z.literal("ok") });

const readySchema = z.object({
  checks: z.record(z.string(), checkStatusSchema),
  status: checkStatusSchema,
});

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

export const bearerSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }];

export function problemResponses(
  ...statuses: number[]
): Record<string, ResponseConfig> {
  return Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        content: { "application/problem+json": { schema: problemDetails } },
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
    method: "get",
    path: "/health/live",
    responses: {
      200: { content: json(liveSchema), description: "The process is up" },
    },
    summary: "Liveness",
    tags: ["health"],
  });
  registry.registerPath({
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
