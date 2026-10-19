import { createTransport as createNodemailerTransport } from "nodemailer";

const TIMEOUT_MS = 10_000;

export interface MailMessage {
  from: string;
  html: string;
  messageId: string;
  subject: string;
  text: string;
  to: string;
}

export interface TransportOptions {
  connectionTimeout: number;
  greetingTimeout: number;
  host: string;
  port: number;
  secure: false;
  socketTimeout: number;
}

export interface Transport {
  close: () => void;
  sendMail: (message: MailMessage) => Promise<{ messageId: string }>;
}

export type CreateTransport = (options: TransportOptions) => Transport;

export interface Mailer {
  close: () => Promise<void>;
  send: (message: MailMessage) => Promise<{ messageId: string }>;
}

export function createMailer({
  createTransport = createNodemailerTransport,
  host,
  port,
}: {
  createTransport?: CreateTransport;
  host: string;
  port: number;
}): Mailer {
  // No logger or debug option: nodemailer's own logger would print recipient addresses.
  const transport = createTransport({
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    host,
    port,
    secure: false,
    socketTimeout: TIMEOUT_MS,
  });
  return {
    close: () => {
      transport.close();
      return Promise.resolve();
    },
    send: async (message) => {
      const { messageId } = await transport.sendMail(message);
      return { messageId };
    },
  };
}
