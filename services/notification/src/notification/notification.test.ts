import { randomUUID } from "node:crypto";
import { notificationSchema } from "./notification.js";

const valid = {
  amount: 150_000,
  createdAt: "2026-10-19T10:00:00.000Z",
  currency: "NGN",
  id: randomUUID(),
  message: "Your payment of NGN 1,500.00 succeeded.",
  paymentId: randomUUID(),
  readAt: null,
  title: "Payment succeeded",
  type: "payment.succeeded",
  userId: randomUUID(),
  version: 1,
};

describe("notificationSchema", () => {
  it("accepts an unread record", () => {
    expect(notificationSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a read record", () => {
    expect(
      notificationSchema.safeParse({
        ...valid,
        readAt: "2026-10-19T11:00:00.000Z",
      }).success
    ).toBe(true);
  });

  it.each([
    ["an unknown key", { email: "ada@example.com" }],
    ["a non-integer amount", { amount: 1.5 }],
    ["a non-UUID userId", { userId: "user-1" }],
  ])("rejects %s", (_label, change) => {
    expect(notificationSchema.safeParse({ ...valid, ...change }).success).toBe(
      false
    );
  });
});
