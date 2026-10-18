import { randomUUID } from "node:crypto";
import { z } from "zod";

export interface EventEnvelope<T> {
  data: T;
  eventId: string;
  occurredAt: string;
  type: string;
}

export function eventEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    eventId: z.uuid(),
    occurredAt: z.iso.datetime(),
    type: z.string().min(1),
  });
}

export function createEvent<T>(type: string, data: T): EventEnvelope<T> {
  return {
    data,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type,
  };
}
