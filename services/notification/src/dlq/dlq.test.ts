import { randomUUID } from "node:crypto";
import { createEvent, createPaymentEvent } from "@payment-be/shared";
import { DLQ_ENTRY_TYPE, dlqEntrySchema } from "./dlq.js";

const paymentEvent = () =>
  createPaymentEvent("payment.succeeded", {
    amount: 150_000,
    currency: "NGN",
    email: "ada@example.com",
    paymentId: randomUUID(),
    userId: randomUUID(),
  });

const entry = (data: Record<string, unknown> = {}) =>
  createEvent(DLQ_ENTRY_TYPE, {
    attempts: 5,
    channel: "email",
    code: "ESOCKET",
    command: "CONN",
    event: paymentEvent(),
    reason: "exhausted",
    ...data,
  });

describe("dlqEntrySchema", () => {
  it("accepts a dead-letter entry", () => {
    expect(dlqEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it("accepts an entry with only a response code", () => {
    const { code: _code, command: _command, ...data } = entry().data;
    expect(
      dlqEntrySchema.safeParse(
        createEvent(DLQ_ENTRY_TYPE, {
          ...data,
          reason: "rejected",
          responseCode: 550,
        })
      ).success
    ).toBe(true);
  });

  it.each([
    ["an unknown reason", { reason: "expired" }],
    ["a non-payment event", { event: { eventId: randomUUID(), type: "x" } }],
    ["another channel", { channel: "inapp" }],
    ["zero attempts", { attempts: 0 }],
  ])("rejects %s", (_label, data) => {
    expect(dlqEntrySchema.safeParse(entry(data)).success).toBe(false);
  });

  it("rejects another envelope type", () => {
    expect(
      dlqEntrySchema.safeParse({ ...entry(), type: "payment.succeeded" })
        .success
    ).toBe(false);
  });
});
