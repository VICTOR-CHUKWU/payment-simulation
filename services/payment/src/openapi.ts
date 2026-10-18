import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  type OpenApiDocument,
} from "@payment-be/shared";
import { registerPaymentPaths } from "./payment/index.js";

export function buildDocument(): OpenApiDocument {
  const registry = createOpenApiRegistry();
  registerPaymentPaths(registry);
  return buildOpenApiDocument(registry, {
    title: "payment service",
    version: "0.0.0",
  });
}
