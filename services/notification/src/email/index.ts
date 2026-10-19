// biome-ignore lint/performance/noBarrelFile: module entry point
export {
  createEmailChannel,
  type DeadLetter,
  type DeadLetterFields,
  type DeadLetterReason,
  type EmailChannel,
} from "./email.channel.js";
export { isPermanent, retryDelay } from "./email.retry.js";
export {
  createEmailService,
  EmailSendError,
  type EmailService,
} from "./email.service.js";
export {
  escapeHtml,
  type RenderedEmail,
  renderEmail,
} from "./email.templates.js";
export {
  type CreateTransport,
  createMailer,
  type Mailer,
  type MailMessage,
  type Transport,
  type TransportOptions,
} from "./email.transport.js";
