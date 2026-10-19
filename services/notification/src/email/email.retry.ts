import type { EmailSendError } from "./email.service.js";

export function retryDelay(attempt: number, delays: readonly number[]): number {
  return delays[Math.min(attempt, delays.length) - 1] ?? 0;
}

export function isPermanent({ code, responseCode }: EmailSendError): boolean {
  return (
    code === "EENVELOPE" ||
    (responseCode !== undefined && responseCode >= 500 && responseCode < 600)
  );
}
