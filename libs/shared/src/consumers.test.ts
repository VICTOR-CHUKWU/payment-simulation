import { Writable } from "node:stream";
import {
  AckPolicy,
  type ConsumerConfig,
  DeliverPolicy,
  JetStreamApiError,
} from "@nats-io/jetstream";
import {
  type ConsumerDefinition,
  type ConsumerManager,
  type ConsumerSource,
  ensureConsumer,
  type MessageStream,
  startConsumer,
} from "./consumers.js";
import { createLogger } from "./logger.js";

const CONFIG: ConsumerDefinition = {
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  durable_name: "test-consumer",
  filter_subject: "payment.>",
};

const apiError = (code: number) =>
  new JetStreamApiError({ code: 400, description: "test", err_code: code });

const notFound = () =>
  new JetStreamApiError({
    code: 404,
    description: "consumer not found",
    err_code: 10_014,
  });

interface Call {
  config?: ConsumerDefinition;
  method: string;
  name?: string;
  stream: string;
}

function stubManager(info: Partial<ConsumerConfig> | Error) {
  const calls: Call[] = [];
  const jsm: ConsumerManager = {
    consumers: {
      add: (stream, config) => {
        calls.push({ config, method: "add", stream });
        return Promise.resolve({});
      },
      info: (stream, name) => {
        calls.push({ method: "info", name, stream });
        return info instanceof Error
          ? Promise.reject(info)
          : Promise.resolve({ config: info });
      },
      update: (stream, name, config) => {
        calls.push({ config, method: "update", name, stream });
        return Promise.resolve({});
      },
    },
  };
  return { calls, jsm };
}

const methods = (calls: Call[]) => calls.map((c) => c.method);

describe("ensureConsumer", () => {
  it("creates a missing consumer", async () => {
    const { calls, jsm } = stubManager(notFound());
    await expect(ensureConsumer(jsm, "PAYMENTS", CONFIG)).resolves.toBe(
      "created"
    );
    expect(methods(calls)).toEqual(["info", "add"]);
    expect(calls[0]).toMatchObject({
      name: "test-consumer",
      stream: "PAYMENTS",
    });
    expect(calls[1]?.config).toEqual(CONFIG);
    expect(calls[1]?.config).not.toBe(CONFIG);
  });

  it("leaves a matching consumer unchanged", async () => {
    const { calls, jsm } = stubManager({ ...CONFIG });
    await expect(ensureConsumer(jsm, "PAYMENTS", CONFIG)).resolves.toBe(
      "unchanged"
    );
    expect(methods(calls)).toEqual(["info"]);
  });

  it("ignores fields the server fills in", async () => {
    const { jsm } = stubManager({
      ...CONFIG,
      ack_wait: 30_000_000_000,
      max_ack_pending: 1000,
      max_deliver: -1,
    });
    await expect(ensureConsumer(jsm, "PAYMENTS", CONFIG)).resolves.toBe(
      "unchanged"
    );
  });

  it("updates a consumer whose filter differs", async () => {
    const { calls, jsm } = stubManager({
      ...CONFIG,
      filter_subject: "payment.created",
    });
    await expect(ensureConsumer(jsm, "PAYMENTS", CONFIG)).resolves.toBe(
      "updated"
    );
    expect(methods(calls)).toEqual(["info", "update"]);
    expect(calls[1]).toMatchObject({
      config: CONFIG,
      name: "test-consumer",
      stream: "PAYMENTS",
    });
  });

  it("rethrows other info errors", async () => {
    const error = apiError(10_059);
    const { jsm } = stubManager(error);
    await expect(ensureConsumer(jsm, "PAYMENTS", CONFIG)).rejects.toBe(error);
  });

  it("rethrows add errors", async () => {
    const error = apiError(10_013);
    const { jsm } = stubManager(notFound());
    jsm.consumers.add = () => Promise.reject(error);
    await expect(ensureConsumer(jsm, "PAYMENTS", CONFIG)).rejects.toBe(error);
  });

  it("rethrows update errors", async () => {
    const error = new Error("deliver policy can not be updated");
    const { jsm } = stubManager({
      ...CONFIG,
      deliver_policy: DeliverPolicy.New,
    });
    jsm.consumers.update = () => Promise.reject(error);
    await expect(ensureConsumer(jsm, "PAYMENTS", CONFIG)).rejects.toBe(error);
  });
});

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

function stubStream<M>() {
  const queue: M[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let closed = 0;
  const statuses: { type: string }[] = [];

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const messages: MessageStream<M> = {
    async *[Symbol.asyncIterator]() {
      while (!(ended && queue.length === 0)) {
        if (failure) {
          throw failure;
        }
        const next = queue.shift();
        if (next === undefined) {
          // biome-ignore lint/performance/noAwaitInLoops: waits for the next pushed message
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        } else {
          yield next;
        }
      }
    },
    close: () => {
      closed += 1;
      ended = true;
      notify();
      return Promise.resolve();
    },
    async *status() {
      yield* statuses;
    },
  };

  return {
    closed: () => closed,
    end: () => {
      ended = true;
      notify();
    },
    fail: (err: Error) => {
      failure = err;
      notify();
    },
    messages,
    push: (...items: M[]) => {
      queue.push(...items);
      notify();
    },
    statuses,
  };
}

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  const logger = createLogger({
    destination,
    level: "info",
    pretty: false,
    service: "test",
  });
  return { lines, logger };
}

