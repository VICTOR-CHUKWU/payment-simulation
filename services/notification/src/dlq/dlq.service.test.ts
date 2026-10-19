import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  AppError,
  createEvent,
  createLogger,
  createPaymentEvent,
} from "@payment-be/shared";
import { EmailSendError, type EmailService } from "../email/index.js";
import { DLQ_ENTRY_TYPE } from "./dlq.js";
import { createDlqService, type DlqStreams } from "./dlq.service.js";

const ADDRESS = "ada@example.com";
const encoder = new TextEncoder();

const paymentEvent = () =>
  createPaymentEvent("payment.succeeded", {
    amount: 150_000,
    currency: "NGN",
    email: ADDRESS,
    paymentId: randomUUID(),
    userId: randomUUID(),
  });

const entry = (reason: "exhausted" | "rejected" = "exhausted") =>
  createEvent(DLQ_ENTRY_TYPE, {
    attempts: 5,
    channel: "email",
    code: "ESOCKET",
    event: paymentEvent(),
    reason,
  });

function fakeStreams(
  stored: (object | string)[],
  {
    deleteMessage,
  }: { deleteMessage?: DlqStreams["streams"]["deleteMessage"] } = {}
) {
  const messages = new Map<number, Uint8Array>();
  for (const [i, value] of stored.entries()) {
    messages.set(
      i + 1,
      encoder.encode(typeof value === "string" ? value : JSON.stringify(value))
    );
  }
  const last = stored.length;
  const jsm: DlqStreams = {
    streams: {
      deleteMessage:
        deleteMessage ??
        ((_stream, seq) => Promise.resolve(messages.delete(seq))),
      getMessage: (_stream, { seq }) => {
        if (seq < 1) {
          return Promise.reject(new Error("bad request"));
        }
        const data = messages.get(seq);
        return Promise.resolve(data === undefined ? null : { data, seq });
      },
      info: () =>
        Promise.resolve({
          state: {
            first_seq: last === 0 ? 0 : 1,
            last_seq: last,
            messages: messages.size,
          },
        }),
    },
  };
  return { jsm, messages };
}

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

const sentOk: EmailService = { send: () => Promise.resolve() };

describe("list", () => {
  it("returns entries newest first with paging, skipping deleted and malformed ones", async () => {
    const entries = [entry(), entry(), entry(), entry()];
    const { jsm, messages } = fakeStreams([...entries, "not json"]);
    messages.delete(2);
    const { logger, raw } = capture();
    const service = createDlqService({ emailService: sentOk, jsm });
    const first = await service.list({ limit: 2, page: 1 }, logger);
    expect(first.items.map((item) => item.seq)).toEqual([4, 3]);
    expect(first.meta).toEqual({ limit: 2, page: 1, total: 4, totalPages: 2 });
    const second = await service.list({ limit: 2, page: 2 }, logger);
    expect(second.items.map((item) => item.seq)).toEqual([1]);
    expect(first.items[0]).toEqual({
      attempts: 5,
      code: "ESOCKET",
      deadLetteredAt: entries[3]?.occurredAt,
      event: entries[3]?.data.event,
      reason: "exhausted",
      seq: 4,
    });
    expect(raw.join("")).toContain("dlq entry malformed");
    expect(raw.join("")).not.toContain(ADDRESS);
  });

  it("returns an empty page for a stream that never held an entry", async () => {
    const { jsm } = fakeStreams([]);
    const service = createDlqService({ emailService: sentOk, jsm });
    expect(
      await service.list({ limit: 20, page: 1 }, capture().logger)
    ).toEqual({
      items: [],
      meta: { limit: 20, page: 1, total: 0, totalPages: 0 },
    });
  });
});

describe("get", () => {
  it("returns an entry by sequence", async () => {
    const e = entry("rejected");
    const { jsm } = fakeStreams([e]);
    const service = createDlqService({ emailService: sentOk, jsm });
    expect(await service.get(1, capture().logger)).toMatchObject({
      event: e.data.event,
      reason: "rejected",
      seq: 1,
    });
  });

  it.each([
    ["an unknown", 9],
    ["a malformed", 1],
  ])("returns 404 for %s sequence", async (_label, seq) => {
    const { jsm } = fakeStreams(['{"type":"x"}']);
    const service = createDlqService({ emailService: sentOk, jsm });
    const err = await service
      .get(seq, capture().logger)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "dlq-entry-not-found", status: 404 });
  });
});

