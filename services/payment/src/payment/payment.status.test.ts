import { AppError } from "@payment-be/shared";
import { type PaymentStatus, paymentSchema } from "./payment.js";
import {
  assertTransition,
  canTransition,
  isTerminal,
  statusChange,
} from "./payment.status.js";

const STATUSES: PaymentStatus[] = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
];

const ALLOWED = new Set([
  "pending>processing",
  "pending>cancelled",
  "processing>succeeded",
  "processing>failed",
]);

const pairs = STATUSES.flatMap((from) =>
  STATUSES.map((to) => [from, to] as const)
);

const allowedPairs = pairs.filter(([from, to]) => ALLOWED.has(`${from}>${to}`));
const rejectedPairs = pairs.filter(
  ([from, to]) => !ALLOWED.has(`${from}>${to}`)
);

const now = new Date("2026-10-18T13:00:00.000Z");

const payment = {
  amount: 150_000,
  createdAt: "2026-10-18T12:00:00.000Z",
  currency: "NGN",
  email: "ada@example.com",
  id: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
  status: "pending",
  updatedAt: "2026-10-18T12:00:00.000Z",
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  version: 1,
} as const;

function reasonFor(to: PaymentStatus): { failureReason?: string } {
  return to === "failed" ? { failureReason: "declined" } : {};
}

describe("canTransition", () => {
  it.each(pairs)("%s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED.has(`${from}>${to}`));
  });
});

describe("isTerminal", () => {
  it.each([
    ["pending", false],
    ["processing", false],
    ["succeeded", true],
    ["failed", true],
    ["cancelled", true],
  ] as const)("%s is terminal: %s", (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});

describe("assertTransition", () => {
  it.each(allowedPairs)("allows %s -> %s", (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(rejectedPairs)("rejects %s -> %s with a 409", (from, to) => {
    let error: unknown;
    try {
      assertTransition(from, to);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "invalid-status-transition",
      detail: `Cannot change payment status from ${from} to ${to}.`,
      status: 409,
      type: "tag:payment-be,2026:invalid-status-transition",
    });
  });
});

describe("statusChange", () => {
  it.each(allowedPairs)("builds the patch for %s -> %s", (from, to) => {
    const patch = statusChange({ status: from }, to, {
      ...reasonFor(to),
      now,
    });
    expect(patch).toEqual({
      status: to,
      updatedAt: "2026-10-18T13:00:00.000Z",
      ...reasonFor(to),
    });
  });

  it.each(allowedPairs)("keeps the record valid for %s -> %s", (from, to) => {
    const record = { ...payment, status: from };
    const patch = statusChange(record, to, { ...reasonFor(to), now });
    expect(paymentSchema.safeParse({ ...record, ...patch }).success).toBe(true);
  });

  it("defaults updatedAt to the current time", () => {
    const before = Date.now();
    const patch = statusChange({ status: "pending" }, "processing");
    const updatedAt = Date.parse(patch.updatedAt ?? "");
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it("requires a reason when the payment fails", () => {
    expect(() => statusChange({ status: "processing" }, "failed")).toThrow(
      "failureReason is required"
    );
  });

  it("rejects a reason for any other status", () => {
    expect(() =>
      statusChange({ status: "processing" }, "succeeded", {
        failureReason: "declined",
      })
    ).toThrow("failureReason is only allowed");
  });

  it.each([
    ["an empty", ""],
    ["a 201-character", "x".repeat(201)],
  ])("rejects %s reason", (_label, failureReason) => {
    expect(() =>
      statusChange({ status: "processing" }, "failed", { failureReason })
    ).toThrow();
  });

  it("rejects a disallowed transition", () => {
    expect(() => statusChange({ status: "succeeded" }, "pending")).toThrow(
      AppError
    );
  });
});
