import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  createLogger,
  createPaymentEvent,
  type PaymentEventType,
} from "@payment-be/shared";
import { RetryLaterError } from "../consumer/index.js";
import {
  createEmailChannel,
  type DeadLetter,
  type DeadLetterFields,
} from "./email.channel.js";
import { EmailSendError, type EmailService } from "./email.service.js";

const ADDRESS = "ada@example.com";
const DELAYS = [5000, 30_000, 120_000, 600_000];

const event = (type: PaymentEventType = "payment.succeeded") =>
  createPaymentEvent(type, {
    amount: 150_000,
    currency: "NGN",
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
  const lines = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, logger, raw };
}

function setup({
  deadLetter,
  send,
}: {
  deadLetter?: DeadLetter;
  send: EmailService["send"];
}) {
  const dead: { correlationId?: string; fields: DeadLetterFields }[] = [];
  const channel = createEmailChannel({
    deadLetter:
      deadLetter ??
      ((fields, correlationId) => {
        dead.push({ correlationId, fields });
        return Promise.resolve({ seq: 41 });
      }),
    delays: DELAYS,
    emailService: { send },
    maxAttempts: 5,
  });
  return { channel, dead, ...capture() };
}

const failWith =
  (fields: ConstructorParameters<typeof EmailSendError>[0]) => () =>
    Promise.reject(new EmailSendError(fields));

const context = (deliveryCount: number) => ({
  correlationId: "req-1",
  deliveryCount,
});

describe("createEmailChannel", () => {
  it("returns after a successful send without dead-lettering", async () => {
    const { channel, dead, logger } = setup({ send: () => Promise.resolve() });
    await expect(
      channel.onEvent(event(), logger, context(1))
    ).resolves.toBeUndefined();
    expect(dead).toEqual([]);
  });

  it.each([
    [1, 5000],
    [4, 600_000],
  ])(
    "schedules a retry after a retryable failure on attempt %i",
    async (attempt, delayMs) => {
      const { channel, dead, lines, logger, raw } = setup({
        send: failWith({ code: "ESOCKET", command: "CONN" }),
      });
      const err = await channel
        .onEvent(event(), logger, context(attempt))
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(RetryLaterError);
      expect((err as RetryLaterError).delayMs).toBe(delayMs);
      expect(dead).toEqual([]);
      expect(lines()).toEqual([
        expect.objectContaining({
          attempt,
          channel: "email",
          code: "ESOCKET",
          delayMs,
          level: 40,
          msg: "email send failed, retrying",
        }),
      ]);
      expect(raw.join("")).not.toContain(ADDRESS);
    }
  );

  it.each([5, 7])(
    "dead-letters as exhausted on attempt %i",
    async (attempt) => {
      const { channel, dead, lines, logger, raw } = setup({
        send: failWith({ code: "ESOCKET", command: "CONN" }),
      });
      const e = event();
      await expect(
        channel.onEvent(e, logger, context(attempt))
      ).resolves.toBeUndefined();
      expect(dead).toEqual([
        {
          correlationId: "req-1",
          fields: {
            attempts: attempt,
            code: "ESOCKET",
            command: "CONN",
            event: e,
            reason: "exhausted",
          },
        },
      ]);
      expect(lines()).toEqual([
        expect.objectContaining({
          attempt,
          msg: "email dead-lettered",
          reason: "exhausted",
          seq: 41,
        }),
      ]);
      expect(raw.join("")).not.toContain(ADDRESS);
    }
  );

  it("dead-letters a permanent rejection on the first attempt", async () => {
    const { channel, dead, lines, logger, raw } = setup({
      send: failWith({
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 550,
      }),
    });
    await channel.onEvent(event("payment.failed"), logger, context(1));
    expect(dead[0]?.fields).toMatchObject({
      attempts: 1,
      reason: "rejected",
      responseCode: 550,
    });
    expect(lines()).toEqual([
      expect.objectContaining({
        attempt: 1,
        code: "EENVELOPE",
        msg: "email dead-lettered",
        reason: "rejected",
        responseCode: 550,
      }),
    ]);
    expect(raw.join("")).not.toContain(ADDRESS);
    expect(raw.join("")).not.toContain("Card declined");
  });

  it.each([5, 12])(
    "retries with the last delay when the dead-letter publish fails on attempt %i",
    async (attempt) => {
      const { channel, lines, logger, raw } = setup({
        deadLetter: () => Promise.reject(new Error("nats down")),
        send: failWith({ code: "ESOCKET" }),
      });
      const err = await channel
        .onEvent(event(), logger, context(attempt))
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(RetryLaterError);
      expect((err as RetryLaterError).delayMs).toBe(600_000);
      expect(lines()).toEqual([
        expect.objectContaining({
          attempt,
          level: 50,
          msg: "dead-letter publish failed",
        }),
      ]);
      expect(raw.join("")).not.toContain(ADDRESS);
    }
  );

  it("rethrows an error that is not an EmailSendError unchanged", async () => {
    const boom = new Error("boom");
    const { channel, dead, logger } = setup({
      send: () => Promise.reject(boom),
    });
    await expect(channel.onEvent(event(), logger, context(5))).rejects.toBe(
      boom
    );
    expect(dead).toEqual([]);
  });

  it("neither sends nor dead-letters payment.processing", async () => {
    const sent: string[] = [];
    const { channel, dead, logger } = setup({
      send: (e) => {
        sent.push(e.type);
        return Promise.resolve();
      },
    });
    await channel.onEvent(event("payment.processing"), logger, context(1));
    expect(sent).toEqual(["payment.processing"]);
    expect(dead).toEqual([]);
  });
});
