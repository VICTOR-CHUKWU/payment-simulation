import { eventEnvelopeSchema, paymentEventSchema } from "@payment-be/shared";
import { z } from "zod";

export const DLQ_ENTRY_TYPE = "notification.email.dead-lettered";

export const DLQ_EMAIL_SUBJECT = "dlq.email";

export const dlqEntryDataSchema = z.strictObject({
  attempts: z.number().int().positive(),
  channel: z.literal("email"),
  code: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  event: paymentEventSchema,
  reason: z.enum(["exhausted", "rejected"]),
  responseCode: z.number().int().optional(),
});

export const dlqEntrySchema = eventEnvelopeSchema(dlqEntryDataSchema).extend({
  type: z.literal(DLQ_ENTRY_TYPE),
});

export type DlqEntry = z.infer<typeof dlqEntrySchema>;
