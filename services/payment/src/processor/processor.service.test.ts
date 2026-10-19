import { Writable } from "node:stream";
import {
  createLogger,
  createMemoryRepository,
  type Repository,
} from "@payment-be/shared";
import type { Payment, PaymentStatus } from "../payment/index.js";
import { transitionPayment } from "../payment/index.js";
import type {
  GatewayCharge,
  GatewayResult,
  PaymentGateway,
} from "./processor.gateway.js";
import {
  createPaymentProcessor,
  GATEWAY_TIMEOUT_REASON,
} from "./processor.service.js";

const { jest } = import.meta;

const EMAIL = "ada@example.com";
const POLL_MS = 1000;
const TIMEOUT_MS = 10_000;
const processedAt = new Date("2026-10-18T13:00:00.000Z");

interface Call {
  charge: GatewayCharge;
  reject: (reason: unknown) => void;
  resolve: (result: GatewayResult) => void;
  signal: AbortSignal;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function stubGateway() {
  const calls: Call[] = [];
  const gateway: PaymentGateway = {
    charge(charge, { signal }) {
      const { promise, reject, resolve } = deferred<GatewayResult>();
      calls.push({ charge, reject, resolve, signal });
      return promise;
    },
  };
  return { calls, gateway };
}

function setup({
  concurrency = 5,
  wrap = (payments: Repository<Payment>) => payments,
}: {
  concurrency?: number;
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
  const { calls, gateway } = stubGateway();
  let kicks = 0;
  const processor = createPaymentProcessor({
    concurrency,
    gateway,
    logger,
    now: () => processedAt,
    onOutbox: () => {
      kicks += 1;
    },
    payments: wrap(payments),
    pollIntervalMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
  });
  const logs = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  const logged = (msg: string) => logs().filter((entry) => entry.msg === msg);
  let count = 0;
  const add = async (status: PaymentStatus = "pending", second?: number) => {
    count += 1;
    const createdAt = new Date(Date.UTC(2026, 9, 18, 12, 0, second ?? count));
    return await payments.insert({
      amount: 1000 * count,
      correlationId: "req-1",
      createdAt: createdAt.toISOString(),
      currency: "NGN",
      email: EMAIL,
      id: crypto.randomUUID(),
      status,
      updatedAt: createdAt.toISOString(),
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
  };
  return {
    add,
    calls,
    kicks: () => kicks,
    logged,
    payments,
    processor,
    raw,
  };
}

let stops: Array<() => Promise<void>> = [];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
});

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
  jest.useRealTimers();
});

function started(options?: Parameters<typeof setup>[0]) {
  const context = setup(options);
  stops.push(context.processor.stop);
  return context;
}

