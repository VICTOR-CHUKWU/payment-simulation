import { AppError, type Logger, type Repository } from "@payment-be/shared";
import {
  type Payment,
  type PaymentStatus,
  transitionPayment,
} from "../payment/index.js";
import type { GatewayResult, PaymentGateway } from "./processor.gateway.js";

export const GATEWAY_TIMEOUT_REASON = "Gateway timed out";

const TIMED_OUT = new Error(GATEWAY_TIMEOUT_REASON);
const STOPPED = new Error("Payment processor stopped");

const SKIPPED_CLAIM_CODES = new Set([
  "invalid-status-transition",
  "payment-not-found",
  "version-conflict",
]);

const isAppError = (error: unknown, codes: Set<string>): error is AppError =>
  error instanceof AppError && codes.has(error.code);

const SETTLED_CODES = new Set(["invalid-status-transition"]);

export interface PaymentProcessorOptions {
  concurrency: number;
  gateway: PaymentGateway;
  logger: Logger;
  now?: () => Date;
  payments: Repository<Payment>;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface PaymentProcessor {
  start: () => void;
  stop: () => Promise<void>;
  sweep: () => Promise<void>;
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

export function createPaymentProcessor({
  concurrency,
  gateway,
  logger,
  now = () => new Date(),
  payments,
  pollIntervalMs,
  timeoutMs,
}: PaymentProcessorOptions): PaymentProcessor {
  const inFlight = new Set<string>();
  const tasks = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;

  const claim = async (payment: Payment): Promise<Payment | undefined> => {
    if (payment.status === "processing") {
      logger.info({ paymentId: payment.id }, "payment resumed");
      return payment;
    }
    try {
      const claimed = await transitionPayment(
        payments,
        payment.id,
        "processing",
        { now }
      );
      logger.info({ paymentId: payment.id }, "payment claimed");
      return claimed.payment;
    } catch (err) {
      if (isAppError(err, SKIPPED_CLAIM_CODES)) {
        logger.debug(
          { code: err.code, paymentId: payment.id },
          "payment claim skipped"
        );
      } else {
        logger.error(
          { err, paymentId: payment.id },
          "payment processing failed"
        );
      }
    }
  };

  const charge = async (
    payment: Payment
  ): Promise<GatewayResult | undefined> => {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(TIMED_OUT), timeoutMs);
    try {
      // Racing the abort means a gateway that ignores its signal cannot hold up stop().
      return await Promise.race([
        gateway.charge(
          {
            amount: payment.amount,
            currency: payment.currency,
            paymentId: payment.id,
          },
          { signal: controller.signal }
        ),
        whenAborted(controller.signal),
      ]);
    } catch (err) {
      if (controller.signal.reason === TIMED_OUT) {
        return { outcome: "declined", reason: GATEWAY_TIMEOUT_REASON };
      }
      if (controller.signal.reason !== STOPPED) {
        logger.error(
          { err, paymentId: payment.id },
          "payment processing failed"
        );
      }
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  };

  const record = async (paymentId: string, result: GatewayResult) => {
    const to: PaymentStatus =
      result.outcome === "approved" ? "succeeded" : "failed";
    const failureReason =
      result.outcome === "declined" ? result.reason : undefined;
    try {
      await transitionPayment(payments, paymentId, to, { failureReason, now });
      logger.info(
        { paymentId, status: to, ...(failureReason ? { failureReason } : {}) },
        "payment processed"
      );
    } catch (err) {
      if (isAppError(err, SETTLED_CODES)) {
        const current = await payments.get(paymentId).catch(() => undefined);
        logger.info(
          { paymentId, status: current?.status },
          "payment already settled"
        );
        return;
      }
      logger.error({ err, paymentId }, "payment processing failed");
    }
  };

  const work = async (payment: Payment) => {
    const result = await charge(payment);
    // After stop() nothing new is written, so the payment stays processing and is resumed on the next start.
    if (result === undefined || stopped) {
      return;
    }
    await record(payment.id, result);
  };

  const track = (payment: Payment) => {
    const task = work(payment).finally(() => {
      inFlight.delete(payment.id);
      tasks.delete(task);
    });
    tasks.add(task);
  };

  const runSweep = async () => {
    const free = concurrency - inFlight.size;
    if (free <= 0) {
      return;
    }
    const candidates = (
      await payments.find(
        (payment) =>
          (payment.status === "pending" || payment.status === "processing") &&
          !inFlight.has(payment.id)
      )
    )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, free);
    for (const payment of candidates) {
      inFlight.add(payment.id);
    }
    const claims = await Promise.all(
      candidates.map(async (candidate) => ({
        id: candidate.id,
        payment: await claim(candidate),
      }))
    );
    for (const { id, payment } of claims) {
      if (payment === undefined || stopped) {
        inFlight.delete(id);
      } else {
        track(payment);
      }
    }
  };

  const sweep = (): Promise<void> => {
    if (stopped || running) {
      return Promise.resolve();
    }
    running = runSweep()
      .catch((err: unknown) => {
        logger.error({ err }, "payment sweep failed");
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const tick = async () => {
    await sweep();
    if (!stopped) {
      // Scheduling after each sweep finishes, rather than with setInterval, keeps sweeps from piling up.
      timer = setTimeout(tick, pollIntervalMs);
    }
  };

  return {
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
        for (const controller of controllers) {
          controller.abort(STOPPED);
        }
        await running;
        await Promise.allSettled(tasks);
      })();
      return stopping;
    },
    sweep,
  };
}
