import { getAuth } from "@payment-be/shared";
import type { RequestHandler } from "express";
import {
  createPaymentBodySchema,
  idempotencyKeyHeaderSchema,
} from "./payment.schema.js";
import type { PaymentService } from "./payment.service.js";

export interface PaymentController {
  create: RequestHandler;
}

export function createPaymentController(
  service: PaymentService
): PaymentController {
  return {
    async create(req, res) {
      const body = createPaymentBodySchema.parse(req.body);
      const { "idempotency-key": idempotencyKey } =
        idempotencyKeyHeaderSchema.parse({
          "idempotency-key": req.get("idempotency-key"),
        });
      const { email, sub } = getAuth(req);
      const { payment, replayed } = await service.create({
        body,
        idempotencyKey,
        owner: { email, userId: sub },
      });
      req.log.info(
        { paymentId: payment.id },
        replayed ? "payment create replayed" : "payment created"
      );
      res.status(replayed ? 200 : 201).json(payment);
    },
  };
}
