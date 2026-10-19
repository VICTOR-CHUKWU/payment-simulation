import {
  createEvent,
  type JetStreamClient,
  publishEvent,
} from "@payment-be/shared";
import type { DeadLetter } from "../email/index.js";
import { DLQ_EMAIL_SUBJECT, DLQ_ENTRY_TYPE } from "./dlq.js";

export function createDeadLetterPublisher(
  js: Pick<JetStreamClient, "publish">
): DeadLetter {
  return async (fields, correlationId) => {
    const entry = createEvent(DLQ_ENTRY_TYPE, { channel: "email", ...fields });
    const { seq } = await publishEvent(js, DLQ_EMAIL_SUBJECT, entry, {
      correlationId,
    });
    return { seq };
  };
}
