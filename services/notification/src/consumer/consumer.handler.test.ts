import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  CORRELATION_ID_HEADER,
  createEvent,
  createLogger,
  createMemoryRepository,
  createPaymentEvent,
  DuplicateRecordError,
  PAYMENT_EVENT_TYPES,
  type PaymentEvent,
  type PaymentEventType,
} from "@payment-be/shared";
import type { Channel, InboxRecord } from "../inbox/index.js";
import {
  createNotificationService,
  type Notification,
} from "../notification/index.js";
import {
  type ConsumerMessage,
  createEventHandler,
  type EventHandlerOptions,
  NAK_DELAY_MS,
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
  const nakDelays: (number | undefined)[] = [];
  const msg: ConsumerMessage = {
    ack: () => actions.push("ack"),
    data: new TextEncoder().encode(
      typeof body === "string" ? body : JSON.stringify(body)
    ),
    headers: {
      get: (key) =>
        key === CORRELATION_ID_HEADER && correlationId ? correlationId : "",
    },
    nak: (delayMs) => {
      actions.push("nak");
      nakDelays.push(delayMs);
    },
    seq: 7,
    subject: "payment.created",
    term: () => actions.push("term"),
  };
  return { actions, msg, nakDelays };
}

type Inbox = EventHandlerOptions["inbox"];

function setup(
  onEvent?: EventHandlerOptions["onEvent"],
  inbox: Inbox = createMemoryRepository<InboxRecord>()
) {
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
  const handlerFor = (channel: Channel) =>
    createEventHandler({ channel, inbox, logger, onEvent });
  const handle = handlerFor("inapp");
  const lines = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { handle, handlerFor, inbox, lines, raw };
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

describe("per-channel dedupe", () => {
  const created = () =>
    createPaymentEvent("payment.created", data("payment.created"));

  const counting = () => {
    const seen: string[] = [];
    const onEvent: EventHandlerOptions["onEvent"] = (event) => {
      seen.push(event.eventId);
      return Promise.resolve();
    };
    return { onEvent, seen };
  };

  const failingInbox = (overrides: Partial<Inbox>): Inbox => {
    const memory = createMemoryRepository<InboxRecord>();
    return {
      get: overrides.get ?? memory.get,
      insert: overrides.insert ?? memory.insert,
    };
  };

  it("runs the work, writes a marker and acks on the first delivery", async () => {
    const { onEvent, seen } = counting();
    const { handle, inbox } = setup(onEvent);
    const event = created();
    const { actions, msg } = stubMessage(event);
    await handle(msg);
    expect(seen).toEqual([event.eventId]);
    expect(actions).toEqual(["ack"]);
    expect(await inbox.get(`inapp:${event.eventId}`)).toEqual({
      channel: "inapp",
      eventId: event.eventId,
      id: `inapp:${event.eventId}`,
      processedAt: expect.any(String),
      type: "payment.created",
      version: 1,
    });
  });

  it("skips a second delivery on the same channel", async () => {
    const { onEvent, seen } = counting();
    const { handle, lines } = setup(onEvent);
    const event = created();
    await handle(stubMessage(event).msg);
    const { actions, msg } = stubMessage(event, "req-5");
    await handle(msg);
    expect(seen).toEqual([event.eventId]);
    expect(actions).toEqual(["ack"]);
    expect(
      lines().find((line) => line.msg === "duplicate skipped")
    ).toMatchObject({
      channel: "inapp",
      correlationId: "req-5",
      eventId: event.eventId,
      level: 30,
      type: "payment.created",
    });
  });

  it("still runs the event on the other channel", async () => {
    const { onEvent, seen } = counting();
    const { handlerFor, inbox } = setup(onEvent);
    const event = created();
    await handlerFor("inapp")(stubMessage(event).msg);
    const { actions, msg } = stubMessage(event);
    await handlerFor("email")(msg);
    expect(seen).toEqual([event.eventId, event.eventId]);
    expect(actions).toEqual(["ack"]);
    expect(await inbox.get(`inapp:${event.eventId}`)).toBeDefined();
    expect(await inbox.get(`email:${event.eventId}`)).toBeDefined();
  });

  it("naks a failed run without a marker, so the next delivery retries", async () => {
    let runs = 0;
    const { handle, inbox } = setup(() => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    const event = created();
    const first = stubMessage(event);
    await handle(first.msg);
    expect(first.actions).toEqual(["nak"]);
    expect(first.nakDelays).toEqual([NAK_DELAY_MS]);
    expect(await inbox.get(`inapp:${event.eventId}`)).toBeUndefined();
    const second = stubMessage(event);
    await handle(second.msg);
    expect(second.actions).toEqual(["ack"]);
    expect(runs).toBe(2);
  });

  it("acks and logs when the marker write fails", async () => {
    const { onEvent, seen } = counting();
    const inbox = failingInbox({
      insert: () => Promise.reject(new Error("disk full")),
    });
    const { handle, lines } = setup(onEvent, inbox);
    const event = created();
    const { actions, msg } = stubMessage(event);
    await handle(msg);
    expect(seen).toEqual([event.eventId]);
    expect(actions).toEqual(["ack"]);
    expect(
      lines().find((line) => line.msg === "marker write failed")
    ).toMatchObject({ channel: "inapp", eventId: event.eventId, level: 50 });
  });

  it("acks as a duplicate when the marker already exists on insert", async () => {
    const event = created();
    const inbox = failingInbox({
      insert: () =>
        Promise.reject(
          new DuplicateRecordError({ id: `inapp:${event.eventId}` })
        ),
    });
    const { onEvent, seen } = counting();
    const { handle, lines } = setup(onEvent, inbox);
    const { actions, msg } = stubMessage(event);
    await handle(msg);
    expect(seen).toEqual([event.eventId]);
    expect(actions).toEqual(["ack"]);
    expect(lines().some((line) => line.msg === "duplicate skipped")).toBe(true);
    expect(lines().some((line) => line.msg === "marker write failed")).toBe(
      false
    );
  });

  it("naks without running the work when the lookup fails", async () => {
    const { onEvent, seen } = counting();
    const inbox = failingInbox({
      get: () => Promise.reject(new Error("storage closed")),
    });
    const { handle, lines } = setup(onEvent, inbox);
    const { actions, msg, nakDelays } = stubMessage(created());
    await handle(msg);
    expect(seen).toEqual([]);
    expect(actions).toEqual(["nak"]);
    expect(nakDelays).toEqual([NAK_DELAY_MS]);
    expect(lines().some((line) => line.msg === "event handling failed")).toBe(
      true
    );
  });

  it("writes no marker for an invalid message", async () => {
    const { handle, inbox } = setup();
    const event = { ...created(), type: "payment.refunded" };
    const { actions, msg } = stubMessage(event);
    await handle(msg);
    expect(actions).toEqual(["term"]);
    expect(await inbox.get(`inapp:${event.eventId}`)).toBeUndefined();
  });

  it("finishes a redelivery after a crash between the notification and the marker", async () => {
    const notifications = createMemoryRepository<Notification>();
    const service = createNotificationService(notifications);
    const event = created();
    await service.record(event);
    const { handle, inbox } = setup((received) => service.record(received));
    const { actions, msg } = stubMessage(event);
    await handle(msg);
    expect(actions).toEqual(["ack"]);
    expect(await inbox.get(`inapp:${event.eventId}`)).toBeDefined();
    expect(await notifications.find()).toHaveLength(1);
  });
});
