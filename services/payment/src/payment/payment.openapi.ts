import {
  bearerSecurity,
  type OpenAPIRegistry,
  problemResponses,
} from "@payment-be/shared";
import { z } from "zod";
import { idempotencyKeySchema } from "./payment.js";
import {
  createPaymentBodySchema,
  paymentEnvelopeSchema,
  paymentIdParamsSchema,
} from "./payment.schema.js";

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

export function registerPaymentPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    description:
      "Creates a `pending` payment owned by the caller. `amount` is a positive integer in minor units (kobo, cents). The owner's ID and email come from the access token, not the body. Send an optional `Idempotency-Key` header to make retries safe: repeating a request with the same key and body returns the existing payment with `200`, and reusing the key with a different body returns `422`.",
    method: "post",
    path: "/payments",
    request: {
      body: { content: json(createPaymentBodySchema), required: true },
      headers: z.object({
        "Idempotency-Key": idempotencyKeySchema.optional().meta({
          description:
            "1 to 255 printable ASCII characters, scoped to the caller. Keys never expire.",
        }),
      }),
    },
    responses: {
      200: {
        content: json(paymentEnvelopeSchema),
        description:
          "Replay: a payment already exists for this Idempotency-Key and is returned in its current state",
      },
      201: { content: json(paymentEnvelopeSchema), description: "Created" },
      ...problemResponses(400, 401, 413, 415, 422),
    },
    security: bearerSecurity,
    summary: "Create payment",
    tags: ["payments"],
  });
  registry.registerPath({
    description:
      "Returns one payment. Users can read only their own payments and admins can read any. A payment owned by someone else returns the same `404` as an unknown ID.",
    method: "get",
    path: "/payments/{id}",
    request: { params: paymentIdParamsSchema },
    responses: {
      200: { content: json(paymentEnvelopeSchema), description: "The payment" },
      ...problemResponses(400, 401, 404),
    },
    security: bearerSecurity,
    summary: "Get payment",
    tags: ["payments"],
  });
}
