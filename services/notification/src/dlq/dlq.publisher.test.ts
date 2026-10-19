import { randomUUID } from "node:crypto";
import {
  CORRELATION_ID_HEADER,
  createPaymentEvent,
  type JetStreamClient,
} from "@payment-be/shared";
import { DLQ_EMAIL_SUBJECT, DLQ_ENTRY_TYPE, dlqEntrySchema } from "./dlq.js";
import { createDeadLetterPublisher } from "./dlq.publisher.js";

type Publish = Pick<JetStreamClient, "publish">["publish"];

function stubClient() {
  const calls: Parameters<Publish>[] = [];
  const js: Pick<JetStreamClient, "publish"> = {
    publish: (...args) => {
      calls.push(args);
      return Promise.resolve({
        domain: "",
        duplicate: false,
        seq: 9,
        stream: "DLQ",
      });
    },
  };
  return { calls, js };
}

describe("createDeadLetterPublisher", () => {
  it("publishes a dead-letter entry to dlq.email and returns its sequence", async () => {
    const { calls, js } = stubClient();
    const event = createPaymentEvent("payment.created", {
      amount: 2000,
      currency: "EUR",
      email: "ada@example.com",
      paymentId: randomUUID(),
      userId: randomUUID(),
    });
    await expect(
      createDeadLetterPublisher(js)(
        { attempts: 5, code: "ESOCKET", event, reason: "exhausted" },
        "req-1"
      )
    ).resolves.toEqual({ seq: 9 });
    expect(calls).toHaveLength(1);
    const [subject, payload, options] = calls[0] ?? [];
    expect(subject).toBe(DLQ_EMAIL_SUBJECT);
    const entry = dlqEntrySchema.parse(JSON.parse(String(payload)));
    expect(entry).toMatchObject({
      data: {
        attempts: 5,
        channel: "email",
        code: "ESOCKET",
        event,
        reason: "exhausted",
      },
      type: DLQ_ENTRY_TYPE,
    });
    expect(options?.msgID).toBe(entry.eventId);
    expect(options?.headers?.get(CORRELATION_ID_HEADER)).toBe("req-1");
  });
});