describe("replay", () => {
  it("sends the email, deletes the entry and returns its IDs", async () => {
    const e = entry();
    const { jsm, messages } = fakeStreams([e]);
    const sent: string[] = [];
    const service = createDlqService({
      emailService: {
        send: (event) => {
          sent.push(event.eventId);
          return Promise.resolve();
        },
      },
      jsm,
    });
    const { logger, raw } = capture();
    await expect(service.replay(1, logger)).resolves.toEqual({
      eventId: e.data.event.eventId,
      seq: 1,
    });
    expect(sent).toEqual([e.data.event.eventId]);
    expect(messages.has(1)).toBe(false);
    expect(raw.join("")).toContain("dlq entry replayed");
    expect(raw.join("")).not.toContain(ADDRESS);
  });

  it("returns 502 with the code in detail and keeps the entry when sending fails", async () => {
    const { jsm, messages } = fakeStreams([entry()]);
    const service = createDlqService({
      emailService: {
        send: () =>
          Promise.reject(
            new EmailSendError({ code: "ESOCKET", command: "CONN" })
          ),
      },
      jsm,
    });
    const err = await service
      .replay(1, capture().logger)
      .catch((x: unknown) => x);
    expect(err).toMatchObject({ code: "email-send-failed", status: 502 });
    expect((err as AppError).detail).toContain("ESOCKET");
    expect((err as AppError).cause).toBeUndefined();
    expect(messages.has(1)).toBe(true);
  });

  it("returns 409 while another replay of the same entry is running", async () => {
    const { jsm } = fakeStreams([entry()]);
    const { promise: pending, resolve: release } =
      Promise.withResolvers<void>();
    const service = createDlqService({
      emailService: { send: () => pending },
      jsm,
    });
    const { logger } = capture();
    const first = service.replay(1, logger);
    await new Promise((resolve) => setImmediate(resolve));
    const err = await service.replay(1, logger).catch((x: unknown) => x);
    expect(err).toMatchObject({ code: "replay-in-progress", status: 409 });
    release();
    await expect(first).resolves.toMatchObject({ seq: 1 });
  });

  it.each([
    ["throws", () => Promise.reject(new Error("api error"))],
    ["returns false", () => Promise.resolve(false)],
  ])(
    "fails and keeps the entry when delete %s",
    async (_label, deleteMessage) => {
      const { jsm, messages } = fakeStreams([entry()], { deleteMessage });
      const service = createDlqService({ emailService: sentOk, jsm });
      const { logger, raw } = capture();
      await expect(service.replay(1, logger)).rejects.toThrow(
        "DLQ entry delete failed"
      );
      expect(messages.has(1)).toBe(true);
      expect(raw.join("")).toContain("dlq entry delete failed");
    }
  );

  it("names the SMTP response code when the error has no code", async () => {
    const { jsm } = fakeStreams([entry()]);
    const service = createDlqService({
      emailService: {
        send: () => Promise.reject(new EmailSendError({ responseCode: 451 })),
      },
      jsm,
    });
    const err = await service
      .replay(1, capture().logger)
      .catch((x: unknown) => x);
    expect((err as AppError).detail).toContain("(451)");
  });

  it("rethrows a send error that is not an EmailSendError and keeps the entry", async () => {
    const boom = new Error("boom");
    const { jsm, messages } = fakeStreams([entry()]);
    const service = createDlqService({
      emailService: { send: () => Promise.reject(boom) },
      jsm,
    });
    await expect(service.replay(1, capture().logger)).rejects.toBe(boom);
    expect(messages.has(1)).toBe(true);
  });

  it("returns 404 for an unknown entry", async () => {
    const { jsm } = fakeStreams([]);
    const service = createDlqService({ emailService: sentOk, jsm });
    await expect(service.replay(3, capture().logger)).rejects.toMatchObject({
      status: 404,
    });
  });
});
