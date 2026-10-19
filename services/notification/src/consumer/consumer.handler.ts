import {
  DuplicateRecordError,
  decodeEvent,
  type EventMessage,
  type Logger,
  type PaymentEvent,
  paymentEventSchema,
  type Repository,
} from "@payment-be/shared";
import { ZodError } from "zod";
import { type Channel, type InboxRecord, inboxId } from "../inbox/index.js";

export interface ConsumerMessage extends EventMessage {
  ack: () => void;
  nak: () => void;
  seq: number;
  subject: string;
  term: (reason?: string) => void;
}

export interface EventHandlerOptions {
  channel: Channel;
  inbox: Pick<Repository<InboxRecord>, "get" | "insert">;
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
  inbox,
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
    const id = inboxId(channel, event.eventId);
    const skipDuplicate = () => {
      log.info({ channel, type: event.type }, "duplicate skipped");
      msg.ack();
    };
    let duplicate: boolean;
    try {
      duplicate = (await inbox.get(id)) !== undefined;
      if (!duplicate) {
        log.info(
          { channel, paymentId: event.data.paymentId, type: event.type },
          "event received"
        );
        await onEvent(event, log);
      }
    } catch (err) {
      log.error({ channel, err }, "event handling failed");
      msg.nak();
      return;
    }
    if (duplicate) {
      skipDuplicate();
      return;
    }
    try {
      await inbox.insert({
        channel,
        eventId: event.eventId,
        id,
        processedAt: new Date().toISOString(),
        type: event.type,
      });
    } catch (err) {
      if (err instanceof DuplicateRecordError) {
        skipDuplicate();
        return;
      }
      // The work is done; a nak would redeliver at once and run it again in a loop while storage is failing.
      log.error({ channel, err }, "marker write failed");
    }
    msg.ack();
  };
}
