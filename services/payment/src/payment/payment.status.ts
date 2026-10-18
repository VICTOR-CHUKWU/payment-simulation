import { conflict, type RecordPatch } from "@payment-be/shared";
import {
  failureReasonSchema,
  type Payment,
  type PaymentStatus,
} from "./payment.js";

export const PAYMENT_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  cancelled: [],
  failed: [],
  pending: ["processing", "cancelled"],
  processing: ["succeeded", "failed"],
  succeeded: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[status].length === 0;
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw conflict(`Cannot change payment status from ${from} to ${to}.`, {
      code: "invalid-status-transition",
    });
  }
}

export function statusChange(
  payment: Pick<Payment, "status">,
  to: PaymentStatus,
  {
    failureReason,
    now = new Date(),
  }: { failureReason?: string; now?: Date } = {}
): RecordPatch<Payment> {
  assertTransition(payment.status, to);
  if (to === "failed" && failureReason === undefined) {
    throw new Error("failureReason is required when status changes to failed");
  }
  if (to !== "failed" && failureReason !== undefined) {
    throw new Error("failureReason is only allowed when status is failed");
  }
  return {
    status: to,
    updatedAt: now.toISOString(),
    ...(failureReason === undefined
      ? {}
      : { failureReason: failureReasonSchema.parse(failureReason) }),
  };
}
