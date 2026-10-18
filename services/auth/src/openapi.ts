import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  type OpenApiDocument,
} from "@payment-be/shared";
import { registerAuthPaths } from "./auth/index.js";

export function buildDocument(): OpenApiDocument {
  const registry = createOpenApiRegistry();
  registerAuthPaths(registry);
  return buildOpenApiDocument(registry, {
    title: "auth service",
    version: "0.0.0",
  });
}
