import { z } from "zod";
import { createEvent, eventEnvelopeSchema } from "./events.js";

export const PAYMENT_EVENT_TYPES = [
  "payment.created",
  "payment.processing",
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export const paymentEventDataSchema = z.strictObject({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/, "Must be an ISO 4217 code"),
  description: z.string().min(1).max(140).optional(),
  email: z.email(),
  failureReason: z.string().min(1).max(200).optional(),
  paymentId: z.uuid(),
  userId: z.uuid(),
});

export type PaymentEventData = z.infer<typeof paymentEventDataSchema>;

export const paymentEventSchema = eventEnvelopeSchema(paymentEventDataSchema)
  .extend({ type: z.enum(PAYMENT_EVENT_TYPES) })
  .superRefine((event, ctx) => {
    const failed = event.type === "payment.failed";
    if (failed && event.data.failureReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Required when type is payment.failed",
        path: ["data", "failureReason"],
      });
    }
    if (!failed && event.data.failureReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Only allowed when type is payment.failed",
        path: ["data", "failureReason"],
      });
    }
  });

export type PaymentEvent = z.infer<typeof paymentEventSchema>;

export function createPaymentEvent(
  type: PaymentEventType,
  data: PaymentEventData
): PaymentEvent {
  return paymentEventSchema.parse(createEvent(type, data));
}
