// biome-ignore lint/performance/noBarrelFile: module entry point
export { CHANNELS, type Channel } from "../inbox/index.js";
export { consumersCheck } from "./consumer.check.js";
export {
  CHANNEL_CONSUMERS,
  EMAIL_CONSUMER,
  INAPP_CONSUMER,
} from "./consumer.config.js";
export {
  type ConsumerMessage,
  createEventHandler,
  type EventHandlerOptions,
} from "./consumer.handler.js";
