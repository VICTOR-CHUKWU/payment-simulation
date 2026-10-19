import { randomUUID } from "node:crypto";
import {
  notFound,
  type Repository,
  type Role,
  unprocessable,
} from "@payment-be/shared";
import type { Payment } from "./payment.js";
import type { CreatePaymentBody, PaymentResponse } from "./payment.schema.js";

export interface PaymentOwner {
  email: string;
  userId: string;
}

export interface PaymentCaller {
  role: Role;
  userId: string;
}

export interface CreatePaymentInput {
  body: CreatePaymentBody;
  idempotencyKey?: string;
  owner: PaymentOwner;
}

export interface CreatePaymentResult {
  payment: PaymentResponse;
  replayed: boolean;
}

export interface PaymentService {
  create: (input: CreatePaymentInput) => Promise<CreatePaymentResult>;
  get: (id: string, caller: PaymentCaller) => Promise<PaymentResponse>;
}

export function toPaymentResponse({
  idempotencyKey: _idempotencyKey,
  version: _version,
  ...payment
}: Payment): PaymentResponse {
  return payment;
}

const sameRequest = (payment: Payment, body: CreatePaymentBody): boolean =>
  payment.amount === body.amount &&
  payment.currency === body.currency &&
  payment.description === body.description;

export function createPaymentService(
  payments: Repository<Payment>,
  { now = () => new Date() }: { now?: () => Date } = {}
): PaymentService {
  // The repository has no unique index on the idempotency key, so creates run
  // one at a time to stop two concurrent requests with one key both inserting.
  let queue: Promise<unknown> = Promise.resolve();

  const insert = async ({
    body,
    idempotencyKey,
    owner,
  }: CreatePaymentInput) => {
    const timestamp = now().toISOString();
    return await payments.insert({
      ...body,
      createdAt: timestamp,
      email: owner.email,
      id: randomUUID(),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      status: "pending",
      updatedAt: timestamp,
      userId: owner.userId,
    });
  };

  const createOnce = async (
    input: CreatePaymentInput
  ): Promise<CreatePaymentResult> => {
    const { body, idempotencyKey, owner } = input;
    if (idempotencyKey !== undefined) {
      const existing = await payments.findOneBy({
        idempotencyKey,
        userId: owner.userId,
      });
      if (existing) {
        if (!sameRequest(existing, body)) {
          throw unprocessable(
            "This Idempotency-Key was already used with a different request.",
            { code: "idempotency-key-reused" }
          );
        }
        return { payment: toPaymentResponse(existing), replayed: true };
      }
    }
    return { payment: toPaymentResponse(await insert(input)), replayed: false };
  };

  return {
    create(input) {
      const result = queue.then(() => createOnce(input));
      queue = result.catch(() => undefined);
      return result;
    },
    async get(id, caller) {
      const payment = await payments.get(id);
      if (
        payment === undefined ||
        (caller.role !== "admin" && payment.userId !== caller.userId)
      ) {
        throw notFound("Payment not found.", { code: "payment-not-found" });
      }
      return toPaymentResponse(payment);
    },
  };
}
