import type { PaymentEventType } from "@payment-be/shared";
import { z } from "zod";

export const NOTIFIED_TYPES = [
  "payment.created",
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
] as const satisfies readonly PaymentEventType[];

export type NotifiedType = (typeof NOTIFIED_TYPES)[number];

export const notificationSchema = z.strictObject({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Must be an ISO 4217 code"),
  id: z.uuid(),
  message: z.string().min(1),
  paymentId: z.uuid(),
  readAt: z.iso.datetime().nullable(),
  title: z.string().min(1),
  // Not the event-type enum: records are validated on load, so a type later removed from the catalogue must still load.
  type: z.string().min(1),
  userId: z.uuid(),
  version: z.number().int().positive(),
});

export type Notification = z.infer<typeof notificationSchema>;
