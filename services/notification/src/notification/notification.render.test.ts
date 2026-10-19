import { randomUUID } from "node:crypto";
import { createPaymentEvent, type PaymentEventType } from "@payment-be/shared";
import { formatAmount, renderNotification } from "./notification.render.js";

const event = (type: PaymentEventType, extra: { description?: string } = {}) =>
  createPaymentEvent(type, {
    amount: 150_000,
    currency: "NGN",
    email: "ada@example.com",
    paymentId: randomUUID(),
    userId: randomUUID(),
    ...extra,
    ...(type === "payment.failed" ? { failureReason: "Card declined" } : {}),
  });

describe("formatAmount", () => {
  it("formats minor units with the currency code and a no-break space", () => {
    expect(formatAmount(150_000, "NGN")).toBe("NGN\u00a01,500.00");
  });

  it("formats a zero-decimal currency without dividing", () => {
    expect(formatAmount(1500, "JPY")).toBe("JPY\u00a01,500");
  });
});

describe("renderNotification", () => {
  it.each([
    [
      "payment.created",
      "Payment received",
      "Your payment of NGN\u00a01,500.00 was received and is being processed.",
    ],
    [
      "payment.succeeded",
      "Payment succeeded",
      "Your payment of NGN\u00a01,500.00 succeeded.",
    ],
    [
      "payment.failed",
      "Payment failed",
      "Your payment of NGN\u00a01,500.00 failed: Card declined.",
    ],
    [
      "payment.cancelled",
      "Payment cancelled",
      "Your payment of NGN\u00a01,500.00 was cancelled.",
    ],
  ] as const)("renders %s", (type, title, message) => {
    expect(renderNotification(event(type))).toEqual({ message, title });
  });

  it.each([
    ["payment.created", "was received and is being processed."],
    ["payment.succeeded", "succeeded."],
    ["payment.failed", "failed: Card declined."],
    ["payment.cancelled", "was cancelled."],
  ] as const)("includes the description in %s", (type, ending) => {
    expect(
      renderNotification(event(type, { description: "Order #42" }))?.message
    ).toBe(`Your payment of NGN\u00a01,500.00 for Order #42 ${ending}`);
  });

  it("returns undefined for payment.processing", () => {
    expect(renderNotification(event("payment.processing"))).toBeUndefined();
  });
});
