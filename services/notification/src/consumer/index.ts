// biome-ignore lint/performance/noBarrelFile: module entry point
export { consumersCheck } from "./consumer.check.js";
export {
  CHANNEL_CONSUMERS,
  CHANNELS,
  type Channel,
  EMAIL_CONSUMER,
  INAPP_CONSUMER,
} from "./consumer.config.js";
export {
  type ConsumerMessage,
  createEventHandler,
  type EventHandlerOptions,
} from "./consumer.handler.js";
