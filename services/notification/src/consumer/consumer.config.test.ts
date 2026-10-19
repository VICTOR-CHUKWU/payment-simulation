import { AckPolicy, DeliverPolicy } from "@payment-be/shared";
import { CHANNELS } from "../inbox/index.js";
import {
  CHANNEL_CONSUMERS,
  EMAIL_CONSUMER,
  INAPP_CONSUMER,
} from "./consumer.config.js";

describe("consumer definitions", () => {
  it("has one consumer per channel with distinct durable names", () => {
    expect(CHANNEL_CONSUMERS).toEqual({
      email: EMAIL_CONSUMER,
      inapp: INAPP_CONSUMER,
    });
    expect(Object.keys(CHANNEL_CONSUMERS).sort()).toEqual([...CHANNELS].sort());
    expect(INAPP_CONSUMER.durable_name).toBe("notification-inapp");
    expect(EMAIL_CONSUMER.durable_name).toBe("notification-email");
  });

  it.each(CHANNELS)("reads every payment event for %s", (channel) => {
    expect(CHANNEL_CONSUMERS[channel]).toMatchObject({
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: "payment.>",
    });
  });
});
