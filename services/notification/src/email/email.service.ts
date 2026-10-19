import type { Logger, PaymentEvent } from "@payment-be/shared";
import { renderEmail } from "./email.templates.js";
import type { Mailer } from "./email.transport.js";

const MESSAGE_ID_DOMAIN = "payment-simulation.local";

export class EmailSendError extends Error {
  readonly code: string | undefined;
  readonly command: string | undefined;
  readonly responseCode: number | undefined;

  constructor({
    code,
    command,
    responseCode,
  }: {
    code?: string;
    command?: string;
    responseCode?: number;
  }) {
    super("Email send failed");
    this.name = "EmailSendError";
    this.code = code;
    this.command = command;
    this.responseCode = responseCode;
  }
}

// Built from an allowlist with no cause: nodemailer errors quote the recipient, and pino logs every cause's message.
const sanitize = (err: unknown) => {
  const { code, command, responseCode } = (
    typeof err === "object" && err !== null ? err : {}
  ) as Record<string, unknown>;
  return new EmailSendError({
    code: typeof code === "string" ? code : undefined,
    command: typeof command === "string" ? command : undefined,
    responseCode: typeof responseCode === "number" ? responseCode : undefined,
  });
};

export interface EmailService {
  send: (event: PaymentEvent, logger: Logger) => Promise<void>;
}

export function createEmailService({
  from,
  mailer,
}: {
  from: string;
  mailer: Mailer;
}): EmailService {
  return {
    async send(event, logger) {
      const email = renderEmail(event);
      if (email === undefined) {
        return;
      }
      let messageId: string;
      try {
        ({ messageId } = await mailer.send({
          from,
          messageId: `<${event.eventId}@${MESSAGE_ID_DOMAIN}>`,
          to: event.data.email,
          ...email,
        }));
      } catch (err) {
        throw sanitize(err);
      }
      logger.info(
        { channel: "email", messageId, type: event.type },
        "email sent"
      );
    },
  };
}
