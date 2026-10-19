import {
  type JetStreamClient,
  type Logger,
  publishEvent,
  type Repository,
  VersionConflictError,
} from "@payment-be/shared";
import type { Payment } from "../payment/index.js";

const REMOVE_ATTEMPTS = 3;

export interface OutboxRelayOptions {
  intervalMs: number;
  js: Pick<JetStreamClient, "publish">;
  logger: Logger;
  payments: Repository<Payment>;
}

export interface OutboxRelay {
  kick: () => void;
  start: () => void;
  stop: () => Promise<void>;
  sweep: () => Promise<void>;
}

export function createOutboxRelay({
  intervalMs,
  js,
  logger,
  payments,
}: OutboxRelayOptions): OutboxRelay {
  let again = false;
  let running: Promise<void> | undefined;
  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const publishWaiting = async (payment: Payment): Promise<Set<string>> => {
    const published = new Set<string>();
    for (const { correlationId, event } of payment.outbox ?? []) {
      // Checked before each publish so stop() never waits on more than one publish timeout.
      if (stopped) {
        break;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one payment's events must go out in order
        await publishEvent(js, event.type, event, { correlationId });
      } catch (err) {
        logger.warn(
          { err, eventId: event.eventId, paymentId: payment.id },
          "event publish failed"
        );
        break;
      }
      published.add(event.eventId);
      logger.info(
        {
          correlationId,
          eventId: event.eventId,
          paymentId: payment.id,
          type: event.type,
        },
        "event published"
      );
    }
    return published;
  };

  const remove = async (paymentId: string, published: Set<string>) => {
    for (let attempt = 1; ; attempt += 1) {
      // Re-read so an entry appended by a transition since the sweep's read is kept.
      // biome-ignore lint/performance/noAwaitInLoops: attempts must run in sequence
      const current = await payments.get(paymentId);
      if (current === undefined) {
        return;
      }
      try {
        await payments.update(paymentId, current.version, {
          outbox: (current.outbox ?? []).filter(
            ({ event }) => !published.has(event.eventId)
          ),
        });
        return;
      } catch (err) {
        if (!(err instanceof VersionConflictError)) {
          throw err;
        }
        if (attempt === REMOVE_ATTEMPTS) {
          logger.warn({ paymentId }, "outbox cleanup failed");
          return;
        }
      }
    }
  };

  const runSweep = async () => {
    const waiting = (
      await payments.find((payment) => (payment.outbox?.length ?? 0) > 0)
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const payment of waiting) {
      if (stopped) {
        return;
      }
      // biome-ignore lint/performance/noAwaitInLoops: payments are published one at a time
      const published = await publishWaiting(payment);
      if (published.size > 0) {
        await remove(payment.id, published);
      }
    }
  };

  const sweep = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    running ??= runSweep()
      .catch((err: unknown) => {
        logger.error({ err }, "outbox sweep failed");
      })
      .finally(() => {
        running = undefined;
        if (again && !stopped) {
          again = false;
          sweep();
        }
      });
    return running;
  };

  const tick = async () => {
    await sweep();
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  return {
    kick() {
      if (!started || stopped) {
        return;
      }
      if (running) {
        again = true;
        return;
      }
      sweep();
    },
    start() {
      if (started || stopped) {
        return;
      }
      started = true;
      tick();
    },
    stop() {
      stopping ??= (async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
      })();
      return stopping;
    },
    sweep,
  };
}
