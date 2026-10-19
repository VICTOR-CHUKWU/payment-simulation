import { getAuth, sendData, sendPage } from "@payment-be/shared";
import type { RequestHandler } from "express";
import {
  listNotificationsQuerySchema,
  notificationIdParamsSchema,
} from "./notification.schema.js";
import type { NotificationService } from "./notification.service.js";

export interface NotificationController {
  list: RequestHandler;
  markAllRead: RequestHandler;
  markRead: RequestHandler;
}

export function createNotificationController(
  service: NotificationService
): NotificationController {
  return {
    async list(req, res) {
      const { limit, page, unread } = listNotificationsQuerySchema.parse(
        req.query
      );
      const { items, meta } = await service.list(getAuth(req).sub, {
        limit,
        page,
        ...(unread === undefined ? {} : { unread: unread === "true" }),
      });
      sendPage(res, items, meta);
    },
    async markAllRead(req, res) {
      const result = await service.markAllRead(getAuth(req).sub);
      req.log.info(result, "notifications marked as read");
      sendData(res, result, { message: "Notifications marked as read" });
    },
    async markRead(req, res) {
      const { id } = notificationIdParamsSchema.parse(req.params);
      const notification = await service.markRead(getAuth(req).sub, id);
      req.log.info({ notificationId: id }, "notification marked as read");
      sendData(res, notification, { message: "Notification marked as read" });
    },
  };
}
