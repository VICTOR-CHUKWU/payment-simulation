import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  type OpenApiDocument,
} from "@payment-be/shared";

export function buildDocument(): OpenApiDocument {
  const registry = createOpenApiRegistry();
  return buildOpenApiDocument(registry, {
    title: "auth service",
    version: "0.0.0",
  });
}
