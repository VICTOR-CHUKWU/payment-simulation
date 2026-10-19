import { randomUUID } from "node:crypto";
import { type Repository, type Role, unprocessable } from "@payment-be/shared";
import type { Payment, PaymentStatus } from "./payment.js";
import { outboxEntry } from "./payment.outbox.js";
import type {
  CreatePaymentBody,
  PaymentResponse,
  UpdatePaymentStatusBody,
} from "./payment.schema.js";
import { paymentNotFound, transitionPayment } from "./payment.transition.js";

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
  correlationId?: string;
  idempotencyKey?: string;
  owner: PaymentOwner;
}

export interface CreatePaymentResult {
  payment: PaymentResponse;
  replayed: boolean;
}

export interface StatusUpdateResult {
  from: PaymentStatus;
  payment: PaymentResponse;
}

export interface PaymentService {
  create: (input: CreatePaymentInput) => Promise<CreatePaymentResult>;
  get: (id: string, caller: PaymentCaller) => Promise<PaymentResponse>;
  updateStatus: (
    id: string,
    update: UpdatePaymentStatusBody,
    options?: { correlationId?: string }
  ) => Promise<StatusUpdateResult>;
}

export function toPaymentResponse({
  correlationId: _correlationId,
  idempotencyKey: _idempotencyKey,
  outbox: _outbox,
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
  {
    now = () => new Date(),
    onOutbox = () => undefined,
  }: { now?: () => Date; onOutbox?: () => void } = {}
): PaymentService {
  // The repository has no unique index on the idempotency key, so creates run
  // one at a time to stop two concurrent requests with one key both inserting.
  let queue: Promise<unknown> = Promise.resolve();

  const insert = async ({
    body,
    correlationId,
    idempotencyKey,
    owner,
  }: CreatePaymentInput) => {
    const timestamp = now().toISOString();
    const record = {
      ...body,
      createdAt: timestamp,
      email: owner.email,
      id: randomUUID(),
      status: "pending" as const,
      updatedAt: timestamp,
      userId: owner.userId,
    };
    return await payments.insert({
      ...record,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      outbox: [outboxEntry(record, correlationId)],
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
    const payment = await insert(input);
    onOutbox();
    return { payment: toPaymentResponse(payment), replayed: false };
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
        throw paymentNotFound();
      }
      return toPaymentResponse(payment);
    },
    async updateStatus(id, { failureReason, status }, { correlationId } = {}) {
      const { from, payment } = await transitionPayment(payments, id, status, {
        correlationId,
        failureReason,
        now,
      });
      onOutbox();
      return { from, payment: toPaymentResponse(payment) };
    },
  };
}
