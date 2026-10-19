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
  .meta({ id: "CreatePaymentRequest" });

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
  .meta({ id: "UpdatePaymentStatusRequest" });

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
).meta({ id: "PaymentResponse" });
