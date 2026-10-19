import { authenticate, requireRole } from "@payment-be/shared";
import { Router } from "express";
import type { DlqController } from "./dlq.controller.js";

export function dlqRouter(
  controller: DlqController,
  jwtSecret: string
): Router {
  const router = Router();
  const admin = [authenticate(jwtSecret), requireRole("admin")];
  router.get("/admin/dlq", ...admin, controller.list);
  router.get("/admin/dlq/:seq", ...admin, controller.get);
  router.post("/admin/dlq/:seq/replay", ...admin, controller.replay);
  return router;
}
