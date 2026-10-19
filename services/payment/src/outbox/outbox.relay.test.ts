import { Writable } from "node:stream";
import {
  CORRELATION_ID_HEADER,
  createLogger,
  createMemoryRepository,
  type JetStreamClient,
  type Repository,
  VersionConflictError,
} from "@payment-be/shared";
import {
  createPaymentService,
  type Payment,
  transitionPayment,
} from "../payment/index.js";
import { createOutboxRelay, type OutboxRelay } from "./outbox.relay.js";

const { jest } = import.meta;

const EMAIL = "ada@example.com";
const INTERVAL_MS = 1000;

type PubAck = Awaited<ReturnType<JetStreamClient["publish"]>>;

interface Published {
  correlationId: string | undefined;
  eventId: string | undefined;
  subject: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: lets queued promise chains run in turn
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function stubJetStream() {
  const published: Published[] = [];
  const attempts: string[] = [];
  let failing = (_eventId: string) => false;
  let gate: Promise<void> | undefined;
  const js: Pick<JetStreamClient, "publish"> = {
    async publish(subject, _payload, options) {
      const eventId = options?.msgID ?? "";
      attempts.push(eventId);
      await gate;
      if (failing(eventId)) {
        throw new Error("publish timed out");
      }
      published.push({
        correlationId:
          options?.headers?.get(CORRELATION_ID_HEADER) || undefined,
        eventId: options?.msgID,
        subject,
      });
      return {
        duplicate: false,
        seq: published.length,
        stream: "PAYMENTS",
      } as PubAck;
    },
  };
  return {
    attempts,
    block() {
      const { promise, resolve } = deferred();
      gate = promise;
      return () => {
        gate = undefined;
        resolve();
      };
    },
    failWhen(predicate: (eventId: string) => boolean) {
      failing = predicate;
    },
    js,
    published,
  };
}

let relays: OutboxRelay[] = [];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
});

afterEach(async () => {
  await Promise.all(relays.map((relay) => relay.stop()));
  relays = [];
  jest.useRealTimers();
});

