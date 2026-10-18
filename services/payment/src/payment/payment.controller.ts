import { getAuth } from "@payment-be/shared";
import type { RequestHandler } from "express";
import { createPaymentBodySchema } from "./payment.schema.js";
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
      const { email, sub } = getAuth(req);
      const payment = await service.create({
        body,
        owner: { email, userId: sub },
      });
      req.log.info({ paymentId: payment.id }, "payment created");
      res.status(201).json(payment);
    },
  };
}
