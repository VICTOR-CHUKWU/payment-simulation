import {
  dataResponseSchema,
  pageResponseSchema,
  paymentEventSchema,
} from "@payment-be/shared";
import { z } from "zod";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const dlqSeqParamsSchema = z.object({
  seq: z.coerce.number().int().min(1),
});

export const listDlqQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  page: z.coerce.number().int().min(1).default(1),
});

export const dlqItemSchema = z
  .object({
    attempts: z.int().positive(),
    code: z.string().optional(),
    command: z.string().optional(),
    deadLetteredAt: z.iso.datetime(),
    event: paymentEventSchema,
    reason: z.enum(["exhausted", "rejected"]),
    responseCode: z.int().optional(),
    seq: z.int().positive(),
  })
  .meta({ id: "DlqEntry" });

export type DlqItem = z.infer<typeof dlqItemSchema>;

export const dlqEntryEnvelopeSchema = dataResponseSchema(dlqItemSchema).meta({
  id: "DlqEntryResponse",
});

export const dlqPageSchema = pageResponseSchema(dlqItemSchema).meta({
  id: "DlqEntryPage",
});

export const replayEnvelopeSchema = dataResponseSchema(
  z.object({ eventId: z.uuid(), seq: z.int().positive() })
).meta({ id: "DlqReplayResponse" });
