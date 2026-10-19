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

const notificationExample = {
  amount: 150_000,
  createdAt: "2026-10-19T10:00:04.000Z",
  currency: "NGN",
  id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
  message: "Your payment of NGN 1,500.00 for Order #42 succeeded.",
  paymentId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  readAt: null,
  title: "Payment succeeded",
  type: "payment.succeeded",
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

export const notificationEnvelopeSchema = dataResponseSchema(
  notificationResponseSchema
).meta({
  example: {
    data: { ...notificationExample, readAt: "2026-10-19T10:05:00.000Z" },
    message: "Notification marked as read",
    status: 200,
    success: true,
  },
  id: "NotificationResponse",
});

export const notificationPageSchema = pageResponseSchema(
  notificationResponseSchema
).meta({
  example: {
    data: [notificationExample],
    message: null,
    meta: { limit: 20, page: 1, total: 1, totalPages: 1 },
    status: 200,
    success: true,
  },
  id: "NotificationPage",
});

export const markAllReadEnvelopeSchema = dataResponseSchema(
  z.object({ updated: z.int().min(0) })
).meta({
  example: {
    data: { updated: 3 },
    message: "Notifications marked as read",
    status: 200,
    success: true,
  },
  id: "MarkAllReadResponse",
});
