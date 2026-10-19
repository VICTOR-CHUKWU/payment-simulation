import type { Currency } from "../payment/index.js";

export interface GatewayCharge {
  amount: number;
  currency: Currency;
  paymentId: string;
}

export type GatewayResult =
  | { outcome: "approved" }
  | { outcome: "declined"; reason: string };

export interface PaymentGateway {
  charge: (
    charge: GatewayCharge,
    options: { signal: AbortSignal }
  ) => Promise<GatewayResult>;
}

export const DECLINE_REASONS = [
  "Card declined",
  "Insufficient funds",
  "Issuer unavailable",
] as const;

export interface SimulatedGatewayOptions {
  failureRate: number;
  maxDelayMs: number;
  minDelayMs: number;
  random?: () => number;
  timeoutRate: number;
}

const abortError = (signal: AbortSignal) =>
  new DOMException(
    signal.reason instanceof Error ? signal.reason.message : "Aborted",
    "AbortError"
  );

function wait(ms: number | undefined, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer =
      ms === undefined
        ? undefined
        : setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createSimulatedGateway({
  failureRate,
  maxDelayMs,
  minDelayMs,
  random = Math.random,
  timeoutRate,
}: SimulatedGatewayOptions): PaymentGateway {
  return {
    async charge(_charge, { signal }) {
      if (random() < timeoutRate) {
        await wait(undefined, signal);
      }
      await wait(
        minDelayMs + Math.floor(random() * (maxDelayMs - minDelayMs + 1)),
        signal
      );
      if (random() < failureRate) {
        const index = Math.floor(random() * DECLINE_REASONS.length);
        return {
          outcome: "declined",
          reason: DECLINE_REASONS[index] ?? DECLINE_REASONS[0],
        };
      }
      return { outcome: "approved" };
    },
  };
}
