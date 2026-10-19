import { randomUUID } from "node:crypto";
import {
  createLogger,
  createMemoryRepository,
  createPaymentEvent,
  type PaymentEventType,
  type Role,
} from "@payment-be/shared";
import { SignJWT } from "jose";
import request from "supertest";
import { createApp } from "../app.js";
import { createNotificationService, type Notification } from "./index.js";

const SECRET = "s".repeat(32);
const PROBLEM_JSON = /^application\/problem\+json/;
const NOT_FOUND_TYPE = /notification-not-found$/;
const EMAIL = "ada@example.com";

const USER = randomUUID();
const OTHER = randomUUID();
const ADMIN = randomUUID();

function sign({
  role = "user",
  sub = USER,
}: {
  role?: Role;
  sub?: string;
} = {}): Promise<string> {
  return new SignJWT({ email: EMAIL, role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

const logger = createLogger({
  level: "silent",
  pretty: false,
  service: "test",
});

async function setup() {
  const notifications = createMemoryRepository<Notification>();
  const service = createNotificationService(notifications);
  const record = (type: PaymentEventType, userId: string, minute: number) => {
    const event = createPaymentEvent(type, {
      amount: 150_000,
      currency: "NGN",
      email: EMAIL,
      paymentId: randomUUID(),
      userId,
      ...(type === "payment.failed" ? { failureReason: "declined" } : {}),
    });
    const occurredAt = `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000Z`;
    return service.record({ ...event, occurredAt }).then(() => event.eventId);
  };
  const ids = {
    admin: await record("payment.created", ADMIN, 5),
    created: await record("payment.created", USER, 1),
    other: await record("payment.created", OTHER, 3),
    succeeded: await record("payment.succeeded", USER, 2),
  };
  const app = createApp({
    checks: [],
    docs: false,
    jwtSecret: SECRET,
    logger,
    notifications,
  });
  return { app, ids, notifications };
}

async function get(
  app: Awaited<ReturnType<typeof setup>>["app"],
  path: string,
  token?: string
) {
  const req = request(app).get(path);
  if (token !== undefined) {
    req.set("authorization", `Bearer ${token}`);
  }
  return await req;
}

async function patch(
  app: Awaited<ReturnType<typeof setup>>["app"],
  path: string,
  token?: string
) {
  const req = request(app).patch(path);
  if (token !== undefined) {
    req.set("authorization", `Bearer ${token}`);
  }
  return await req;
}

describe("notification routes", () => {
  it.each([
    ["get", "/notifications"],
    ["patch", "/notifications/read"],
    ["patch", `/notifications/${randomUUID()}/read`],
  ] as const)("%s %s returns 401 without a token", async (method, path) => {
    const { app } = await setup();
    const res = await (method === "get" ? get(app, path) : patch(app, path));
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
  });

  it("returns 404, not 401, for an unknown path", async () => {
    const { app } = await setup();
    const res = await get(app, "/nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /notifications", () => {
  it("lists the caller's notifications newest first in a page envelope", async () => {
    const { app, ids } = await setup();
    const res = await get(app, "/notifications", await sign());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: null,
      meta: { limit: 20, page: 1, total: 2, totalPages: 1 },
      status: 200,
      success: true,
    });
    expect(res.body.data.map((n: Notification) => n.id)).toEqual([
      ids.succeeded,
      ids.created,
    ]);
    expect(res.body.data[0]).toMatchObject({
      readAt: null,
      title: "Payment succeeded",
      userId: USER,
    });
    expect(res.body.data[0]).not.toHaveProperty("version");
    expect(JSON.stringify(res.body)).not.toContain(EMAIL);
  });

  it("applies page and limit", async () => {
    const { app, ids } = await setup();
    const res = await get(app, "/notifications?page=2&limit=1", await sign());
    expect(res.status).toBe(200);
    expect(res.body.data.map((n: Notification) => n.id)).toEqual([ids.created]);
    expect(res.body.meta).toEqual({
      limit: 1,
      page: 2,
      total: 2,
      totalPages: 2,
    });
  });

  it("filters on unread=true and unread=false", async () => {
    const { app, ids } = await setup();
    const token = await sign();
    await patch(app, `/notifications/${ids.created}/read`, token);
    const unread = await get(app, "/notifications?unread=true", token);
    const read = await get(app, "/notifications?unread=false", token);
    expect(unread.body.data.map((n: Notification) => n.id)).toEqual([
      ids.succeeded,
    ]);
    expect(unread.body.meta.total).toBe(1);
    expect(read.body.data.map((n: Notification) => n.id)).toEqual([
      ids.created,
    ]);
  });

  it("shows an admin only their own notifications", async () => {
    const { app, ids } = await setup();
    const res = await get(
      app,
      "/notifications",
      await sign({ role: "admin", sub: ADMIN })
    );
    expect(res.body.data.map((n: Notification) => n.id)).toEqual([ids.admin]);
  });

  it.each([
    "limit=0",
    "limit=101",
    "page=0",
    "page=1.5",
    "unread=yes",
    "foo=1",
    "page=1&page=2",
  ])("returns 400 for ?%s", async (query) => {
    const { app } = await setup();
    const res = await get(app, `/notifications?${query}`, await sign());
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
  });

  it("points the validation error at the query parameter", async () => {
    const { app } = await setup();
    const res = await get(app, "/notifications?limit=0", await sign());
    expect(res.body).toMatchObject({
      code: "validation-error",
      errors: [expect.objectContaining({ pointer: "/limit" })],
    });
  });
});

describe("PATCH /notifications/:id/read", () => {
  it("marks the notification as read", async () => {
    const { app, ids } = await setup();
    const res = await patch(
      app,
      `/notifications/${ids.created}/read`,
      await sign()
    );
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Notification marked as read");
    expect(res.body.data).toMatchObject({
      id: ids.created,
      readAt: expect.any(String),
    });
    expect(res.body.data).not.toHaveProperty("version");
  });

  it("keeps the first readAt when repeated", async () => {
    const { app, ids } = await setup();
    const token = await sign();
    const first = await patch(app, `/notifications/${ids.created}/read`, token);
    const second = await patch(
      app,
      `/notifications/${ids.created}/read`,
      token
    );
    expect(second.status).toBe(200);
    expect(second.body.data.readAt).toBe(first.body.data.readAt);
  });

  it("returns 404 for an unknown ID", async () => {
    const { app } = await setup();
    const res = await patch(
      app,
      `/notifications/${randomUUID()}/read`,
      await sign()
    );
    expect(res.status).toBe(404);
    expect(res.body.type).toMatch(NOT_FOUND_TYPE);
  });

  it("returns 404 for another user's notification and leaves it unread", async () => {
    const { app, ids, notifications } = await setup();
    const res = await patch(
      app,
      `/notifications/${ids.other}/read`,
      await sign()
    );
    expect(res.status).toBe(404);
    expect(res.body.type).toMatch(NOT_FOUND_TYPE);
    expect((await notifications.get(ids.other))?.readAt).toBeNull();
  });

  it("returns 400 for a non-UUID id", async () => {
    const { app } = await setup();
    const res = await patch(app, "/notifications/abc/read", await sign());
    expect(res.status).toBe(400);
  });
});

describe("PATCH /notifications/read", () => {
  it("marks all the caller's unread notifications and returns the count", async () => {
    const { app, ids, notifications } = await setup();
    const token = await sign();
    const res = await patch(app, "/notifications/read", token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: { updated: 2 },
      message: "Notifications marked as read",
    });
    expect((await notifications.get(ids.other))?.readAt).toBeNull();
    const again = await patch(app, "/notifications/read", token);
    expect(again.body.data).toEqual({ updated: 0 });
  });
});
