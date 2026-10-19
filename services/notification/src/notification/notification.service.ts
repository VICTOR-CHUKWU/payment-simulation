import {
  DuplicateRecordError,
  notFound,
  type PageMeta,
  type PaymentEvent,
  type Repository,
  VersionConflictError,
} from "@payment-be/shared";
import type { Notification } from "./notification.js";
import { renderNotification } from "./notification.render.js";
import type { NotificationResponse } from "./notification.schema.js";

const MARK_READ_ATTEMPTS = 3;

export interface ListOptions {
  limit: number;
  page: number;
  unread?: boolean;
}

export interface NotificationService {
  list: (
    userId: string,
    options: ListOptions
  ) => Promise<{ items: NotificationResponse[]; meta: PageMeta }>;
  markAllRead: (userId: string) => Promise<{ updated: number }>;
  markRead: (userId: string, id: string) => Promise<NotificationResponse>;
  record: (event: PaymentEvent) => Promise<void>;
}

export const notificationNotFound = () =>
  notFound("Notification not found.", { code: "notification-not-found" });

export function toNotificationResponse({
  version: _version,
  ...notification
}: Notification): NotificationResponse {
  return notification;
}

const newestFirst = (a: Notification, b: Notification) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1);

export function createNotificationService(
  notifications: Repository<Notification>,
  { now = () => new Date() }: { now?: () => Date } = {}
): NotificationService {
  const markOne = async (
    userId: string,
    id: string
  ): Promise<{ changed: boolean; notification: Notification }> => {
    for (let attempt = 1; ; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: attempts must run in sequence
      const current = await notifications.get(id);
      if (current === undefined || current.userId !== userId) {
        throw notificationNotFound();
      }
      if (current.readAt !== null) {
        return { changed: false, notification: current };
      }
      try {
        const notification = await notifications.update(id, current.version, {
          readAt: now().toISOString(),
        });
        return { changed: true, notification };
      } catch (error) {
        if (
          !(error instanceof VersionConflictError) ||
          attempt === MARK_READ_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  };

  return {
    async list(userId, { limit, page, unread }) {
      const owned = await notifications.find(
        (notification) =>
          notification.userId === userId &&
          (unread === undefined || (notification.readAt === null) === unread)
      );
      const start = (page - 1) * limit;
      return {
        items: owned
          .sort(newestFirst)
          .slice(start, start + limit)
          .map(toNotificationResponse),
        meta: {
          limit,
          page,
          total: owned.length,
          totalPages: Math.ceil(owned.length / limit),
        },
      };
    },
    async markAllRead(userId) {
      const unread = await notifications.find(
        (notification) =>
          notification.userId === userId && notification.readAt === null
      );
      const results = await Promise.all(
        unread.map((notification) => markOne(userId, notification.id))
      );
      return { updated: results.filter(({ changed }) => changed).length };
    },
    async markRead(userId, id) {
      const { notification } = await markOne(userId, id);
      return toNotificationResponse(notification);
    },
    async record(event) {
      const rendered = renderNotification(event);
      if (rendered === undefined) {
        return;
      }
      const { amount, currency, paymentId, userId } = event.data;
      try {
        await notifications.insert({
          amount,
          createdAt: event.occurredAt,
          currency,
          id: event.eventId,
          paymentId,
          readAt: null,
          type: event.type,
          userId,
          ...rendered,
        });
      } catch (error) {
        // An earlier run stored it but stopped before the inbox marker was written.
        if (!(error instanceof DuplicateRecordError)) {
          throw error;
        }
      }
    },
  };
}
