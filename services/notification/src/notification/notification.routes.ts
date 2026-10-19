import { authenticate } from "@payment-be/shared";
import { Router } from "express";
import type { NotificationController } from "./notification.controller.js";

export function notificationRouter(
  controller: NotificationController,
  jwtSecret: string
): Router {
  const router = Router();
  router.get("/notifications", authenticate(jwtSecret), controller.list);
  router.patch(
    "/notifications/read",
    authenticate(jwtSecret),
    controller.markAllRead
  );
  router.patch(
    "/notifications/:id/read",
    authenticate(jwtSecret),
    controller.markRead
  );
  return router;
}
