import { randomUUID } from "node:crypto";
import {
  connectNats,
  drainNats,
  jetstream,
  jetstreamManager,
  PAYMENTS_STREAM,
} from "@payment-be/shared";
import {
  createPayment,
  DEMO,
  emailsFor,
  login,
  logsMatching,
  mailpit,
  NATS_URL,
  notificationsFor,
  type Services,
  startServices,
  stopServices,
  waitFor,
  waitForNotifications,
  waitForStatus,
} from "./harness.js";

describe("duplicate delivery", () => {
  let services: Services;
  let token: string;

  beforeAll(async () => {
    await mailpit.chaos();
    await mailpit.clear();
    services = await startServices();
    token = await login(DEMO.user);
  });

  afterAll(async () => {
    await stopServices();
  });

  it("handles an event delivered twice only once on each channel", async () => {
    const payment = await createPayment(token);
    await waitForStatus(token, payment.id, "succeeded", services);
    const notifications = await waitForNotifications(
      token,
      payment.id,
      ["payment.created", "payment.succeeded"],
      services
    );
    const eventIds = notifications.map((n) => n.id);
    await waitFor(
      async () => ((await emailsFor(eventIds)).length === 2 ? true : undefined),
      { description: "both emails in Mailpit", services }
    );

    const nc = await connectNats({ name: "integration-test", url: NATS_URL });
    try {
      const stored = await (await jetstreamManager(nc)).streams.getMessage(
        PAYMENTS_STREAM.name,
        { last_by_subj: "payment.succeeded" }
      );
      if (stored === null) {
        throw new Error("No payment.succeeded message in PAYMENTS");
      }
      const event = stored.json<{
        data: { paymentId: string };
        eventId: string;
      }>();
      expect(event.data.paymentId).toBe(payment.id);
      await jetstream(nc).publish("payment.succeeded", stored.data, {
        headers: stored.header,
        msgID: randomUUID(),
      });

      const { eventId } = event;
      const skipped = await waitFor(
        () => {
          const lines = logsMatching(services, "notification", {
            eventId,
            msg: "duplicate skipped",
          });
          return lines.length === 2 ? lines : undefined;
        },
        { description: "duplicate skipped on both channels", services }
      );
      expect(skipped.map((line) => line.channel).sort()).toEqual([
        "email",
        "inapp",
      ]);
    } finally {
      await drainNats(nc);
    }

    expect(await notificationsFor(token, payment.id)).toHaveLength(2);
    expect(await emailsFor(eventIds)).toHaveLength(2);
  });
});
