import { dataResponseSchema } from "@payment-be/shared";
import { z } from "zod";
import {
  failureReasonSchema,
  idempotencyKeySchema,
  paymentFieldsSchema,
  paymentStatusSchema,
} from "./payment.js";

export const createPaymentBodySchema = z
  .strictObject(
    paymentFieldsSchema.pick({
      amount: true,
      currency: true,
      description: true,
    }).shape
  )
  .meta({
    example: { amount: 150_000, currency: "NGN", description: "Order #42" },
    id: "CreatePaymentRequest",
  });

export type CreatePaymentBody = z.infer<typeof createPaymentBodySchema>;

export const idempotencyKeyHeaderSchema = z.object({
  "idempotency-key": idempotencyKeySchema.optional(),
});

export const paymentIdParamsSchema = z.object({ id: z.uuid() });

export const updatePaymentStatusBodySchema = z
  .strictObject({
    failureReason: failureReasonSchema.optional(),
    status: paymentStatusSchema.extract(["cancelled", "succeeded", "failed"]),
  })
  .superRefine(({ failureReason, status }, ctx) => {
    if (status === "failed" && failureReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "failureReason is required when status is failed",
        path: ["failureReason"],
      });
    }
    if (status !== "failed" && failureReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "failureReason is only allowed when status is failed",
        path: ["failureReason"],
      });
    }
  })
  .meta({
    example: { failureReason: "Card declined by issuer", status: "failed" },
    id: "UpdatePaymentStatusRequest",
  });

export type UpdatePaymentStatusBody = z.infer<
  typeof updatePaymentStatusBodySchema
>;

export const paymentResponseSchema = paymentFieldsSchema
  .omit({
    correlationId: true,
    idempotencyKey: true,
    outbox: true,
    version: true,
  })
  .meta({ id: "Payment" });

export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

export const paymentEnvelopeSchema = dataResponseSchema(
  paymentResponseSchema
).meta({
  example: {
    data: {
      amount: 150_000,
      createdAt: "2026-10-19T10:00:00.000Z",
      currency: "NGN",
      description: "Order #42",
      email: "user@example.com",
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      status: "pending",
      updatedAt: "2026-10-19T10:00:00.000Z",
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    },
    message: "Payment created",
    status: 201,
    success: true,
  },
  id: "PaymentResponse",
});
