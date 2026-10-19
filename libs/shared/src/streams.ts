import {
  DiscardPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  RetentionPolicy,
  StorageType,
  type StreamConfig,
} from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";

// biome-ignore lint/performance/noBarrelFile: services reach JetStream only through the shared lib
export { jetstreamManager } from "@nats-io/jetstream";

const STREAM_NAME_IN_USE = 10_058;

export type StreamDefinition = Partial<StreamConfig> & { name: string };

export type EnsureStreamResult = "created" | "updated" | "unchanged";

export interface StreamManager {
  streams: {
    add: (config: StreamDefinition) => Promise<unknown>;
    info: (name: string) => Promise<{ config: Partial<StreamConfig> }>;
    update: (name: string, config: StreamDefinition) => Promise<unknown>;
  };
}

export const PAYMENTS_STREAM = {
  discard: DiscardPolicy.Old,
  duplicate_window: nanos(2 * 60 * 1000),
  max_age: nanos(7 * 24 * 60 * 60 * 1000),
  name: "PAYMENTS",
  num_replicas: 1,
  retention: RetentionPolicy.Limits,
  storage: StorageType.File,
  subjects: ["payment.>"],
} as const satisfies StreamDefinition;

const isApiError = (err: unknown, code: number): err is JetStreamApiError =>
  err instanceof JetStreamApiError && err.code === code;

const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, i) => item === b[i])
    : a === b;

const matches = (
  current: Partial<StreamConfig>,
  config: StreamDefinition
): boolean =>
  Object.entries(config).every(([key, value]) =>
    sameValue(current[key as keyof StreamConfig], value)
  );

async function infoOrAdd(
  jsm: StreamManager,
  config: StreamDefinition
): Promise<Partial<StreamConfig> | undefined> {
  try {
    return (await jsm.streams.info(config.name)).config;
  } catch (err) {
    if (!isApiError(err, JetStreamApiCodes.StreamNotFound)) {
      throw err;
    }
  }
  try {
    // The client's add() writes mirror and sources onto the object it is given.
    await jsm.streams.add({ ...config });
    return;
  } catch (err) {
    // Another service created the stream between our info and add, with a different config.
    if (!isApiError(err, STREAM_NAME_IN_USE)) {
      throw err;
    }
  }
  return (await jsm.streams.info(config.name)).config;
}

export async function ensureStream(
  jsm: StreamManager,
  config: StreamDefinition
): Promise<EnsureStreamResult> {
  const current = await infoOrAdd(jsm, config);
  if (current === undefined) {
    return "created";
  }
  if (matches(current, config)) {
    return "unchanged";
  }
  await jsm.streams.update(config.name, config);
  return "updated";
}
