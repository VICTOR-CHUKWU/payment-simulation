import type { Logger, PaymentEvent } from "@payment-be/shared";
import { type EventContext, RetryLaterError } from "../consumer/index.js";
import { isPermanent, retryDelay } from "./email.retry.js";
import { EmailSendError, type EmailService } from "./email.service.js";

export type DeadLetterReason = "exhausted" | "rejected";

export interface DeadLetterFields {
  attempts: number;
  code?: string;
  command?: string;
  event: PaymentEvent;
  reason: DeadLetterReason;
  responseCode?: number;
}

export type DeadLetter = (
  fields: DeadLetterFields,
  correlationId?: string
) => Promise<{ seq: number }>;

export interface EmailChannel {
  onEvent: (
    event: PaymentEvent,
    logger: Logger,
    context: EventContext
  ) => Promise<void>;
}

const safeFields = ({ code, command, responseCode }: EmailSendError) => ({
  ...(code === undefined ? {} : { code }),
  ...(command === undefined ? {} : { command }),
  ...(responseCode === undefined ? {} : { responseCode }),
});

export function createEmailChannel({
  deadLetter,
  delays,
  emailService,
  maxAttempts,
}: {
  deadLetter: DeadLetter;
  delays: readonly number[];
  emailService: EmailService;
  maxAttempts: number;
}): EmailChannel {
  const lastDelay = retryDelay(delays.length, delays);
  return {
    async onEvent(event, logger, { correlationId, deliveryCount: attempt }) {
      try {
        await emailService.send(event, logger);
      } catch (err) {
        if (!(err instanceof EmailSendError)) {
          throw err;
        }
        const permanent = isPermanent(err);
        if (!permanent && attempt < maxAttempts) {
          const delayMs = retryDelay(attempt, delays);
          logger.warn(
            { attempt, channel: "email", delayMs, ...safeFields(err) },
            "email send failed, retrying"
          );
          throw new RetryLaterError(delayMs, { cause: err });
        }
        const reason: DeadLetterReason = permanent ? "rejected" : "exhausted";
        let seq: number;
        try {
          ({ seq } = await deadLetter(
            { attempts: attempt, event, reason, ...safeFields(err) },
            correlationId
          ));
        } catch (publishErr) {
          logger.error(
            { attempt, channel: "email", err: publishErr },
            "dead-letter publish failed"
          );
          throw new RetryLaterError(lastDelay, { cause: publishErr });
        }
        logger.warn(
          { attempt, channel: "email", reason, seq, ...safeFields(err) },
          "email dead-lettered"
        );
      }
    },
  };
}
