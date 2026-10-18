import { createMemoryRepository } from "@payment-be/shared";
import type { Payment } from "./payment.js";
import { createPaymentService } from "./payment.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const owner = {
  email: "ada@example.com",
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

const now = () => new Date("2026-10-18T12:00:00.000Z");

function setup() {
  const payments = createMemoryRepository<Payment>();
  return { payments, service: createPaymentService(payments, { now }) };
}

describe("createPaymentService.create", () => {
  it("stores a pending payment owned by the caller", async () => {
    const { payments, service } = setup();

    const payment = await service.create({
      body: { amount: 150_000, currency: "NGN", description: "Order #42" },
      owner,
    });

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

    const payment = await service.create({
      body: { amount: 500, currency: "USD" },
      owner,
    });

    expect(payment).not.toHaveProperty("description");
  });

  it("gives each payment its own id", async () => {
    const { service } = setup();
    const body = { amount: 500, currency: "USD" } as const;

    const first = await service.create({ body, owner });
    const second = await service.create({ body, owner });

    expect(first.id).not.toBe(second.id);
  });
});
