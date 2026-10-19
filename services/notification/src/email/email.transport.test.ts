import {
  createMailer,
  type MailMessage,
  type TransportOptions,
} from "./email.transport.js";

function fakeTransport() {
  const calls: {
    close: number;
    options?: TransportOptions;
    sent: MailMessage[];
  } = {
    close: 0,
    sent: [],
  };
  const createTransport = (options: TransportOptions) => {
    calls.options = options;
    return {
      close: () => {
        calls.close += 1;
      },
      sendMail: (message: MailMessage) => {
        calls.sent.push(message);
        return Promise.resolve({ envelope: {}, messageId: message.messageId });
      },
    };
  };
  return { calls, createTransport };
}

const sample: MailMessage = {
  from: "Payments <no-reply@example.test>",
  html: "<p>hi</p>",
  messageId: "<id@payment-simulation.local>",
  subject: "Payment succeeded",
  text: "hi",
  to: "ada@example.com",
};

describe("createMailer", () => {
  it("creates an SMTP transport with plain connections and 10 s timeouts", () => {
    const { calls, createTransport } = fakeTransport();
    createMailer({ createTransport, host: "mail.local", port: 2525 });
    expect(calls.options).toEqual({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      host: "mail.local",
      port: 2525,
      secure: false,
      socketTimeout: 10_000,
    });
  });

  it("sends through the transport and returns only the message ID", async () => {
    const { calls, createTransport } = fakeTransport();
    const mailer = createMailer({ createTransport, host: "h", port: 1 });
    await expect(mailer.send(sample)).resolves.toEqual({
      messageId: sample.messageId,
    });
    expect(calls.sent).toEqual([sample]);
  });

  it("closes the transport", async () => {
    const { calls, createTransport } = fakeTransport();
    const mailer = createMailer({ createTransport, host: "h", port: 1 });
    await mailer.close();
    expect(calls.close).toBe(1);
  });

  it("works with nodemailer's real transport factory", async () => {
    const mailer = createMailer({ host: "localhost", port: 1 });
    await expect(mailer.close()).resolves.toBeUndefined();
  });
});
