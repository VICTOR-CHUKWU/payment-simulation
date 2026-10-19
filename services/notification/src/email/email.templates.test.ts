import { randomUUID } from "node:crypto";
import { createPaymentEvent, type PaymentEventType } from "@payment-be/shared";
import { escapeHtml, renderEmail } from "./email.templates.js";

const event = (type: PaymentEventType, description?: string) =>
  createPaymentEvent(type, {
    amount: 150_000,
    currency: "NGN",
    email: "ada@example.com",
    paymentId: randomUUID(),
    userId: randomUUID(),
    ...(description === undefined ? {} : { description }),
    ...(type === "payment.failed" ? { failureReason: "Card declined" } : {}),
  });

describe("renderEmail", () => {
  it.each([
    ["payment.created", "Payment received"],
    ["payment.succeeded", "Payment succeeded"],
    ["payment.failed", "Payment failed"],
    ["payment.cancelled", "Payment cancelled"],
  ] as const)("renders %s", (type, subject) => {
    const e = event(type);
    const email = renderEmail(e);
    expect(email?.subject).toBe(subject);
    for (const body of [email?.text, email?.html]) {
      expect(body).toContain("NGN 1,500.00");
      expect(body).toContain(`Payment ID: ${e.data.paymentId}`);
    }
    expect(email?.html).toContain(
      `<h1 style="font-size: 20px; margin: 0 0 16px;">${subject}</h1>`
    );
  });

  it("returns undefined for payment.processing", () => {
    expect(renderEmail(event("payment.processing"))).toBeUndefined();
  });

  it("escapes the description in the HTML and keeps it verbatim in the text", () => {
    const description = `<b>"x" & 'y'</b>`;
    const email = renderEmail(event("payment.succeeded", description));
    expect(email?.text).toContain(`for ${description} succeeded.`);
    expect(email?.html).toContain(
      "for &lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt; succeeded."
    );
    expect(email?.html).not.toContain("<b>");
  });

  it("includes the failure reason in a failed email", () => {
    const email = renderEmail(event("payment.failed"));
    expect(email?.text).toContain("failed: Card declined.");
    expect(email?.html).toContain("failed: Card declined.");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;"
    );
  });
});
