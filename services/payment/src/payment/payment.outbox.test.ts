import { paymentEventSchema } from "@payment-be/shared";
import type { PaymentStatus } from "./payment.js";
import {
  type OutboxSource,
  outboxEntry,
  toEventType,
} from "./payment.outbox.js";

const payment: OutboxSource = {
  amount: 150_000,
  currency: "NGN",
  description: "Order #42",
  email: "ada@example.com",
  id: "3f1c2b7a-9d4e-4a51-8c6b-2e7f0a9d1b34",
  status: "pending",
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

describe("toEventType", () => {
  it.each([
    ["pending", "payment.created"],
    ["processing", "payment.processing"],
    ["succeeded", "payment.succeeded"],
    ["failed", "payment.failed"],
    ["cancelled", "payment.cancelled"],
  ] as const)("maps %s to %s", (status: PaymentStatus, type) => {
    expect(toEventType(status)).toBe(type);
  });
});

describe("outboxEntry", () => {
  it("builds a valid event from the payment snapshot", () => {
    const { correlationId, event } = outboxEntry(payment, "req-1");

    expect(correlationId).toBe("req-1");
    expect(paymentEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      data: {
        amount: 150_000,
        currency: "NGN",
        description: "Order #42",
        email: "ada@example.com",
        paymentId: payment.id,
        userId: payment.userId,
      },
      type: "payment.created",
    });
  });

  it("adds the failure reason only for a failed payment", () => {
    const failed = outboxEntry({
      ...payment,
      failureReason: "Card declined",
      status: "failed",
    });

    expect(failed.event.data.failureReason).toBe("Card declined");
    expect(outboxEntry(payment).event.data).not.toHaveProperty("failureReason");
    expect(
      outboxEntry({ ...payment, failureReason: "Card declined" }).event.data
    ).not.toHaveProperty("failureReason");
  });

  it("leaves out description and correlation ID when they are not set", () => {
    const { description: _description, ...bare } = payment;

    const entry = outboxEntry(bare);

    expect(entry).not.toHaveProperty("correlationId");
    expect(entry.event.data).not.toHaveProperty("description");
  });

  it("gives every entry its own event ID", () => {
    expect(outboxEntry(payment).event.eventId).not.toBe(
      outboxEntry(payment).event.eventId
    );
  });
});
