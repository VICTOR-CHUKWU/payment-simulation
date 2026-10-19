import { dataResponseSchema, pageResponseSchema } from "@payment-be/shared";
import { z } from "zod";
import { notificationSchema } from "./notification.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const notificationIdParamsSchema = z.object({ id: z.uuid() });

export const listNotificationsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  page: z.coerce.number().int().min(1).default(1),
  unread: z.enum(["true", "false"]).optional(),
});

export const notificationResponseSchema = notificationSchema
  .omit({ version: true })
  .meta({ id: "Notification" });

export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const notificationEnvelopeSchema = dataResponseSchema(
  notificationResponseSchema
).meta({ id: "NotificationResponse" });

export const notificationPageSchema = pageResponseSchema(
  notificationResponseSchema
).meta({ id: "NotificationPage" });

export const markAllReadEnvelopeSchema = dataResponseSchema(
  z.object({ updated: z.int().min(0) })
).meta({ id: "MarkAllReadResponse" });
