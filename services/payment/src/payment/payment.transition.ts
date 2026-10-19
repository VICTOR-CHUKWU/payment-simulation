import {
  notFound,
  type Repository,
  VersionConflictError,
} from "@payment-be/shared";
import type { Payment, PaymentStatus } from "./payment.js";
import { outboxEntry } from "./payment.outbox.js";
import { statusChange } from "./payment.status.js";

const TRANSITION_ATTEMPTS = 3;

export interface TransitionResult {
  from: PaymentStatus;
  payment: Payment;
}

export const paymentNotFound = () =>
  notFound("Payment not found.", { code: "payment-not-found" });

export async function transitionPayment(
  payments: Repository<Payment>,
  id: string,
  to: PaymentStatus,
  {
    correlationId,
    failureReason,
    now = () => new Date(),
  }: { correlationId?: string; failureReason?: string; now?: () => Date } = {}
): Promise<TransitionResult> {
  for (let attempt = 1; ; attempt += 1) {
    // Re-read each attempt so the transition is checked against the latest status.
    // biome-ignore lint/performance/noAwaitInLoops: attempts must run in sequence
    const payment = await payments.get(id);
    if (payment === undefined) {
      throw paymentNotFound();
    }
    const patch = statusChange(payment, to, { failureReason, now: now() });
    const entry = outboxEntry(
      { ...payment, ...patch },
      correlationId ?? payment.correlationId
    );
    try {
      const updated = await payments.update(id, payment.version, {
        ...patch,
        outbox: [...(payment.outbox ?? []), entry],
      });
      return { from: payment.status, payment: updated };
    } catch (error) {
      if (
        !(error instanceof VersionConflictError) ||
        attempt === TRANSITION_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}
