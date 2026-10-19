import { AppError, createMemoryRepository } from "@payment-be/shared";
import type { Payment } from "./payment.js";
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
    expect(await payments.get(payment.id)).toEqual({ ...payment, version: 1 });
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
