import { randomUUID } from "node:crypto";
import {
  createEvent,
  createLogger,
  createMemoryRepository,
  createPaymentEvent,
  type Role,
} from "@payment-be/shared";
import { SignJWT } from "jose";
import request from "supertest";
import { createApp } from "../app.js";
import { EmailSendError, type EmailService } from "../email/index.js";
import type { Notification } from "../notification/index.js";
import { DLQ_ENTRY_TYPE } from "./dlq.js";
import { createDlqService, type DlqStreams } from "./dlq.service.js";

const SECRET = "s".repeat(32);
const PROBLEM_JSON = /^application\/problem\+json/;
const encoder = new TextEncoder();

function sign(role: Role = "admin"): Promise<string> {
  return new SignJWT({ email: `${role}@example.com`, role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(randomUUID())
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

const logger = createLogger({
  level: "silent",
  pretty: false,
  service: "test",
});

const entry = () =>
  createEvent(DLQ_ENTRY_TYPE, {
    attempts: 5,
    channel: "email",
    code: "ESOCKET",
    event: createPaymentEvent("payment.succeeded", {
      amount: 150_000,
      currency: "NGN",
      email: "ada@example.com",
      paymentId: randomUUID(),
      userId: randomUUID(),
    }),
    reason: "exhausted",
  });

function setup(emailService: EmailService = { send: () => Promise.resolve() }) {
  const entries = [entry(), entry()];
  const messages = new Map(
    entries.map((e, i) => [i + 1, encoder.encode(JSON.stringify(e))])
  );
  const jsm: DlqStreams = {
    streams: {
      deleteMessage: (_stream, seq) => Promise.resolve(messages.delete(seq)),
      getMessage: (_stream, { seq }) => {
        const data = messages.get(seq);
        return Promise.resolve(data === undefined ? null : { data, seq });
      },
      info: () =>
        Promise.resolve({
          state: { first_seq: 1, last_seq: 2, messages: messages.size },
        }),
    },
  };
  const app = createApp({
    checks: [],
    dlq: createDlqService({ emailService, jsm }),
    docs: false,
    jwtSecret: SECRET,
    logger,
    notifications: createMemoryRepository<Notification>(),
  });
  return { app, entries, messages };
}

const call = (
  app: ReturnType<typeof setup>["app"],
  method: "get" | "post",
  path: string,
  token?: string
) => {
  const req = request(app)[method](path);
  if (token !== undefined) {
    req.set("authorization", `Bearer ${token}`);
  }
  return req;
};

const ROUTES = [
  ["get", "/admin/dlq"],
  ["get", "/admin/dlq/1"],
  ["post", "/admin/dlq/1/replay"],
] as const;

describe("admin DLQ routes", () => {
  it.each(ROUTES)("%s %s returns 401 without a token", async (method, path) => {
    const res = await call(setup().app, method, path);
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
  });

  it.each(ROUTES)("%s %s returns 403 for a user", async (method, path) => {
    const { app, messages } = setup();
    const res = await call(app, method, path, await sign("user"));
    expect(res.status).toBe(403);
    expect(messages.size).toBe(2);
  });

  it("lists entries newest first for an admin", async () => {
    const { app, entries } = setup();
    const res = await call(app, "get", "/admin/dlq", await sign());
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({
      limit: 20,
      page: 1,
      total: 2,
      totalPages: 1,
    });
    expect(res.body.data.map((item: { seq: number }) => item.seq)).toEqual([
      2, 1,
    ]);
    expect(res.body.data[0]).toMatchObject({
      deadLetteredAt: entries[1]?.occurredAt,
      reason: "exhausted",
    });
  });

  it("gets one entry", async () => {
    const { app, entries } = setup();
    const res = await call(app, "get", "/admin/dlq/1", await sign());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      event: { eventId: entries[0]?.data.event.eventId },
      seq: 1,
    });
  });

  it("replays an entry and deletes it", async () => {
    const { app, entries, messages } = setup();
    const res = await call(app, "post", "/admin/dlq/1/replay", await sign());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: { eventId: entries[0]?.data.event.eventId, seq: 1 },
      message: "Email sent",
    });
    expect(messages.has(1)).toBe(false);
  });

  it("returns 502 email-send-failed when the replay cannot send", async () => {
    const { app, messages } = setup({
      send: () => Promise.reject(new EmailSendError({ code: "ESOCKET" })),
    });
    const res = await call(app, "post", "/admin/dlq/1/replay", await sign());
    expect(res.status).toBe(502);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("email-send-failed");
    expect(res.body.detail).toContain("ESOCKET");
    expect(messages.has(1)).toBe(true);
  });

  it("returns 409 replay-in-progress for a second replay of the same entry", async () => {
    const { promise: pending, resolve } = Promise.withResolvers<void>();
    const { app } = setup({ send: () => pending });
    const token = await sign();
    const first = call(app, "post", "/admin/dlq/1/replay", token).then(
      (r) => r
    );
    await new Promise((done) => setTimeout(done, 20));
    const second = await call(app, "post", "/admin/dlq/1/replay", token);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("replay-in-progress");
    resolve();
    expect((await first).status).toBe(200);
  });

  it("returns 500 internal-error when the DLQ stream cannot be read", async () => {
    const app = createApp({
      checks: [],
      dlq: createDlqService({
        emailService: { send: () => Promise.resolve() },
        jsm: {
          streams: {
            deleteMessage: () => Promise.resolve(true),
            getMessage: () => Promise.reject(new Error("nats down")),
            info: () => Promise.reject(new Error("nats down")),
          },
        },
      }),
      docs: false,
      jwtSecret: SECRET,
      logger,
      notifications: createMemoryRepository<Notification>(),
    });
    const res = await call(app, "get", "/admin/dlq", await sign());
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal-error");
  });

  it.each([
    ["get", "/admin/dlq/0"],
    ["get", "/admin/dlq/abc"],
    ["get", "/admin/dlq/1.5"],
    ["post", "/admin/dlq/0/replay"],
    ["get", "/admin/dlq?foo=1"],
    ["get", "/admin/dlq?limit=101"],
  ] as const)("%s %s returns 400", async (method, path) => {
    const res = await call(setup().app, method, path, await sign());
    expect(res.status).toBe(400);
  });

  it.each([
    ["get", "/admin/dlq/9"],
    ["post", "/admin/dlq/9/replay"],
  ] as const)("%s %s returns 404 dlq-entry-not-found", async (method, path) => {
    const res = await call(setup().app, method, path, await sign());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("dlq-entry-not-found");
  });
});
