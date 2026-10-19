import type {
  JetStreamClient,
  JetStreamPublishOptions,
  PubAck,
} from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import { z } from "zod";
import { createEvent } from "./events.js";
import {
  CORRELATION_ID_HEADER,
  decodeEvent,
  drainNats,
  parseEvent,
  publishEvent,
} from "./nats.js";

const ack: PubAck = { domain: "", duplicate: false, seq: 1, stream: "TEST" };
const dataSchema = z.object({ amount: z.number().int() });

function stubClient() {
  const calls: {
    options: Partial<JetStreamPublishOptions> | undefined;
    payload: unknown;
    subject: string;
  }[] = [];
  const js: Pick<JetStreamClient, "publish"> = {
    publish: (subject, payload, options) => {
      calls.push({ options, payload, subject });
      return Promise.resolve(ack);
    },
  };
  return { calls, js };
}

describe("publishEvent", () => {
  it("publishes the JSON envelope with eventId as msgID", async () => {
    const { js, calls } = stubClient();
    const event = createEvent("test.created", { amount: 100 });

    await expect(publishEvent(js, "test.created", event)).resolves.toBe(ack);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.subject).toBe("test.created");
    expect(JSON.parse(String(call?.payload))).toEqual(event);
    expect(call?.options?.msgID).toBe(event.eventId);
    expect(call?.options?.headers?.has(CORRELATION_ID_HEADER)).toBe(false);
  });

  it("sets the correlation header when given", async () => {
    const { js, calls } = stubClient();
    await publishEvent(js, "test.created", createEvent("t", { amount: 1 }), {
      correlationId: "req-1",
    });
    expect(calls[0]?.options?.headers?.get(CORRELATION_ID_HEADER)).toBe(
      "req-1"
    );
  });
});

describe("parseEvent", () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  it("round-trips an event and its correlation ID", () => {
    const event = createEvent("test.created", { amount: 100 });
    const msgHeaders = headers();
    msgHeaders.set(CORRELATION_ID_HEADER, "req-1");

    expect(
      parseEvent(
        { data: encode(JSON.stringify(event)), headers: msgHeaders },
        dataSchema
      )
    ).toEqual({ correlationId: "req-1", event });
  });

  it("returns no correlation ID without the header", () => {
    const event = createEvent("t", { amount: 1 });
    const result = parseEvent(
      { data: encode(JSON.stringify(event)) },
      dataSchema
    );
    expect(result.correlationId).toBeUndefined();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseEvent({ data: encode("{") }, dataSchema)).toThrow(
      SyntaxError
    );
  });

  it("throws on a schema mismatch", () => {
    const event = createEvent("t", { amount: "100" });
    expect(() =>
      parseEvent({ data: encode(JSON.stringify(event)) }, dataSchema)
    ).toThrow(z.ZodError);
  });
});

describe("decodeEvent", () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const schema = z.object({ data: dataSchema, type: z.literal("test.ok") });

  it("validates the whole event with the given schema", () => {
    const event = { data: { amount: 5 }, type: "test.ok" };
    expect(
      decodeEvent(
        {
          data: encode(JSON.stringify(event)),
          headers: { get: () => "req-2" },
        },
        schema
      )
    ).toEqual({ correlationId: "req-2", event });
  });

  it("throws when a field outside data does not match", () => {
    const event = { data: { amount: 5 }, type: "test.other" };
    expect(() =>
      decodeEvent({ data: encode(JSON.stringify(event)) }, schema)
    ).toThrow(z.ZodError);
  });

  it("treats an empty correlation header as missing", () => {
    const event = { data: { amount: 5 }, type: "test.ok" };
    expect(
      decodeEvent(
        { data: encode(JSON.stringify(event)), headers: { get: () => "" } },
        schema
      ).correlationId
    ).toBeUndefined();
  });
});

describe("drainNats", () => {
  function stubConnection(drain: () => Promise<void>) {
    const calls: string[] = [];
    let closed = false;
    return {
      calls,
      nc: {
        close: () => {
          calls.push("close");
          closed = true;
          return Promise.resolve();
        },
        drain: async () => {
          calls.push("drain");
          await drain();
          closed = true;
        },
        isClosed: () => closed,
      },
    };
  }

  it("drains without an extra close", async () => {
    const { calls, nc } = stubConnection(() => Promise.resolve());
    await drainNats(nc);
    expect(calls).toEqual(["drain"]);
  });

  it("closes and rethrows when drain fails", async () => {
    const { calls, nc } = stubConnection(() =>
      Promise.reject(new Error("disconnected"))
    );
    await expect(drainNats(nc)).rejects.toThrow("disconnected");
    expect(calls).toEqual(["drain", "close"]);
  });
});
