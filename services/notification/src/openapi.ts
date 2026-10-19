import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  type OpenApiDocument,
} from "@payment-be/shared";
import { registerDlqPaths } from "./dlq/index.js";
import { registerNotificationPaths } from "./notification/index.js";

export function buildDocument(): OpenApiDocument {
  const registry = createOpenApiRegistry();
  registerNotificationPaths(registry);
  registerDlqPaths(registry);
  return buildOpenApiDocument(registry, {
    title: "notification service",
    version: "0.0.0",
  });
}
