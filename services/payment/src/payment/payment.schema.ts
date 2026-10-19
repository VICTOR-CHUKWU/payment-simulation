import { z } from "zod";
import { idempotencyKeySchema, paymentFieldsSchema } from "./payment.js";

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

export const paymentResponseSchema = paymentFieldsSchema
  .omit({ idempotencyKey: true, version: true })
  .meta({ id: "Payment" });

export type PaymentResponse = z.infer<typeof paymentResponseSchema>;
