import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  CORRELATION_ID_HEADER,
  createEvent,
  createLogger,
  createPaymentEvent,
  PAYMENT_EVENT_TYPES,
  type PaymentEvent,
  type PaymentEventType,
} from "@payment-be/shared";
import {
  type ConsumerMessage,
  createEventHandler,
  type EventHandlerOptions,
} from "./consumer.handler.js";

const EMAIL = "ada@example.com";

const data = (type: PaymentEventType) => ({
  amount: 1250,
  currency: "NGN",
  email: EMAIL,
  paymentId: randomUUID(),
  userId: randomUUID(),
  ...(type === "payment.failed" ? { failureReason: "declined" } : {}),
});

function stubMessage(body: unknown, correlationId?: string) {
  const actions: string[] = [];
  const msg: ConsumerMessage = {
    ack: () => actions.push("ack"),
    data: new TextEncoder().encode(
      typeof body === "string" ? body : JSON.stringify(body)
    ),
    headers: {
      get: (key) =>
        key === CORRELATION_ID_HEADER && correlationId ? correlationId : "",
    },
    nak: () => actions.push("nak"),
    seq: 7,
    subject: "payment.created",
    term: () => actions.push("term"),
  };
  return { actions, msg };
}

function setup(onEvent?: EventHandlerOptions["onEvent"]) {
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
  const handle = createEventHandler({ channel: "inapp", logger, onEvent });
  const lines = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { handle, lines, raw };
}

describe("createEventHandler", () => {
  it.each(PAYMENT_EVENT_TYPES)("acks a valid %s event", async (type) => {
    const { handle, lines } = setup();
    const event = createPaymentEvent(type, data(type));
    const { actions, msg } = stubMessage(event, "req-1");
    await handle(msg);
    expect(actions).toEqual(["ack"]);
    expect(lines()).toEqual([
      expect.objectContaining({
        channel: "inapp",
        correlationId: "req-1",
        eventId: event.eventId,
        msg: "event received",
        paymentId: event.data.paymentId,
        type,
        userId: event.data.userId,
      }),
    ]);
  });

  it("passes the parsed event to onEvent before acking", async () => {
    const seen: PaymentEvent[] = [];
    const { handle } = setup((received) => {
      seen.push(received);
      return Promise.resolve();
    });
    const event = createPaymentEvent(
      "payment.created",
      data("payment.created")
    );
    const { actions, msg } = stubMessage(event);
    await handle(msg);
    expect(seen).toEqual([event]);
    expect(actions).toEqual(["ack"]);
  });

  const created = () =>
    createPaymentEvent("payment.created", data("payment.created"));

  it.each([
    ["invalid JSON", () => '{"eventId":', "json", undefined],
    [
      "an unknown type",
      () => ({ ...created(), type: "payment.refunded" }),
      "schema",
      "type",
    ],
    [
      "a bad data field",
      () => ({ ...created(), data: { ...created().data, amount: 12.5 } }),
      "schema",
      "data.amount",
    ],
    [
      "payment.failed without failureReason",
      () => createEvent("payment.failed", data("payment.created")),
      "schema",
      "data.failureReason",
    ],
  ])("terminates %s", async (_label, body, reason, issue) => {
    const { handle, lines, raw } = setup();
    const { actions, msg } = stubMessage(body());
    await handle(msg);
    expect(actions).toEqual(["term"]);
    const [line] = lines();
    expect(line).toMatchObject({
      channel: "inapp",
      level: 40,
      msg: "invalid event terminated",
      reason,
      seq: 7,
      subject: "payment.created",
    });
    if (issue) {
      expect(line?.issues).toContain(issue);
    }
    expect(raw.join("")).not.toContain(EMAIL);
  });

  it("naks when handling throws after parsing", async () => {
    const { handle, lines } = setup(() => Promise.reject(new Error("boom")));
    const event = created();
    const { actions, msg } = stubMessage(event, "req-3");
    await handle(msg);
    expect(actions).toEqual(["nak"]);
    expect(
      lines().find((line) => line.msg === "event handling failed")
    ).toMatchObject({
      channel: "inapp",
      correlationId: "req-3",
      eventId: event.eventId,
      level: 50,
    });
  });

  it("never logs the email address or the payload", async () => {
    const { handle, lines, raw } = setup(() =>
      Promise.reject(new Error("boom"))
    );
    const described = createPaymentEvent("payment.created", {
      ...data("payment.created"),
      description: "Rent for flat 4B",
    });
    await handle(stubMessage(described, "req-4").msg);
    await handle(stubMessage({ ...described, type: "payment.unknown" }).msg);
    await handle(
      stubMessage(
        createPaymentEvent("payment.succeeded", data("payment.succeeded"))
      ).msg
    );
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.join("")).not.toContain(EMAIL);
    expect(raw.join("")).not.toContain("Rent for flat 4B");
    expect(lines().filter((line) => "data" in line)).toEqual([]);
  });
});
