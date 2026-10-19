import {
  AppError,
  createMemoryRepository,
  type Repository,
  VersionConflictError,
} from "@payment-be/shared";
import type { Payment, PaymentStatus } from "./payment.js";
import { createPaymentService } from "./payment.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const owner = {
  email: "ada@example.com",
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

const other = {
  email: "bob@example.com",
  userId: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
};

const now = () => new Date("2026-10-18T12:00:00.000Z");

const body = {
  amount: 150_000,
  currency: "NGN",
  description: "Order #42",
} as const;

function setup() {
  const payments = createMemoryRepository<Payment>();
  return { payments, service: createPaymentService(payments, { now }) };
}

describe("createPaymentService.create", () => {
  it("stores a pending payment owned by the caller", async () => {
    const { payments, service } = setup();

    const { payment, replayed } = await service.create({ body, owner });

    expect(replayed).toBe(false);
    expect(payment).toEqual({
      amount: 150_000,
      createdAt: "2026-10-18T12:00:00.000Z",
      currency: "NGN",
      description: "Order #42",
      email: owner.email,
      id: expect.stringMatching(UUID),
      status: "pending",
      updatedAt: "2026-10-18T12:00:00.000Z",
      userId: owner.userId,
    });
    expect(await payments.get(payment.id)).toEqual({
      ...payment,
      outbox: [
        {
          event: expect.objectContaining({
            data: {
              amount: 150_000,
              currency: "NGN",
              description: "Order #42",
              email: owner.email,
              paymentId: payment.id,
              userId: owner.userId,
            },
            type: "payment.created",
          }),
        },
      ],
      version: 1,
    });
  });

  it("leaves out description when none is given", async () => {
    const { service } = setup();

    const { payment } = await service.create({
      body: { amount: 500, currency: "USD" },
      owner,
    });

    expect(payment).not.toHaveProperty("description");
  });

  it("gives each payment its own id without a key", async () => {
    const { payments, service } = setup();

    const first = await service.create({ body, owner });
    const second = await service.create({ body, owner });

    expect(first.payment.id).not.toBe(second.payment.id);
    expect(await payments.find()).toHaveLength(2);
  });
});

describe("createPaymentService.create with an idempotency key", () => {
  const idempotencyKey = "order-42";

  it("stores the key on the payment but leaves it out of the response", async () => {
    const { payments, service } = setup();

    const { payment } = await service.create({ body, idempotencyKey, owner });

    expect(payment).not.toHaveProperty("idempotencyKey");
    expect(payment).not.toHaveProperty("version");
    expect(await payments.get(payment.id)).toMatchObject({ idempotencyKey });
  });

  it("replays the first payment for the same key and body", async () => {
    const { payments, service } = setup();

    const first = await service.create({ body, idempotencyKey, owner });
    const second = await service.create({ body, idempotencyKey, owner });

    expect(second).toEqual({ payment: first.payment, replayed: true });
    expect(await payments.find()).toHaveLength(1);
  });

  it("replays the payment in its current state", async () => {
    const { payments, service } = setup();
    const first = await service.create({ body, idempotencyKey, owner });
    await payments.update(first.payment.id, 1, { status: "processing" });

    const second = await service.create({ body, idempotencyKey, owner });

    expect(second.replayed).toBe(true);
    expect(second.payment.status).toBe("processing");
  });

  it.each([
    ["a different amount", { ...body, amount: 1 }],
    ["a different currency", { ...body, currency: "USD" }],
    ["a different description", { ...body, description: "Order #43" }],
    ["a dropped description", { amount: body.amount, currency: body.currency }],
  ] as const)("rejects the key reused with %s", async (_label, changed) => {
    const { payments, service } = setup();
    await service.create({ body, idempotencyKey, owner });

    const result = service.create({ body: changed, idempotencyKey, owner });

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({
      code: "idempotency-key-reused",
      status: 422,
    });
    expect(await payments.find()).toHaveLength(1);
  });

  it("rejects a description added on reuse", async () => {
    const { service } = setup();
    const plain = { amount: 500, currency: "USD" } as const;
    await service.create({ body: plain, idempotencyKey, owner });

    await expect(
      service.create({
        body: { ...plain, description: "Late" },
        idempotencyKey,
        owner,
      })
    ).rejects.toMatchObject({ code: "idempotency-key-reused" });
  });

  it("matches a replay without a description", async () => {
    const { service } = setup();
    const plain = { amount: 500, currency: "USD" } as const;
    await service.create({ body: plain, idempotencyKey, owner });

    const second = await service.create({ body: plain, idempotencyKey, owner });

    expect(second.replayed).toBe(true);
  });

  it("scopes keys to the owner", async () => {
    const { payments, service } = setup();

    const mine = await service.create({ body, idempotencyKey, owner });
    const theirs = await service.create({
      body,
      idempotencyKey,
      owner: other,
    });

    expect(theirs.replayed).toBe(false);
    expect(theirs.payment.id).not.toBe(mine.payment.id);
    expect(theirs.payment.userId).toBe(other.userId);
    expect(await payments.find()).toHaveLength(2);
  });

  it("does not match payments created without a key", async () => {
    const { service } = setup();
    await service.create({ body, owner });

    const keyed = await service.create({ body, idempotencyKey, owner });

    expect(keyed.replayed).toBe(false);
  });

  it("creates one payment for concurrent requests with one key", async () => {
    const { payments, service } = setup();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.create({ body, idempotencyKey, owner })
      )
    );

    expect(await payments.find()).toHaveLength(1);
    expect(new Set(results.map(({ payment }) => payment.id)).size).toBe(1);
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
  });

  it("keeps serving creates after one fails", async () => {
    const { service } = setup();
    await service.create({ body, idempotencyKey, owner });

    const [failed, next] = await Promise.allSettled([
      service.create({ body: { ...body, amount: 1 }, idempotencyKey, owner }),
      service.create({ body, owner }),
    ]);

    expect(failed.status).toBe("rejected");
    expect(next.status).toBe("fulfilled");
  });
});

