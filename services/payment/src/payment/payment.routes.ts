import { authenticate, requireRole } from "@payment-be/shared";
import express, { Router } from "express";
import type { PaymentController } from "./payment.controller.js";

export function paymentRouter(
  controller: PaymentController,
  jwtSecret: string
): Router {
  const router = Router();
  router.post(
    "/payments",
    authenticate(jwtSecret),
    express.json({ limit: "16kb" }),
    controller.create
  );
  router.get("/payments/:id", authenticate(jwtSecret), controller.get);
  router.patch(
    "/payments/:id/status",
    authenticate(jwtSecret),
    requireRole("admin"),
    express.json({ limit: "16kb" }),
    controller.updateStatus
  );
  return router;
}
