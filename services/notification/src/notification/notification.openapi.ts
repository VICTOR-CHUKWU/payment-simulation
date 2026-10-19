import {
  bearerSecurity,
  type OpenAPIRegistry,
  problemResponses,
} from "@payment-be/shared";
import type { z } from "zod";
import {
  listNotificationsQuerySchema,
  markAllReadEnvelopeSchema,
  notificationEnvelopeSchema,
  notificationIdParamsSchema,
  notificationPageSchema,
} from "./notification.schema.js";

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

export function registerNotificationPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    description:
      "Lists the caller's in-app notifications, newest first. Every role, admin included, sees only its own. `unread=true` returns only unread notifications and `unread=false` only read ones; leave it out for both. Unknown query parameters return `400`.",
    method: "get",
    path: "/notifications",
    request: { query: listNotificationsQuerySchema },
    responses: {
      200: {
        content: json(notificationPageSchema),
        description: "A page of notifications",
      },
      ...problemResponses(400, 401),
    },
    security: bearerSecurity,
    summary: "List notifications",
    tags: ["notifications"],
  });
  registry.registerPath({
    description:
      "Marks all of the caller's unread notifications as read. `updated` is how many this request changed.",
    method: "patch",
    path: "/notifications/read",
    responses: {
      200: {
        content: json(markAllReadEnvelopeSchema),
        description: "How many notifications were marked as read",
      },
      ...problemResponses(401),
    },
    security: bearerSecurity,
    summary: "Mark all notifications as read",
    tags: ["notifications"],
  });
  registry.registerPath({
    description:
      "Marks one of the caller's notifications as read. Marking an already-read notification returns it unchanged, keeping its first `readAt`. Another user's notification returns the same `404` as an unknown ID.",
    method: "patch",
    path: "/notifications/{id}/read",
    request: { params: notificationIdParamsSchema },
    responses: {
      200: {
        content: json(notificationEnvelopeSchema),
        description: "The notification, marked as read",
      },
      ...problemResponses(400, 401, 404),
    },
    security: bearerSecurity,
    summary: "Mark notification as read",
    tags: ["notifications"],
  });
}
