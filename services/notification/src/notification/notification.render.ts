import type { PaymentEvent } from "@payment-be/shared";
import { NOTIFIED_TYPES, type NotifiedType } from "./notification.js";

export interface RenderedNotification {
  message: string;
  title: string;
}

export function formatAmount(amount: number, currency: string): string {
  const format = new Intl.NumberFormat("en", {
    currency,
    currencyDisplay: "code",
    style: "currency",
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 0;
  return format.format(amount / 10 ** digits);
}

const isNotified = (type: string): type is NotifiedType =>
  (NOTIFIED_TYPES as readonly string[]).includes(type);

export function renderNotification(
  event: PaymentEvent
): RenderedNotification | undefined {
  if (!isNotified(event.type)) {
    return;
  }
  const { amount, currency, description, failureReason } = event.data;
  const subject = `Your payment of ${formatAmount(amount, currency)}${
    description === undefined ? "" : ` for ${description}`
  }`;
  switch (event.type) {
    case "payment.created":
      return {
        message: `${subject} was received and is being processed.`,
        title: "Payment received",
      };
    case "payment.succeeded":
      return { message: `${subject} succeeded.`, title: "Payment succeeded" };
    case "payment.failed":
      return {
        message: `${subject} failed: ${failureReason}.`,
        title: "Payment failed",
      };
    case "payment.cancelled":
      return {
        message: `${subject} was cancelled.`,
        title: "Payment cancelled",
      };
    default:
      return;
  }
}
