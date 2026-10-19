import {
  createMemoryRepository,
  createPaymentEvent,
  type Repository,
  VersionConflictError,
} from "@payment-be/shared";
import type { Payment, PaymentStatus } from "./payment.js";
import { transitionPayment } from "./payment.transition.js";

const ID = "3f1c2b7a-9d4e-4a51-8c6b-2e7f0a9d1b34";
const created = "2026-10-18T12:00:00.000Z";
const later = new Date("2026-10-18T13:00:00.000Z");
const now = () => later;
const data = {
  amount: 150_000,
  currency: "NGN",
  email: "ada@example.com",
  paymentId: ID,
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

async function seeded(status: PaymentStatus = "pending") {
  const payments = createMemoryRepository<Payment>();
  const stored = await payments.insert({
    amount: 150_000,
    createdAt: created,
    currency: "NGN",
    email: "ada@example.com",
    id: ID,
    status,
    updatedAt: created,
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  });
  return { payments, stored };
}

function conflicting(
  payments: Repository<Payment>,
  conflicts: number,
  beforeConflict?: () => Promise<unknown>
) {
  let calls = 0;
  const repository: Repository<Payment> = {
    ...payments,
    async update(id, expectedVersion, patch) {
      calls += 1;
      if (calls <= conflicts) {
        await beforeConflict?.();
        throw new VersionConflictError({ id });
      }
      return await payments.update(id, expectedVersion, patch);
    },
  };
  return { calls: () => calls, repository };
}

describe("transitionPayment", () => {
  it("applies an allowed change and returns the stored payment", async () => {
    const { payments } = await seeded();

    const result = await transitionPayment(payments, ID, "processing", { now });

    expect(result.from).toBe("pending");
    expect(result.payment).toMatchObject({
      status: "processing",
      updatedAt: later.toISOString(),
      version: 2,
    });
  });

  it("stores the failure reason for failed", async () => {
    const { payments } = await seeded("processing");

    const { payment } = await transitionPayment(payments, ID, "failed", {
      failureReason: "Card declined",
      now,
    });

    expect(payment).toMatchObject({
      failureReason: "Card declined",
      status: "failed",
    });
  });

  it("throws payment-not-found for an unknown id", async () => {
    const { payments } = await seeded();

    await expect(
      transitionPayment(
        payments,
        "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        "cancelled"
      )
    ).rejects.toMatchObject({ code: "payment-not-found", status: 404 });
  });

  it("throws invalid-status-transition and leaves the payment unchanged", async () => {
    const { payments, stored } = await seeded();

    await expect(
      transitionPayment(payments, ID, "succeeded", { now })
    ).rejects.toMatchObject({ code: "invalid-status-transition" });
    expect(await payments.get(ID)).toEqual(stored);
  });

  it("re-reads and succeeds after one version conflict", async () => {
    const { payments } = await seeded();
    const { calls, repository } = conflicting(payments, 1);

    const { payment } = await transitionPayment(repository, ID, "processing", {
      now,
    });

    expect(payment.status).toBe("processing");
    expect(calls()).toBe(2);
  });

  it("rethrows the version conflict after 3 attempts", async () => {
    const { payments, stored } = await seeded();
    const { calls, repository } = conflicting(payments, 3);

    await expect(
      transitionPayment(repository, ID, "processing", { now })
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(calls()).toBe(3);
    expect(await payments.get(ID)).toEqual(stored);
  });

  it("checks the transition again against the re-read status", async () => {
    const { payments, stored } = await seeded();
    const { calls, repository } = conflicting(payments, 1, () =>
      payments.update(ID, stored.version, {
        status: "cancelled",
        updatedAt: later.toISOString(),
      })
    );

    await expect(
      transitionPayment(repository, ID, "processing", { now })
    ).rejects.toMatchObject({
      code: "invalid-status-transition",
      detail: "Cannot change payment status from cancelled to processing.",
    });
    expect(calls()).toBe(1);
  });
});

describe("transitionPayment outbox", () => {
  const types = (payment: Payment | undefined) =>
    payment?.outbox?.map(({ event }) => event.type);

  it("appends one event of the new status to the existing outbox", async () => {
    const { payments } = await seeded();

    await transitionPayment(payments, ID, "processing", { now });
    const { payment } = await transitionPayment(payments, ID, "failed", {
      failureReason: "Card declined",
      now,
    });

    expect(types(payment)).toEqual(["payment.processing", "payment.failed"]);
    expect(payment.outbox?.at(-1)?.event).toMatchObject({
      data: {
        amount: 150_000,
        currency: "NGN",
        email: "ada@example.com",
        failureReason: "Card declined",
        paymentId: ID,
        userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
      type: "payment.failed",
    });
    expect(payment.outbox?.[0]?.event.data).not.toHaveProperty("failureReason");
  });

  it("uses the stored correlation ID unless one is passed", async () => {
    const { payments } = await seeded();
    await payments.update(ID, 1, { correlationId: "req-1" });

    await transitionPayment(payments, ID, "processing", { now });
    const { payment } = await transitionPayment(payments, ID, "succeeded", {
      correlationId: "req-2",
      now,
    });

    expect(payment.outbox?.map((entry) => entry.correlationId)).toEqual([
      "req-1",
      "req-2",
    ]);
    expect(payment.correlationId).toBe("req-1");
  });

  it("leaves out the correlation ID when there is none", async () => {
    const { payments } = await seeded();

    const { payment } = await transitionPayment(payments, ID, "processing", {
      now,
    });

    expect(payment.outbox?.[0]).not.toHaveProperty("correlationId");
  });

  it("adds a single event after a version-conflict retry", async () => {
    const { payments } = await seeded();
    const { repository } = conflicting(payments, 2);

    const { payment } = await transitionPayment(repository, ID, "processing", {
      now,
    });

    expect(types(payment)).toEqual(["payment.processing"]);
  });

  it("keeps an entry added by the conflicting writer", async () => {
    const { payments, stored } = await seeded();
    const { repository } = conflicting(payments, 1, () =>
      payments.update(ID, stored.version, {
        outbox: [{ event: createPaymentEvent("payment.created", data) }],
      })
    );

    const { payment } = await transitionPayment(repository, ID, "processing", {
      now,
    });

    expect(types(payment)).toEqual(["payment.created", "payment.processing"]);
  });
});
