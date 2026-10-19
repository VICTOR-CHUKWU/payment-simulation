import { randomUUID } from "node:crypto";
import {
  createPayment,
  DEMO,
  emailsFor,
  login,
  logsMatching,
  mailpit,
  messageIdFor,
  type Services,
  startServices,
  stopServices,
  waitFor,
  waitForNotifications,
  waitForStatus,
} from "./harness.js";

describe("payment event flow", () => {
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

  it("settles a payment and notifies its owner in-app and by email", async () => {
    const correlationId = `int-${randomUUID()}`;
    const payment = await createPayment(token, {
      "x-request-id": correlationId,
    });

    await waitForStatus(token, payment.id, "succeeded", services);
    const notifications = await waitForNotifications(
      token,
      payment.id,
      ["payment.created", "payment.succeeded"],
      services
    );
    expect(notifications.map((n) => n.type).sort()).toEqual([
      "payment.created",
      "payment.succeeded",
    ]);

    const eventIds = notifications.map((n) => n.id);
    const emails = await waitFor(
      async () => {
        const found = await emailsFor(eventIds);
        return found.length === 2 ? found : undefined;
      },
      { description: "both emails in Mailpit", services }
    );
    for (const notification of notifications) {
      const email = emails.find(
        (m) => m.MessageID === messageIdFor(notification.id)
      );
      expect(email?.Subject).toBe(
        notification.type === "payment.created"
          ? "Payment received"
          : "Payment succeeded"
      );
      expect(email?.To.map((to) => to.Address)).toEqual([DEMO.user.email]);
    }

    for (const eventId of eventIds) {
      expect(
        logsMatching(services, "payment", {
          correlationId,
          eventId,
          msg: "event published",
        }).length
      ).toBeGreaterThanOrEqual(1);
      const received = logsMatching(services, "notification", {
        correlationId,
        eventId,
        msg: "event received",
      });
      expect(new Set(received.map((line) => line.channel))).toEqual(
        new Set(["email", "inapp"])
      );
    }
  });
});
