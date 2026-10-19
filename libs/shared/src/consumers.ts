import {
  type ConsumerConfig,
  JetStreamApiCodes,
  type JsMsg,
} from "@nats-io/jetstream";
import type { Logger } from "pino";
import { isApiError, matchesConfig } from "./jetstream-helpers.js";

// biome-ignore lint/performance/noBarrelFile: services reach JetStream only through the shared lib
export { AckPolicy, DeliverPolicy, type JsMsg } from "@nats-io/jetstream";

export type ConsumerDefinition = Partial<ConsumerConfig> & {
  durable_name: string;
};

export type EnsureConsumerResult = "created" | "updated" | "unchanged";

export interface ConsumerManager {
  consumers: {
    add: (stream: string, config: ConsumerDefinition) => Promise<unknown>;
    info: (
      stream: string,
      name: string
    ) => Promise<{ config: Partial<ConsumerConfig> }>;
    update: (
      stream: string,
      name: string,
      config: ConsumerDefinition
    ) => Promise<unknown>;
  };
}

export interface MessageStream<M> extends AsyncIterable<M> {
  close: () => Promise<unknown>;
  status: () => AsyncIterable<{ type: string }>;
}

export interface ConsumerSource<M = JsMsg> {
  consumers: {
    get: (
      stream: string,
      name: string
    ) => Promise<{ consume: () => Promise<MessageStream<M>> }>;
  };
}

export interface RunningConsumer {
  running: () => boolean;
  stop: () => Promise<void>;
}

export interface StartConsumerOptions<M> {
  durable: string;
  handle: (msg: M) => Promise<void>;
  js: ConsumerSource<M>;
  logger: Logger;
  stream: string;
}

const WATCHED_STATUSES = new Set([
  "consumer_deleted",
  "consumer_not_found",
  "heartbeats_missed",
]);

export async function ensureConsumer(
  jsm: ConsumerManager,
  stream: string,
  config: ConsumerDefinition
): Promise<EnsureConsumerResult> {
  let current: Partial<ConsumerConfig>;
  try {
    current = (await jsm.consumers.info(stream, config.durable_name)).config;
  } catch (err) {
    if (!isApiError(err, JetStreamApiCodes.ConsumerNotFound)) {
      throw err;
    }
    await jsm.consumers.add(stream, { ...config });
    return "created";
  }
  if (matchesConfig<ConsumerConfig>(current, config)) {
    return "unchanged";
  }
  await jsm.consumers.update(stream, config.durable_name, config);
  return "updated";
}

export async function startConsumer<M>({
  durable,
  handle,
  js,
  logger,
  stream,
}: StartConsumerOptions<M>): Promise<RunningConsumer> {
  const log = logger.child({ consumer: durable });
  const messages = await (await js.consumers.get(stream, durable)).consume();
  let active = true;
  let stopping = false;

  // consume() survives reconnects and even a deleted consumer, reporting them here rather than ending the loop.
  const watch = async () => {
    try {
      for await (const status of messages.status()) {
        if (WATCHED_STATUSES.has(status.type)) {
          log.warn({ status: status.type }, "consumer status");
        }
      }
    } catch (err) {
      log.warn({ err }, "consumer status watch failed");
    }
  };

  const loop = async () => {
    try {
      for await (const msg of messages) {
        // Messages already pulled but not handled are redelivered after ack_wait.
        if (stopping) {
          break;
        }
        try {
          await handle(msg);
        } catch (err) {
          log.error({ err }, "consumer handler failed");
        }
      }
    } catch (err) {
      log.error({ err }, "consumer loop failed");
    } finally {
      active = false;
      if (!stopping) {
        log.warn("consumer stopped");
      }
    }
  };

  watch();
  const done = loop();
  log.info("consumer started");

  let stopped: Promise<void> | undefined;
  return {
    running: () => active,
    stop() {
      stopped ??= (async () => {
        const wasActive = active;
        stopping = true;
        await messages.close();
        await done;
        if (wasActive) {
          log.info("consumer stopped");
        }
      })();
      return stopped;
    },
  };
}
