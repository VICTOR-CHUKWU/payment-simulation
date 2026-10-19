import { z } from "zod";

export const CHANNELS = ["inapp", "email"] as const;

export type Channel = (typeof CHANNELS)[number];

export const inboxRecordSchema = z.strictObject({
  channel: z.enum(CHANNELS),
  eventId: z.uuid(),
  id: z.string().min(1),
  processedAt: z.iso.datetime(),
  // Not the event-type enum: records are validated on load, so a type later removed from the catalogue must still load.
  type: z.string().min(1),
  version: z.number().int().positive(),
});

export type InboxRecord = z.infer<typeof inboxRecordSchema>;

export const inboxId = (channel: Channel, eventId: string): string =>
  `${channel}:${eventId}`;