describe("createPaymentService.get", () => {
  async function stored() {
    const ctx = setup();
    const { payment } = await ctx.service.create({
      body,
      idempotencyKey: "key-1",
      owner,
    });
    return { ...ctx, payment };
  }

  it("returns the caller's own payment without internal fields", async () => {
    const { payment, service } = await stored();

    const found = await service.get(payment.id, {
      role: "user",
      userId: owner.userId,
    });

    expect(found).toEqual(payment);
    expect(found).not.toHaveProperty("version");
    expect(found).not.toHaveProperty("idempotencyKey");
  });

  it("returns another user's payment to an admin", async () => {
    const { payment, service } = await stored();

    const found = await service.get(payment.id, {
      role: "admin",
      userId: other.userId,
    });

    expect(found).toEqual(payment);
  });

  it.each([
    ["another user's payment", true],
    ["an unknown ID", false],
  ])("throws payment-not-found for %s", async (_label, exists) => {
    const { payment, service } = await stored();
    const id = exists ? payment.id : "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    const error = await service
      .get(id, { role: "user", userId: other.userId })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "payment-not-found", status: 404 });
  });
});

describe("createPaymentService.updateStatus", () => {
  const later = new Date("2026-10-18T13:00:00.000Z");

  async function seeded(status: PaymentStatus = "pending") {
    const payments = createMemoryRepository<Payment>();
    const stored = await payments.insert({
      ...body,
      createdAt: now().toISOString(),
      email: owner.email,
      id: "3f1c2b7a-9d4e-4a51-8c6b-2e7f0a9d1b34",
      idempotencyKey: "order-42",
      status,
      ...(status === "failed" ? { failureReason: "Declined" } : {}),
      updatedAt: now().toISOString(),
      userId: owner.userId,
    });
    const service = createPaymentService(payments, { now: () => later });
    return { payments, service, stored };
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

  it.each([
    ["pending", "cancelled"],
    ["processing", "succeeded"],
  ] as const)("changes %s to %s", async (from, to) => {
    const { payments, service, stored } = await seeded(from);

    const result = await service.updateStatus(stored.id, { status: to });

    expect(result.from).toBe(from);
    expect(result.payment).toMatchObject({
      status: to,
      updatedAt: later.toISOString(),
    });
    expect(result.payment).not.toHaveProperty("version");
    expect(result.payment).not.toHaveProperty("idempotencyKey");
    expect(await payments.get(stored.id)).toMatchObject({
      status: to,
      version: 2,
    });
  });

  it("stores the failure reason when marking a payment failed", async () => {
    const { payments, service, stored } = await seeded("processing");

    const { payment } = await service.updateStatus(stored.id, {
      failureReason: "Card declined",
      status: "failed",
    });

    expect(payment).toMatchObject({
      failureReason: "Card declined",
      status: "failed",
    });
    expect(payment.updatedAt).toBe(later.toISOString());
    expect(await payments.get(stored.id)).toMatchObject({
      failureReason: "Card declined",
      version: 2,
    });
  });

  it.each([
    ["pending", "succeeded"],
    ["succeeded", "cancelled"],
    ["cancelled", "cancelled"],
  ] as const)(
    "rejects %s to %s and leaves the payment unchanged",
    async (from, to) => {
      const { payments, service, stored } = await seeded(from);

      await expect(
        service.updateStatus(stored.id, { status: to })
      ).rejects.toMatchObject({
        code: "invalid-status-transition",
        status: 409,
      });
      expect(await payments.get(stored.id)).toEqual(stored);
    }
  );

  it("throws payment-not-found for an unknown id", async () => {
    const { service } = await seeded();

    await expect(
      service.updateStatus("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", {
        status: "cancelled",
      })
    ).rejects.toMatchObject({ code: "payment-not-found", status: 404 });
  });

  it("re-reads and succeeds after a version conflict", async () => {
    const { payments, stored } = await seeded();
    const { calls, repository } = conflicting(payments, 1);
    const service = createPaymentService(repository, { now: () => later });

    const { payment } = await service.updateStatus(stored.id, {
      status: "cancelled",
    });

    expect(payment.status).toBe("cancelled");
    expect(calls()).toBe(2);
  });

  it("gives up with version-conflict after 3 attempts", async () => {
    const { payments, stored } = await seeded();
    const { calls, repository } = conflicting(payments, 3);
    const service = createPaymentService(repository, { now: () => later });

    const result = service.updateStatus(stored.id, { status: "cancelled" });

    await expect(result).rejects.toBeInstanceOf(VersionConflictError);
    expect(calls()).toBe(3);
    expect(await payments.get(stored.id)).toEqual(stored);
  });

  it("reports the real status when another writer finished the payment first", async () => {
    const { payments, stored } = await seeded("processing");
    const { calls, repository } = conflicting(payments, 1, () =>
      payments.update(stored.id, stored.version, {
        status: "succeeded",
        updatedAt: later.toISOString(),
      })
    );
    const service = createPaymentService(repository, { now: () => later });

    await expect(
      service.updateStatus(stored.id, {
        failureReason: "Timed out",
        status: "failed",
      })
    ).rejects.toMatchObject({
      code: "invalid-status-transition",
      detail: "Cannot change payment status from succeeded to failed.",
    });
    expect(calls()).toBe(1);
    expect(await payments.get(stored.id)).toMatchObject({
      status: "succeeded",
    });
  });
});

describe("createPaymentService outbox", () => {
  function counted() {
    const payments = createMemoryRepository<Payment>();
    let kicks = 0;
    const service = createPaymentService(payments, {
      now,
      onOutbox: () => {
        kicks += 1;
      },
    });
    return { kicks: () => kicks, payments, service };
  }

  it("stores the correlation ID with the created event and kicks the relay", async () => {
    const { kicks, payments, service } = counted();

    const { payment } = await service.create({
      body,
      correlationId: "req-1",
      owner,
    });

    const stored = await payments.get(payment.id);
    expect(stored?.correlationId).toBe("req-1");
    expect(stored?.outbox).toEqual([
      {
        correlationId: "req-1",
        event: expect.objectContaining({ type: "payment.created" }),
      },
    ]);
    expect(payment).not.toHaveProperty("correlationId");
    expect(payment).not.toHaveProperty("outbox");
    expect(kicks()).toBe(1);
  });

  it("adds no event and does not kick on a replay", async () => {
    const { kicks, payments, service } = counted();
    const first = await service.create({ body, idempotencyKey: "k", owner });

    await service.create({ body, idempotencyKey: "k", owner });

    expect((await payments.get(first.payment.id))?.outbox).toHaveLength(1);
    expect(kicks()).toBe(1);
  });

  it("passes the request's correlation ID to the status change", async () => {
    const { kicks, payments, service } = counted();
    const { payment } = await service.create({
      body,
      correlationId: "req-1",
      owner,
    });

    await service.updateStatus(
      payment.id,
      { status: "cancelled" },
      { correlationId: "req-2" }
    );

    const stored = await payments.get(payment.id);
    expect(stored?.correlationId).toBe("req-1");
    expect(stored?.outbox?.at(-1)).toEqual({
      correlationId: "req-2",
      event: expect.objectContaining({ type: "payment.cancelled" }),
    });
    expect(kicks()).toBe(2);
  });

  it("does not kick when the status change fails", async () => {
    const { kicks, service } = counted();
    const { payment } = await service.create({ body, owner });

    await expect(
      service.updateStatus(payment.id, { status: "succeeded" })
    ).rejects.toMatchObject({ code: "invalid-status-transition" });
    expect(kicks()).toBe(1);
  });
});
