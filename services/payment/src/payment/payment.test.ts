import {
  amountSchema,
  CURRENCIES,
  currencySchema,
  paymentFieldsSchema,
  paymentSchema,
} from "./payment.js";

const valid = {
  amount: 150_000,
  createdAt: "2026-10-18T12:00:00.000Z",
  currency: "NGN",
  description: "Order #42",
  email: "ada@example.com",
  id: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
  status: "pending",
  updatedAt: "2026-10-18T12:00:00.000Z",
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  version: 1,
};

describe("currencySchema", () => {
  it("accepts every allowlisted currency", () => {
    for (const currency of Object.keys(CURRENCIES)) {
      expect(currencySchema.parse(currency)).toBe(currency);
    }
  });

  it("uses two minor-unit digits for every currency", () => {
    expect(Object.values(CURRENCIES).every((exponent) => exponent === 2)).toBe(
      true
    );
  });
});

describe("amountSchema", () => {
  it("accepts the largest safe integer", () => {
    expect(amountSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
});

describe("paymentSchema", () => {
  it.each(["pending", "processing", "succeeded", "cancelled"])(
    "accepts a %s payment",
    (status) => {
      const payment = { ...valid, status };
      expect(paymentSchema.parse(payment)).toEqual(payment);
    }
  );

  it("accepts a failed payment with a reason", () => {
    const payment = { ...valid, failureReason: "declined", status: "failed" };
    expect(paymentSchema.parse(payment)).toEqual(payment);
  });

  it("accepts a payment with an idempotency key", () => {
    const payment = { ...valid, idempotencyKey: "order-42" };
    expect(paymentSchema.parse(payment)).toEqual(payment);
  });

  it("accepts a payment without a description", () => {
    const { description: _description, ...payment } = valid;
    expect(paymentSchema.parse(payment)).toEqual(payment);
  });

  it.each([
    ["an unknown currency", { currency: "JPY" }],
    ["a lowercase currency", { currency: "ngn" }],
    ["a float amount", { amount: 10.5 }],
    ["a zero amount", { amount: 0 }],
    ["a negative amount", { amount: -100 }],
    ["an unsafe amount", { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ["a string amount", { amount: "100" }],
    ["an unknown status", { status: "refunded" }],
    ["an invalid email", { email: "not-an-email" }],
    ["a non-uuid id", { id: "payment-1" }],
    ["a non-uuid userId", { userId: "user-1" }],
    ["an empty description", { description: "" }],
    ["a 141-character description", { description: "x".repeat(141) }],
    ["a non-ISO updatedAt", { updatedAt: "yesterday" }],
    ["a zero version", { version: 0 }],
    ["an empty idempotency key", { idempotencyKey: "" }],
    ["a 256-character idempotency key", { idempotencyKey: "k".repeat(256) }],
    ["an idempotency key with a space", { idempotencyKey: "a b" }],
    ["a failed payment without a reason", { status: "failed" }],
    [
      "a reason on a succeeded payment",
      { failureReason: "declined", status: "succeeded" },
    ],
    [
      "a 201-character reason",
      { failureReason: "x".repeat(201), status: "failed" },
    ],
  ])("rejects %s", (_label, override) => {
    expect(paymentSchema.safeParse({ ...valid, ...override }).success).toBe(
      false
    );
  });

  it("reports the failureReason path", () => {
    const result = paymentSchema.safeParse({ ...valid, status: "failed" });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["failureReason"],
    ]);
  });
});

describe("paymentFieldsSchema", () => {
  it("supports pick for request schemas", () => {
    const request = paymentFieldsSchema.pick({
      amount: true,
      currency: true,
      description: true,
    });
    expect(request.parse({ amount: 500, currency: "USD" })).toEqual({
      amount: 500,
      currency: "USD",
    });
  });
});
