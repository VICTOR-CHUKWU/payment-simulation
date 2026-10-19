import type { PaymentEvent } from "@payment-be/shared";
import { renderNotification } from "../notification/index.js";

export interface RenderedEmail {
  html: string;
  subject: string;
  text: string;
}

const FOOTER = "Sent by the payment simulation.";

const HTML_ESCAPES: Record<string, string> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

export function renderEmail(event: PaymentEvent): RenderedEmail | undefined {
  const rendered = renderNotification(event);
  if (rendered === undefined) {
    return;
  }
  const { message, title } = rendered;
  const paymentId = `Payment ID: ${event.data.paymentId}`;
  return {
    html: [
      '<div style="font-family: Arial, sans-serif; color: #1f2937; max-width: 560px; padding: 24px;">',
      `<h1 style="font-size: 20px; margin: 0 0 16px;">${escapeHtml(title)}</h1>`,
      `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;">${escapeHtml(message)}</p>`,
      `<p style="font-size: 13px; color: #4b5563; margin: 0 0 24px;">${escapeHtml(paymentId)}</p>`,
      `<p style="font-size: 12px; color: #9ca3af; margin: 0;">${escapeHtml(FOOTER)}</p>`,
      "</div>",
    ].join("\n"),
    subject: title,
    text: [message, "", paymentId, "", FOOTER].join("\n"),
  };
}
