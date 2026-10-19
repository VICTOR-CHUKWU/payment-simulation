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
    description:
      "Owns users and issues JWT access tokens. Register an account or log in to get a token for the payment and notification services.",
    title: "auth service",
    version: "0.0.0",
  });
}
