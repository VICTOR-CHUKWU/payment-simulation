import {
  bearerSecurity,
  type OpenAPIRegistry,
  problemResponses,
} from "@payment-be/shared";
import type { z } from "zod";
import {
  dlqEntryEnvelopeSchema,
  dlqPageSchema,
  dlqSeqParamsSchema,
  listDlqQuerySchema,
  replayEnvelopeSchema,
} from "./dlq.schema.js";

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

export function registerDlqPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    description:
      "Lists dead-lettered emails, newest first. Admins only. An email is dead-lettered when every retry failed (`reason: exhausted`) or the SMTP server rejected it permanently (`reason: rejected`). Each entry holds the original payment event, including the recipient's address.",
    method: "get",
    path: "/admin/dlq",
    request: { query: listDlqQuerySchema },
    responses: {
      200: { content: json(dlqPageSchema), description: "A page of entries" },
      ...problemResponses(400, 401, 403),
    },
    security: bearerSecurity,
    summary: "List dead-lettered emails",
    tags: ["admin"],
  });
  registry.registerPath({
    description:
      "Returns one dead-lettered email by its DLQ stream sequence number. Admins only.",
    method: "get",
    path: "/admin/dlq/{seq}",
    request: { params: dlqSeqParamsSchema },
    responses: {
      200: { content: json(dlqEntryEnvelopeSchema), description: "The entry" },
      ...problemResponses(400, 401, 403, 404),
    },
    security: bearerSecurity,
    summary: "Get dead-lettered email",
    tags: ["admin"],
  });
  registry.registerPath({
    description:
      "Sends a dead-lettered email again, now, and deletes the entry once it is sent. Admins only. If the SMTP server still refuses it, the request returns `502 email-send-failed` with the error code in `detail` and the entry stays. A second replay of the same entry while one is running returns `409 replay-in-progress`.",
    method: "post",
    path: "/admin/dlq/{seq}/replay",
    request: { params: dlqSeqParamsSchema },
    responses: {
      200: {
        content: json(replayEnvelopeSchema),
        description: "The email was sent and the entry deleted",
      },
      ...problemResponses(400, 401, 403, 404, 409, 500, 502),
    },
    security: bearerSecurity,
    summary: "Replay dead-lettered email",
    tags: ["admin"],
  });
}
