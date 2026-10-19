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

const dlqItemExample = {
  attempts: 5,
  code: "ESOCKET",
  command: "CONN",
  deadLetteredAt: "2026-10-19T10:13:00.000Z",
  event: {
    data: {
      amount: 150_000,
      currency: "NGN",
      description: "Order #42",
      email: "user@example.com",
      paymentId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    },
    eventId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    occurredAt: "2026-10-19T10:00:04.000Z",
    type: "payment.succeeded",
  },
  reason: "exhausted",
  seq: 1,
};

export const dlqEntryEnvelopeSchema = dataResponseSchema(dlqItemSchema).meta({
  example: { data: dlqItemExample, message: null, status: 200, success: true },
  id: "DlqEntryResponse",
});

export const dlqPageSchema = pageResponseSchema(dlqItemSchema).meta({
  example: {
    data: [dlqItemExample],
    message: null,
    meta: { limit: 20, page: 1, total: 1, totalPages: 1 },
    status: 200,
    success: true,
  },
  id: "DlqEntryPage",
});

export const replayEnvelopeSchema = dataResponseSchema(
  z.object({ eventId: z.uuid(), seq: z.int().positive() })
).meta({
  example: {
    data: { eventId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", seq: 1 },
    message: "Email sent",
    status: 200,
    success: true,
  },
  id: "DlqReplayResponse",
});
