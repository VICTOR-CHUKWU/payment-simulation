import {
  bearerSecurity,
  type OpenAPIRegistry,
  problemResponses,
} from "@payment-be/shared";
import type { z } from "zod";
import {
  createPaymentBodySchema,
  paymentResponseSchema,
} from "./payment.schema.js";

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

export function registerPaymentPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    description:
      "Creates a `pending` payment owned by the caller. `amount` is a positive integer in minor units (kobo, cents). The owner's ID and email come from the access token, not the body.",
    method: "post",
    path: "/payments",
    request: {
      body: { content: json(createPaymentBodySchema), required: true },
    },
    responses: {
      201: { content: json(paymentResponseSchema), description: "Created" },
      ...problemResponses(400, 401, 413, 415),
    },
    security: bearerSecurity,
    summary: "Create payment",
    tags: ["payments"],
  });
}
