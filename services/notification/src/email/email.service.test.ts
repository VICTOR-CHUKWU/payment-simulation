import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  createLogger,
  createPaymentEvent,
  type PaymentEventType,
} from "@payment-be/shared";
import { createEmailService, EmailSendError } from "./email.service.js";
import { renderEmail } from "./email.templates.js";
import type { Mailer, MailMessage } from "./email.transport.js";

const ADDRESS = "ada@example.com";
const FROM = "Payment Simulation <no-reply@payment-simulation.local>";

const event = (type: PaymentEventType = "payment.succeeded") =>
  createPaymentEvent(type, {
    amount: 150_000,
    currency: "NGN",
    description: "Secret order",
    email: ADDRESS,
    paymentId: randomUUID(),
    userId: randomUUID(),
    ...(type === "payment.failed" ? { failureReason: "Card declined" } : {}),
  });

function capture() {
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      raw.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({
    destination,
    level: "info",
    pretty: false,
    service: "test",
  });
  return { logger, raw };
}

function stubMailer(send: Mailer["send"]) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    close: () => Promise.resolve(),
    send: (message) => {
      sent.push(message);
      return send(message);
    },
  };
  return { mailer, sent };
}

const ok = (message: MailMessage) =>
  Promise.resolve({ messageId: message.messageId });

function rejectedRecipientError() {
  const response = `550 5.1.1 <${ADDRESS}>: Recipient address rejected`;
  return Object.assign(
    new Error(`Can't send mail - all recipients were rejected: ${response}`),
    {
      code: "EENVELOPE",
      command: "RCPT TO",
      recipient: ADDRESS,
      rejected: [ADDRESS],
      rejectedErrors: [
        Object.assign(new Error(response), { recipient: ADDRESS }),
      ],
      response,
      responseCode: 550,
    }
  );
}

describe("createEmailService", () => {
  it("sends the rendered email to the event's address with a stable message ID", async () => {
    const { mailer, sent } = stubMailer(ok);
    const e = event();
    await createEmailService({ from: FROM, mailer }).send(e, capture().logger);
    expect(sent).toEqual([
      {
        from: FROM,
        messageId: `<${e.eventId}@payment-simulation.local>`,
        to: ADDRESS,
        ...renderEmail(e),
      },
    ]);
  });

  it("sends nothing for payment.processing", async () => {
    const { mailer, sent } = stubMailer(ok);
    await createEmailService({ from: FROM, mailer }).send(
      event("payment.processing"),
      capture().logger
    );
    expect(sent).toEqual([]);
  });

  it("logs the message ID without the address or the description", async () => {
    const { mailer } = stubMailer(ok);
    const { logger, raw } = capture();
    const e = event();
    await createEmailService({ from: FROM, mailer }).send(e, logger);
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0] ?? "{}")).toMatchObject({
      channel: "email",
      messageId: `<${e.eventId}@payment-simulation.local>`,
      msg: "email sent",
      type: "payment.succeeded",
    });
    expect(raw[0]).not.toContain(ADDRESS);
    expect(raw[0]).not.toContain("Secret order");
  });

  it("rethrows a send error without the address", async () => {
    const { mailer } = stubMailer(() =>
      Promise.reject(rejectedRecipientError())
    );
    const err = await createEmailService({ from: FROM, mailer })
      .send(event(), capture().logger)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err).toMatchObject({
      code: "EENVELOPE",
      command: "RCPT TO",
      message: "Email send failed",
      responseCode: 550,
    });
    expect((err as Error).cause).toBeUndefined();
    const { logger, raw } = capture();
    logger.error({ err }, "event handling failed");
    expect(raw.join("")).toContain("EENVELOPE");
    expect(raw.join("")).not.toContain(ADDRESS);
    expect(JSON.stringify(err)).not.toContain(ADDRESS);
  });

  it("rethrows a non-Error rejection as EmailSendError", async () => {
    const { mailer } = stubMailer(() => Promise.reject(`refused ${ADDRESS}`));
    const err = await createEmailService({ from: FROM, mailer })
      .send(event(), capture().logger)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err).toMatchObject({
      code: undefined,
      message: "Email send failed",
    });
  });
});
