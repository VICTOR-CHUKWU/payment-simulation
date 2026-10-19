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
    description:
      "Creates payments, returns them to their owner, and lets admins change their status. New payments are settled in the background by a simulated gateway, and every status change is published as an event.",
    title: "payment service",
    version: "0.0.0",
  });
}
