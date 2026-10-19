import {
  decodeEvent,
  type EventMessage,
  type Logger,
  type PaymentEvent,
  paymentEventSchema,
} from "@payment-be/shared";
import { ZodError } from "zod";
import type { Channel } from "./consumer.config.js";

export interface ConsumerMessage extends EventMessage {
  ack: () => void;
  nak: () => void;
  seq: number;
  subject: string;
  term: (reason?: string) => void;
}

export interface EventHandlerOptions {
  channel: Channel;
  logger: Logger;
  onEvent?: (event: PaymentEvent, logger: Logger) => Promise<void>;
}

// The raw input is never logged: JSON errors quote it and it carries the email.
const invalidReason = (err: unknown) =>
  err instanceof ZodError
    ? {
        issues: err.issues.map((issue) => issue.path.join(".")),
        reason: "schema",
      }
    : { reason: "json" };

export function createEventHandler({
  channel,
  logger,
  onEvent = () => Promise.resolve(),
}: EventHandlerOptions): (msg: ConsumerMessage) => Promise<void> {
  return async (msg) => {
    let decoded: ReturnType<typeof decodeEvent<typeof paymentEventSchema>>;
    try {
      decoded = decodeEvent(msg, paymentEventSchema);
    } catch (err) {
      logger.warn(
        { channel, seq: msg.seq, subject: msg.subject, ...invalidReason(err) },
        "invalid event terminated"
      );
      msg.term();
      return;
    }
    const { correlationId, event } = decoded;
    const log = logger.child({
      correlationId,
      eventId: event.eventId,
      userId: event.data.userId,
    });
    try {
      log.info(
        { channel, paymentId: event.data.paymentId, type: event.type },
        "event received"
      );
      await onEvent(event, log);
      msg.ack();
    } catch (err) {
      log.error({ channel, err }, "event handling failed");
      msg.nak();
    }
  };
}
