import {
  DiscardPolicy,
  JetStreamApiError,
  RetentionPolicy,
  StorageType,
  type StreamConfig,
} from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import {
  ensureStream,
  PAYMENTS_STREAM,
  type StreamDefinition,
  type StreamManager,
} from "./streams.js";

const apiError = (code: number) =>
  new JetStreamApiError({ code: 400, description: "test", err_code: code });

const notFound = () =>
  new JetStreamApiError({
    code: 404,
    description: "stream not found",
    err_code: 10_059,
  });

type Reply = Partial<StreamConfig> | Error;

function stubManager(infoReplies: Reply[], addReply?: Error) {
  const calls: { config?: StreamDefinition; method: string }[] = [];
  const replies = [...infoReplies];
  const jsm: StreamManager = {
    streams: {
      add: (config) => {
        calls.push({ config, method: "add" });
        return addReply ? Promise.reject(addReply) : Promise.resolve({});
      },
      info: () => {
        calls.push({ method: "info" });
        const reply = replies.shift();
        if (reply === undefined) {
          throw new Error("unexpected info call");
        }
        return reply instanceof Error
          ? Promise.reject(reply)
          : Promise.resolve({ config: reply });
      },
      update: (_name, config) => {
        calls.push({ config, method: "update" });
        return Promise.resolve({});
      },
    },
  };
  return { calls, jsm };
}

const methods = (calls: { method: string }[]) => calls.map((c) => c.method);

describe("ensureStream", () => {
  it("creates a missing stream", async () => {
    const { calls, jsm } = stubManager([notFound()]);
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).resolves.toBe("created");
    expect(methods(calls)).toEqual(["info", "add"]);
    expect(calls[1]?.config).toEqual(PAYMENTS_STREAM);
    expect(calls[1]?.config).not.toBe(PAYMENTS_STREAM);
  });

  it("leaves a matching stream unchanged", async () => {
    const { calls, jsm } = stubManager([{ ...PAYMENTS_STREAM }]);
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).resolves.toBe("unchanged");
    expect(methods(calls)).toEqual(["info"]);
  });

  it("ignores fields the server fills in", async () => {
    const { jsm } = stubManager([
      { ...PAYMENTS_STREAM, max_consumers: -1, max_msgs: -1, sealed: false },
    ]);
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).resolves.toBe("unchanged");
  });

  it.each([
    ["max_age", { max_age: nanos(1000) }],
    ["subjects", { subjects: ["payment.created"] }],
  ])("updates a stream whose %s differs", async (_label, change) => {
    const { calls, jsm } = stubManager([{ ...PAYMENTS_STREAM, ...change }]);
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).resolves.toBe("updated");
    expect(methods(calls)).toEqual(["info", "update"]);
    expect(calls[1]?.config).toBe(PAYMENTS_STREAM);
  });

  it("treats reordered subjects as a difference", async () => {
    const config: StreamDefinition = { name: "T", subjects: ["a.>", "b.>"] };
    const { jsm } = stubManager([{ ...config, subjects: ["b.>", "a.>"] }]);
    await expect(ensureStream(jsm, config)).resolves.toBe("updated");
  });

  it("reads the stream again when another service created it first", async () => {
    const { calls, jsm } = stubManager(
      [notFound(), { ...PAYMENTS_STREAM, max_age: nanos(1000) }],
      apiError(10_058)
    );
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).resolves.toBe("updated");
    expect(methods(calls)).toEqual(["info", "add", "info", "update"]);
  });

  it("rethrows other info errors", async () => {
    const error = apiError(10_039);
    const { jsm } = stubManager([error]);
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).rejects.toBe(error);
  });

  it("rethrows other add errors", async () => {
    const error = apiError(10_052);
    const { jsm } = stubManager([notFound()], error);
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).rejects.toBe(error);
  });

  it("rethrows update errors", async () => {
    const error = new Error(
      "stream configuration update can not change storage"
    );
    const { jsm } = stubManager([
      { ...PAYMENTS_STREAM, storage: StorageType.Memory },
    ]);
    jsm.streams.update = () => Promise.reject(error);
    await expect(ensureStream(jsm, PAYMENTS_STREAM)).rejects.toBe(error);
  });
});

describe("PAYMENTS_STREAM", () => {
  it("has the agreed settings", () => {
    expect(PAYMENTS_STREAM).toEqual({
      discard: DiscardPolicy.Old,
      duplicate_window: 120_000_000_000,
      max_age: 604_800_000_000_000,
      name: "PAYMENTS",
      num_replicas: 1,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      subjects: ["payment.>"],
    });
  });
});
