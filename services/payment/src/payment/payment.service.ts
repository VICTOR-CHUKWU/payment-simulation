import { randomUUID } from "node:crypto";
import type { Repository } from "@payment-be/shared";
import type { Payment } from "./payment.js";
import type { CreatePaymentBody, PaymentResponse } from "./payment.schema.js";

export interface PaymentOwner {
  email: string;
  userId: string;
}

export interface PaymentService {
  create: (input: {
    body: CreatePaymentBody;
    owner: PaymentOwner;
  }) => Promise<PaymentResponse>;
}

export function toPaymentResponse({
  version: _version,
  ...payment
}: Payment): PaymentResponse {
  return payment;
}

export function createPaymentService(
  payments: Repository<Payment>,
  { now = () => new Date() }: { now?: () => Date } = {}
): PaymentService {
  return {
    async create({ body, owner }) {
      const timestamp = now().toISOString();
      const payment = await payments.insert({
        ...body,
        createdAt: timestamp,
        email: owner.email,
        id: randomUUID(),
        status: "pending",
        updatedAt: timestamp,
        userId: owner.userId,
      });
      return toPaymentResponse(payment);
    },
  };
}
