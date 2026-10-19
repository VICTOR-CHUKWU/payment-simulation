import { randomUUID } from "node:crypto";
import {
  createPaymentEvent,
  PAYMENT_EVENT_TYPES,
  type PaymentEventData,
  type PaymentEventType,
  paymentEventSchema,
} from "./payment-events.js";
import { PAYMENTS_STREAM } from "./streams.js";

const data: PaymentEventData = {
  amount: 12_500,
  currency: "NGN",
  description: "Order 42",
  email: "user@example.com",
  paymentId: randomUUID(),
  userId: randomUUID(),
};

const dataFor = (type: PaymentEventType): PaymentEventData =>
  type === "payment.failed"
    ? { ...data, failureReason: "Card declined" }
    : data;

const envelope = (overrides: Record<string, unknown>) => ({
  ...createPaymentEvent("payment.created", data),
  ...overrides,
});

describe("createPaymentEvent", () => {
  it.each(PAYMENT_EVENT_TYPES)("round-trips %s", (type) => {
    const event = createPaymentEvent(type, dataFor(type));
    expect(event).toMatchObject({ data: dataFor(type), type });
    expect(paymentEventSchema.parse(event)).toEqual(event);
  });

  it("requires failureReason on payment.failed", () => {
    expect(() => createPaymentEvent("payment.failed", data)).toThrow(
      "Required when type is payment.failed"
    );
  });

  it.each(PAYMENT_EVENT_TYPES.filter((type) => type !== "payment.failed"))(
    "rejects failureReason on %s",
    (type) => {
      expect(() =>
        createPaymentEvent(type, { ...data, failureReason: "Card declined" })
      ).toThrow("Only allowed when type is payment.failed");
    }
  );
});

describe("paymentEventSchema", () => {
  it("rejects an unknown type", () => {
    expect(
      paymentEventSchema.safeParse(envelope({ type: "payment.refunded" }))
        .success
    ).toBe(false);
  });

  it.each([
    ["a float amount", { amount: 1.5 }],
    ["a zero amount", { amount: 0 }],
    ["a lowercase currency", { currency: "ngn" }],
    ["a 4-letter currency", { currency: "NGNX" }],
    ["a bad email", { email: "not-an-email" }],
    ["a bad paymentId", { paymentId: "nope" }],
    ["a bad userId", { userId: "nope" }],
    ["an unknown key", { status: "pending" }],
  ])("rejects %s", (_label, change) => {
    expect(
      paymentEventSchema.safeParse(envelope({ data: { ...data, ...change } }))
        .success
    ).toBe(false);
  });

  it("puts every type under the stream's subject filter", () => {
    const [filter] = PAYMENTS_STREAM.subjects;
    expect(filter.endsWith(".>")).toBe(true);
    const prefix = filter.slice(0, -1);
    for (const type of PAYMENT_EVENT_TYPES) {
      expect(type.startsWith(prefix) && type.length > prefix.length).toBe(true);
    }
  });
});
