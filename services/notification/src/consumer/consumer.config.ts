import {
  AckPolicy,
  type ConsumerDefinition,
  DeliverPolicy,
} from "@payment-be/shared";

export const CHANNELS = ["inapp", "email"] as const;

export type Channel = (typeof CHANNELS)[number];

export const INAPP_CONSUMER = {
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  durable_name: "notification-inapp",
  filter_subject: "payment.>",
} as const satisfies ConsumerDefinition;

export const EMAIL_CONSUMER = {
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  durable_name: "notification-email",
  filter_subject: "payment.>",
} as const satisfies ConsumerDefinition;

export const CHANNEL_CONSUMERS: Record<Channel, ConsumerDefinition> = {
  email: EMAIL_CONSUMER,
  inapp: INAPP_CONSUMER,
};
