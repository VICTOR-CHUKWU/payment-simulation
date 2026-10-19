import type { EmailSendError } from "./email.service.js";

export function retryDelay(attempt: number, delays: readonly number[]): number {
  return delays[Math.min(attempt, delays.length) - 1] ?? 0;
}

// nodemailer reports every refused recipient as EENVELOPE, so the SMTP reply code decides first.
export function isPermanent({ code, responseCode }: EmailSendError): boolean {
  if (responseCode !== undefined) {
    return responseCode >= 500 && responseCode < 600;
  }
  return code === "EENVELOPE";
}