async function setup(handle: (msg: string) => Promise<void>) {
  const stream = stubStream<string>();
  const requested: string[] = [];
  const js: ConsumerSource<string> = {
    consumers: {
      get: (streamName, name) => {
        requested.push(`${streamName}/${name}`);
        return Promise.resolve({
          consume: () => Promise.resolve(stream.messages),
        });
      },
    },
  };
  const { lines, logger } = capture();
  const consumer = await startConsumer({
    durable: "test-consumer",
    handle,
    js,
    logger,
    stream: "PAYMENTS",
  });
  return { consumer, lines, requested, stream };
}

describe("startConsumer", () => {
  it("passes each message to the handler in order", async () => {
    const seen: string[] = [];
    const { consumer, requested, stream } = await setup((msg) => {
      seen.push(msg);
      return Promise.resolve();
    });
    stream.push("a", "b", "c");
    await flush();
    expect(requested).toEqual(["PAYMENTS/test-consumer"]);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(consumer.running()).toBe(true);
    await consumer.stop();
  });

  it("finishes the message in hand before stop resolves", async () => {
    const gate = deferred();
    const seen: string[] = [];
    let finished = false;
    const { consumer, stream } = await setup(async (msg) => {
      seen.push(msg);
      await gate.promise;
      finished = true;
    });
    stream.push("a", "b");
    await flush();
    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stream.closed()).toBe(1);
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
    expect(seen).toEqual(["a"]);
    expect(consumer.running()).toBe(false);
  });

  it("skips messages left in the buffer once stopped", async () => {
    const seen: string[] = [];
    const { consumer, stream } = await setup((msg) => {
      seen.push(msg);
      return Promise.resolve();
    });
    const stopping = consumer.stop();
    stream.push("late");
    await stopping;
    await flush();
    expect(seen).toEqual([]);
    expect(consumer.running()).toBe(false);
  });

  it.each([
    ["ended", (stream: ReturnType<typeof stubStream<string>>) => stream.end()],
    [
      "failed",
      (stream: ReturnType<typeof stubStream<string>>) =>
        stream.fail(new Error("connection closed")),
    ],
  ])("still stops cleanly after the messages %s", async (_label, finish) => {
    let handled = 0;
    const { consumer, lines, stream } = await setup(() => {
      handled += 1;
      return Promise.resolve();
    });
    finish(stream);
    await flush();
    await consumer.stop();
    expect(handled).toBe(0);
    expect(stream.closed()).toBe(1);
    expect(
      lines.filter((line) => line.msg === "consumer stopped")
    ).toHaveLength(1);
  });

  it("closes the messages only once when stopped twice", async () => {
    const { consumer, stream } = await setup(() => Promise.resolve());
    await Promise.all([consumer.stop(), consumer.stop()]);
    expect(stream.closed()).toBe(1);
  });

  it("stops running when the messages end", async () => {
    const { consumer, lines, stream } = await setup(() => Promise.resolve());
    stream.end();
    await flush();
    expect(consumer.running()).toBe(false);
    expect(lines.some((line) => line.msg === "consumer stopped")).toBe(true);
  });

  it("stops running when the messages throw", async () => {
    const { consumer, lines, stream } = await setup(() => Promise.resolve());
    stream.fail(new Error("connection closed"));
    await flush();
    expect(consumer.running()).toBe(false);
    expect(lines.some((line) => line.msg === "consumer loop failed")).toBe(
      true
    );
  });

  it("logs a handler error and keeps going", async () => {
    const seen: string[] = [];
    const { consumer, lines, stream } = await setup((msg) => {
      if (msg === "bad") {
        return Promise.reject(new Error("boom"));
      }
      seen.push(msg);
      return Promise.resolve();
    });
    stream.push("bad", "good");
    await flush();
    expect(seen).toEqual(["good"]);
    expect(consumer.running()).toBe(true);
    expect(
      lines.find((line) => line.msg === "consumer handler failed")
    ).toMatchObject({ consumer: "test-consumer", level: 50 });
    await consumer.stop();
  });

  it("logs watched status notifications", async () => {
    const stream = stubStream<string>();
    stream.statuses.push(
      { type: "heartbeats_missed" },
      { type: "next" },
      { type: "consumer_deleted" }
    );
    const { lines, logger } = capture();
    const consumer = await startConsumer({
      durable: "test-consumer",
      handle: () => Promise.resolve(),
      js: {
        consumers: {
          get: () =>
            Promise.resolve({
              consume: () => Promise.resolve(stream.messages),
            }),
        },
      },
      logger,
      stream: "PAYMENTS",
    });
    await flush();
    expect(
      lines
        .filter((line) => line.msg === "consumer status")
        .map((line) => line.status)
    ).toEqual(["heartbeats_missed", "consumer_deleted"]);
    await consumer.stop();
  });

  it("logs and keeps consuming when the status watch fails", async () => {
    const stream = stubStream<string>();
    stream.messages.status = async function* () {
      yield* [];
      throw new Error("status ended");
    };
    const handled: string[] = [];
    const { lines, logger } = capture();
    const consumer = await startConsumer({
      durable: "test-consumer",
      handle: (msg) => {
        handled.push(msg);
        return Promise.resolve();
      },
      js: {
        consumers: {
          get: () =>
            Promise.resolve({
              consume: () => Promise.resolve(stream.messages),
            }),
        },
      },
      logger,
      stream: "PAYMENTS",
    });
    stream.push("a");
    await flush();
    expect(handled).toEqual(["a"]);
    expect(consumer.running()).toBe(true);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer: "test-consumer",
          level: 40,
          msg: "consumer status watch failed",
        }),
      ])
    );
    await consumer.stop();
  });
});
