import { z } from "zod";
import { paymentFieldsSchema } from "./payment.js";

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

export const paymentResponseSchema = paymentFieldsSchema
  .omit({ version: true })
  .meta({ id: "Payment" });

export type PaymentResponse = z.infer<typeof paymentResponseSchema>;