describe("createPaymentProcessor", () => {
  it("claims a pending payment and records an approval as succeeded", async () => {
    const { add, calls, logged, payments, processor, raw } = started();
    const payment = await add();

    await processor.sweep();

    expect(await payments.get(payment.id)).toMatchObject({
      status: "processing",
      updatedAt: processedAt.toISOString(),
      version: 2,
    });
    expect(calls.map((call) => call.charge)).toEqual([
      { amount: payment.amount, currency: "NGN", paymentId: payment.id },
    ]);
    expect(logged("payment claimed")).toEqual([
      expect.objectContaining({ paymentId: payment.id }),
    ]);

    calls[0]?.resolve({ outcome: "approved" });
    await flush();

    expect(await payments.get(payment.id)).toMatchObject({
      status: "succeeded",
      version: 3,
    });
    expect(logged("payment processed")).toEqual([
      expect.objectContaining({ paymentId: payment.id, status: "succeeded" }),
    ]);
    expect(raw.join("\n")).not.toContain(EMAIL);
  });

  it("records a decline as failed with the gateway's reason", async () => {
    const { add, calls, logged, payments, processor } = started();
    const payment = await add();

    await processor.sweep();
    calls[0]?.resolve({ outcome: "declined", reason: "Insufficient funds" });
    await flush();

    expect(await payments.get(payment.id)).toMatchObject({
      failureReason: "Insufficient funds",
      status: "failed",
    });
    expect(logged("payment processed")).toEqual([
      expect.objectContaining({
        failureReason: "Insufficient funds",
        status: "failed",
      }),
    ]);
  });

  it("fails the payment when the gateway does not answer in time", async () => {
    const { add, calls, payments, processor } = started();
    const payment = await add();

    await processor.sweep();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect((await payments.get(payment.id))?.status).toBe("processing");
    await jest.advanceTimersByTimeAsync(1);
    await flush();

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(await payments.get(payment.id)).toMatchObject({
      failureReason: GATEWAY_TIMEOUT_REASON,
      status: "failed",
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("resubmits a payment left processing without claiming it again", async () => {
    const { add, calls, logged, payments, processor } = started();
    const payment = await add("processing");

    await processor.sweep();

    expect(calls).toHaveLength(1);
    expect(logged("payment resumed")).toEqual([
      expect.objectContaining({ paymentId: payment.id }),
    ]);
    expect(logged("payment claimed")).toEqual([]);
    expect((await payments.get(payment.id))?.version).toBe(1);

    calls[0]?.resolve({ outcome: "approved" });
    await flush();

    expect((await payments.get(payment.id))?.status).toBe("succeeded");
  });

  it("skips a payment cancelled between the scan and the claim", async () => {
    let cancel: (() => Promise<unknown>) | undefined;
    const { add, calls, logged, payments, processor } = started({
      wrap: (inner) => ({
        ...inner,
        async find(predicate) {
          const found = await inner.find(predicate);
          await cancel?.();
          return found;
        },
      }),
    });
    const payment = await add();
    cancel = () =>
      transitionPayment(payments, payment.id, "cancelled", {
        now: () => processedAt,
      });

    await processor.sweep();

    expect(calls).toHaveLength(0);
    expect((await payments.get(payment.id))?.status).toBe("cancelled");
    expect(logged("payment claim skipped")).toEqual([
      expect.objectContaining({
        code: "invalid-status-transition",
        paymentId: payment.id,
      }),
    ]);
  });

  it("keeps an admin's result that lands while the gateway is answering", async () => {
    const { add, calls, logged, payments, processor } = started();
    const payment = await add();

    await processor.sweep();
    await transitionPayment(payments, payment.id, "failed", {
      failureReason: "Marked failed by admin",
    });
    calls[0]?.resolve({ outcome: "approved" });
    await flush();

    expect(await payments.get(payment.id)).toMatchObject({
      failureReason: "Marked failed by admin",
      status: "failed",
    });
    expect(logged("payment already settled")).toEqual([
      expect.objectContaining({ paymentId: payment.id, status: "failed" }),
    ]);
    expect(logged("payment processing failed")).toEqual([]);
  });

  it("caps work at the concurrency limit, oldest first", async () => {
    const { add, calls, payments, processor } = started({ concurrency: 2 });
    const third = await add("pending", 3);
    const second = await add("pending", 2);
    const first = await add("pending", 1);

    await processor.sweep();
    expect(calls.map((call) => call.charge.paymentId)).toEqual([
      first.id,
      second.id,
    ]);

    await processor.sweep();
    expect(calls).toHaveLength(2);
    expect((await payments.get(third.id))?.status).toBe("pending");

    calls[0]?.resolve({ outcome: "approved" });
    await flush();
    await processor.sweep();

    expect(calls.map((call) => call.charge.paymentId)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("does not pick up a payment that is already in flight", async () => {
    const { add, calls, logged, processor } = started();
    await add();

    await processor.sweep();
    await processor.sweep();

    expect(calls).toHaveLength(1);
    expect(logged("payment resumed")).toEqual([]);
  });

  it("does nothing when called while another sweep is running", async () => {
    const hold = deferred<void>();
    let finds = 0;
    const { add, calls, processor } = started({
      wrap: (inner) => ({
        ...inner,
        async find(predicate) {
          finds += 1;
          await hold.promise;
          return await inner.find(predicate);
        },
      }),
    });
    await add();

    const first = processor.sweep();
    await processor.sweep();
    expect(finds).toBe(1);

    hold.resolve();
    await first;

    expect(calls).toHaveLength(1);
  });

  it("logs a failed sweep and still runs the next one", async () => {
    let finds = 0;
    const { add, calls, logged, processor } = started({
      wrap: (inner) => ({
        ...inner,
        find(predicate) {
          finds += 1;
          return finds === 1
            ? Promise.reject(new Error("disk unavailable"))
            : inner.find(predicate);
        },
      }),
    });
    await add();

    processor.start();
    await flush();
    expect(logged("payment sweep failed")).toHaveLength(1);
    expect(calls).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(finds).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("finishes a claim in progress when stopped but starts no charge", async () => {
    const hold = deferred<void>();
    const { add, calls, payments, processor } = started({
      wrap: (inner) => ({
        ...inner,
        async update(id, expectedVersion, patch) {
          await hold.promise;
          return await inner.update(id, expectedVersion, patch);
        },
      }),
    });
    const payment = await add();

    const sweeping = processor.sweep();
    await flush();
    const stopped = jest.fn();
    const stopping = processor.stop().then(stopped);
    await flush();
    expect(stopped).not.toHaveBeenCalled();

    hold.resolve();
    await stopping;

    expect((await payments.get(payment.id))?.status).toBe("processing");
    await sweeping;
    expect(calls).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("leaves the payment processing when recording the result fails, then resumes it", async () => {
    let updates = 0;
    const { add, calls, logged, payments, processor } = started({
      wrap: (inner) => ({
        ...inner,
        update(id, expectedVersion, patch) {
          updates += 1;
          return updates === 2
            ? Promise.reject(new Error("disk full"))
            : inner.update(id, expectedVersion, patch);
        },
      }),
    });
    const payment = await add();

    await processor.sweep();
    calls[0]?.resolve({ outcome: "approved" });
    await flush();

    expect((await payments.get(payment.id))?.status).toBe("processing");
    expect(logged("payment processing failed")).toEqual([
      expect.objectContaining({ paymentId: payment.id }),
    ]);

    await processor.sweep();

    expect(calls).toHaveLength(2);
    expect(logged("payment resumed")).toEqual([
      expect.objectContaining({ paymentId: payment.id }),
    ]);
  });

  it("aborts in-flight charges on stop and records nothing", async () => {
    const { add, calls, logged, payments, processor } = started();
    const payment = await add();

    processor.start();
    await flush();
    expect(calls).toHaveLength(1);

    await processor.stop();
    calls[0]?.resolve({ outcome: "approved" });
    await flush();

    expect(calls[0]?.signal.aborted).toBe(true);
    expect((await payments.get(payment.id))?.status).toBe("processing");
    expect(logged("payment processing failed")).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);

    await add();
    await jest.advanceTimersByTimeAsync(POLL_MS * 3);
    await processor.sweep();

    expect(calls).toHaveLength(1);
  });

  it("does not wait for a gateway that ignores the abort signal", async () => {
    const { add, calls, processor } = started();
    await add();

    await processor.sweep();
    await processor.stop();

    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it("sweeps at once on start and again after the poll interval", async () => {
    let finds = 0;
    const { processor } = started({
      wrap: (inner) => ({
        ...inner,
        find(predicate) {
          finds += 1;
          return inner.find(predicate);
        },
      }),
    });

    processor.start();
    processor.start();
    await flush();
    expect(finds).toBe(1);

    await jest.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(finds).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await flush();

    expect(finds).toBe(2);
  });
});

describe("createPaymentProcessor outbox", () => {
  const entries = async (payments: Repository<Payment>, id: string) =>
    ((await payments.get(id))?.outbox ?? []).map(
      ({ correlationId, event }) => ({
        correlationId,
        failureReason: event.data.failureReason,
        type: event.type,
      })
    );

  it("adds processing and succeeded events with the creating request's ID", async () => {
    const { add, calls, kicks, payments, processor } = started();
    const payment = await add();

    await processor.sweep();
    expect(kicks()).toBe(1);
    calls[0]?.resolve({ outcome: "approved" });
    await flush();

    expect(await entries(payments, payment.id)).toEqual([
      {
        correlationId: "req-1",
        failureReason: undefined,
        type: "payment.processing",
      },
      {
        correlationId: "req-1",
        failureReason: undefined,
        type: "payment.succeeded",
      },
    ]);
    expect(kicks()).toBe(2);
  });

  it("adds a failed event with the gateway's reason", async () => {
    const { add, calls, payments, processor } = started();
    const payment = await add();

    await processor.sweep();
    calls[0]?.resolve({ outcome: "declined", reason: "Insufficient funds" });
    await flush();

    expect((await entries(payments, payment.id)).at(-1)).toEqual({
      correlationId: "req-1",
      failureReason: "Insufficient funds",
      type: "payment.failed",
    });
  });

  it("does not kick the relay after a skipped claim", async () => {
    let cancel: (() => Promise<unknown>) | undefined;
    const { add, kicks, payments, processor } = started({
      wrap: (inner) => ({
        ...inner,
        async find(predicate) {
          const found = await inner.find(predicate);
          await cancel?.();
          return found;
        },
      }),
    });
    const payment = await add();
    cancel = () =>
      transitionPayment(payments, payment.id, "cancelled", {
        now: () => processedAt,
      });

    await processor.sweep();

    expect(kicks()).toBe(0);
  });

  it("logs a claim failure other than a skipped claim and charges nothing", async () => {
    const { add, calls, logged, payments, processor } = started({
      wrap: (inner) => ({
        ...inner,
        update: () => Promise.reject(new Error("disk full")),
      }),
    });
    const payment = await add();

    await processor.sweep();
    await flush();

    expect(calls).toHaveLength(0);
    expect((await payments.get(payment.id))?.status).toBe("pending");
    expect(logged("payment processing failed")).toEqual([
      expect.objectContaining({ level: 50, paymentId: payment.id }),
    ]);
  });

  it("logs a gateway error and leaves the payment processing for the next sweep", async () => {
    const { add, calls, logged, payments, processor } = started();
    const payment = await add();

    await processor.sweep();
    await flush();
    calls[0]?.reject(new Error("gateway exploded"));
    await flush();

    expect((await payments.get(payment.id))?.status).toBe("processing");
    expect(logged("payment processing failed")).toEqual([
      expect.objectContaining({ level: 50, paymentId: payment.id }),
    ]);
  });
});
