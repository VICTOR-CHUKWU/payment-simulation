import { getAuth, sendData } from "@payment-be/shared";
import type { RequestHandler } from "express";
import {
  createPaymentBodySchema,
  idempotencyKeyHeaderSchema,
  paymentIdParamsSchema,
} from "./payment.schema.js";
import type { PaymentService } from "./payment.service.js";

export interface PaymentController {
  create: RequestHandler;
  get: RequestHandler;
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
      sendData(
        res,
        payment,
        replayed
          ? { message: "Payment already exists for this Idempotency-Key" }
          : { message: "Payment created", status: 201 }
      );
    },
    async get(req, res) {
      const { id } = paymentIdParamsSchema.parse(req.params);
      const { role, sub } = getAuth(req);
      sendData(res, await service.get(id, { role, userId: sub }));
    },
  };
}