function setup({
  wrap = (payments: Repository<Payment>) => payments,
}: {
  wrap?: (payments: Repository<Payment>) => Repository<Payment>;
} = {}) {
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      raw.push(...chunk.toString().split("\n").filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({
    destination,
    level: "debug",
    pretty: false,
    service: "test",
  });
  const payments = createMemoryRepository<Payment>();
  let finds = 0;
  const counted: Repository<Payment> = {
    ...payments,
    find(predicate) {
      finds += 1;
      return payments.find(predicate);
    },
  };
  const jetStream = stubJetStream();
  const relay = createOutboxRelay({
    intervalMs: INTERVAL_MS,
    js: jetStream.js,
    logger,
    payments: wrap(counted),
  });
  relays.push(relay);
  let second = 0;
  const service = createPaymentService(payments, {
    now: () => {
      second += 1;
      return new Date(Date.UTC(2026, 9, 18, 12, 0, second));
    },
  });
  const create = async (correlationId = "req-1") =>
    (
      await service.create({
        body: { amount: 150_000, currency: "NGN" },
        correlationId,
        owner: { email: EMAIL, userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
      })
    ).payment;
  const outbox = async (id: string) => (await payments.get(id))?.outbox ?? [];
  const logged = (msg: string) =>
    raw
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === msg);
  return {
    ...jetStream,
    create,
    finds: () => finds,
    logged,
    outbox,
    payments,
    raw,
    relay,
  };
}

describe("createOutboxRelay", () => {
  it("publishes a payment's events in order and empties its outbox", async () => {
    const { create, logged, outbox, payments, published, raw, relay } = setup();
    const payment = await create();
    await transitionPayment(payments, payment.id, "processing");
    const ids = (await outbox(payment.id)).map(({ event }) => event.eventId);

    await relay.sweep();

    expect(published).toEqual([
      { correlationId: "req-1", eventId: ids[0], subject: "payment.created" },
      {
        correlationId: "req-1",
        eventId: ids[1],
        subject: "payment.processing",
      },
    ]);
    expect(await outbox(payment.id)).toEqual([]);
    expect(logged("event published")).toEqual([
      expect.objectContaining({
        correlationId: "req-1",
        eventId: ids[0],
        paymentId: payment.id,
        type: "payment.created",
      }),
      expect.objectContaining({ type: "payment.processing" }),
    ]);
    expect(raw.join("\n")).not.toContain(EMAIL);
  });

  it("leaves updatedAt alone when it removes published events", async () => {
    const { create, payments, relay } = setup();
    const payment = await create();

    await relay.sweep();

    expect((await payments.get(payment.id))?.updatedAt).toBe(payment.updatedAt);
  });

  it("stops a payment at its first failed publish and retries it on the next sweep", async () => {
    const { create, failWhen, logged, outbox, payments, published, relay } =
      setup();
    const first = await create();
    await transitionPayment(payments, first.id, "processing");
    const second = await create();
    const [created, processing] = await outbox(first.id);
    const [secondCreated] = await outbox(second.id);
    failWhen((eventId) => eventId === processing?.event.eventId);

    await relay.sweep();

    expect(published.map(({ eventId }) => eventId)).toEqual([
      created?.event.eventId,
      secondCreated?.event.eventId,
    ]);
    expect(await outbox(first.id)).toEqual([processing]);
    expect(await outbox(second.id)).toEqual([]);
    expect(logged("event publish failed")).toEqual([
      expect.objectContaining({
        eventId: processing?.event.eventId,
        paymentId: first.id,
      }),
    ]);

    failWhen(() => false);
    await relay.sweep();

    expect(published.at(-1)?.eventId).toBe(processing?.event.eventId);
    expect(await outbox(first.id)).toEqual([]);
  });

  it("keeps an event appended while the earlier ones were publishing", async () => {
    const { attempts, block, create, outbox, payments, relay } = setup();
    const payment = await create();
    const release = block();

    const sweep = relay.sweep();
    await flush();
    expect(attempts).toHaveLength(1);
    await transitionPayment(payments, payment.id, "processing");
    release();
    await sweep;

    expect((await outbox(payment.id)).map(({ event }) => event.type)).toEqual([
      "payment.processing",
    ]);
  });

  it("publishes events left over from a previous run when it starts", async () => {
    const { create, finds, outbox, published, relay } = setup();
    const payment = await create();

    relay.start();
    await flush();

    expect(finds()).toBe(1);
    expect(published).toHaveLength(1);
    expect(await outbox(payment.id)).toEqual([]);
  });

  it("sweeps again on each interval", async () => {
    const { create, published, relay } = setup();
    relay.start();
    await relay.sweep();
    await create();

    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(published).toHaveLength(1);
  });

  it("runs one extra sweep for several kicks during a sweep", async () => {
    const { block, create, finds, published, relay } = setup();
    relay.start();
    await relay.sweep();
    await create();
    const release = block();

    relay.kick();
    await flush();
    await create();
    relay.kick();
    relay.kick();
    relay.kick();
    release();
    await flush();

    expect(finds()).toBe(3);
    expect(published).toHaveLength(2);
  });

  it("does nothing on a kick before start", async () => {
    const { create, finds, published, relay } = setup();
    await create();

    relay.kick();
    await flush();

    expect(finds()).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("waits for the running sweep on stop and skips a sweep a kick scheduled", async () => {
    const { block, create, finds, published, relay } = setup();
    relay.start();
    await relay.sweep();
    await create();
    const release = block();
    relay.kick();
    await flush();
    relay.kick();

    let stopped = false;
    const stopping = relay.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    release();
    await stopping;

    expect(finds()).toBe(2);
    expect(published).toHaveLength(1);
    relay.kick();
    await relay.sweep();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 5);
    expect(finds()).toBe(2);
  });

  it("returns from stop after the current publish and leaves the rest waiting", async () => {
    const { block, create, outbox, published, relay } = setup();
    const payments = [await create(), await create(), await create()];
    const release = block();

    const sweep = relay.sweep();
    await flush();
    const stopping = relay.stop();
    release();
    await stopping;
    await sweep;

    expect(published).toHaveLength(1);
    expect(await outbox(payments[0]?.id ?? "")).toEqual([]);
    expect(await outbox(payments[1]?.id ?? "")).toHaveLength(1);
    expect(await outbox(payments[2]?.id ?? "")).toHaveLength(1);
  });

  it("gives up removing after repeated version conflicts and republishes on the next sweep", async () => {
    let conflicts = 3;
    let updates = 0;
    const { create, logged, outbox, published, relay } = setup({
      wrap: (inner) => ({
        ...inner,
        update(id, expectedVersion, patch) {
          updates += 1;
          if (conflicts > 0) {
            conflicts -= 1;
            return Promise.reject(new VersionConflictError({ id }));
          }
          return inner.update(id, expectedVersion, patch);
        },
      }),
    });
    const payment = await create();

    await relay.sweep();

    expect(updates).toBe(3);
    expect(logged("outbox cleanup failed")).toEqual([
      expect.objectContaining({ paymentId: payment.id }),
    ]);
    expect(await outbox(payment.id)).toHaveLength(1);

    await relay.sweep();

    expect(published).toHaveLength(2);
    expect(published[0]?.eventId).toBe(published[1]?.eventId);
    expect(await outbox(payment.id)).toEqual([]);
  });

  it("logs a failed sweep and keeps sweeping on the timer", async () => {
    let failures = 1;
    const { create, logged, published, relay } = setup({
      wrap: (inner) => ({
        ...inner,
        find(predicate) {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new Error("storage unavailable"));
          }
          return inner.find(predicate);
        },
      }),
    });
    relay.start();
    await relay.sweep();

    expect(logged("outbox sweep failed")).toHaveLength(1);

    await create();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(published).toHaveLength(1);
  });

  it("stops between one payment's events when stopped mid-publish", async () => {
    const { block, create, outbox, payments, published, relay } = setup();
    const payment = await create();
    await transitionPayment(payments, payment.id, "processing");
    const release = block();

    const sweep = relay.sweep();
    await flush();
    const stopping = relay.stop();
    release();
    await stopping;
    await sweep;

    expect(published).toHaveLength(1);
    expect(await outbox(payment.id)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: "payment.processing" }),
      }),
    ]);
  });

  it("logs a cleanup error other than a version conflict as a failed sweep", async () => {
    const { create, logged, outbox, relay } = setup({
      wrap: (inner) => ({
        ...inner,
        update: () => Promise.reject(new Error("disk full")),
      }),
    });
    const payment = await create();

    await relay.sweep();

    expect(logged("outbox sweep failed")).toHaveLength(1);
    expect(await outbox(payment.id)).toHaveLength(1);
  });

  it("ignores a second start", async () => {
    const { finds, relay } = setup();
    relay.start();
    relay.start();
    await flush();

    expect(finds()).toBe(1);
  });
});
