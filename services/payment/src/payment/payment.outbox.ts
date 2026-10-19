import {
  createPaymentEvent,
  type PaymentEventType,
  paymentEventSchema,
} from "@payment-be/shared";
import { z } from "zod";
import type { Payment, PaymentStatus } from "./payment.js";

export const correlationIdSchema = z.string().min(1).max(128);

export const outboxEntrySchema = z.object({
  correlationId: correlationIdSchema.optional(),
  event: paymentEventSchema,
});

export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

export type OutboxSource = Pick<
  Payment,
  | "amount"
  | "currency"
  | "description"
  | "email"
  | "failureReason"
  | "id"
  | "status"
  | "userId"
>;

export function toEventType(status: PaymentStatus): PaymentEventType {
  return status === "pending" ? "payment.created" : `payment.${status}`;
}

export function outboxEntry(
  payment: OutboxSource,
  correlationId?: string
): OutboxEntry {
  const event = createPaymentEvent(toEventType(payment.status), {
    amount: payment.amount,
    currency: payment.currency,
    email: payment.email,
    paymentId: payment.id,
    userId: payment.userId,
    ...(payment.description === undefined
      ? {}
      : { description: payment.description }),
    ...(payment.status === "failed" && payment.failureReason !== undefined
      ? { failureReason: payment.failureReason }
      : {}),
  });
  return correlationId === undefined ? { event } : { correlationId, event };
}
