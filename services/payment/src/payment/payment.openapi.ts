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
  updatePaymentStatusBodySchema,
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
  registry.registerPath({
    description:
      "Changes a payment's status. Admins only: any other caller gets `403`. An admin can cancel a `pending` payment, or mark a `processing` payment `succeeded` or `failed`. `failureReason` is required when `status` is `failed` and rejected otherwise. A change the payment's current status does not allow returns `409 invalid-status-transition`. If the payment keeps changing under concurrent updates, the request returns `409 version-conflict` and can be retried.",
    method: "patch",
    path: "/payments/{id}/status",
    request: {
      body: { content: json(updatePaymentStatusBodySchema), required: true },
      params: paymentIdParamsSchema,
    },
    responses: {
      200: {
        content: json(paymentEnvelopeSchema),
        description: "The payment with its new status",
      },
      ...problemResponses(400, 401, 403, 404, 409, 413, 415),
    },
    security: bearerSecurity,
    summary: "Update payment status",
    tags: ["payments"],
  });
}
