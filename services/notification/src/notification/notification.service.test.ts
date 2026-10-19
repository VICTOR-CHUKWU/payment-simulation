import { randomUUID } from "node:crypto";
import {
  AppError,
  createMemoryRepository,
  createPaymentEvent,
  type PaymentEvent,
  type PaymentEventType,
  type Repository,
  VersionConflictError,
} from "@payment-be/shared";
import type { Notification } from "./notification.js";
import { createNotificationService } from "./notification.service.js";

const USER = randomUUID();
const OTHER = randomUUID();
const READ_AT = "2026-10-19T12:00:00.000Z";

const event = (
  type: PaymentEventType = "payment.succeeded",
  userId = USER,
  occurredAt?: string
): PaymentEvent => {
  const created = createPaymentEvent(type, {
    amount: 150_000,
    currency: "NGN",
    email: "ada@example.com",
    paymentId: randomUUID(),
    userId,
    ...(type === "payment.failed" ? { failureReason: "declined" } : {}),
  });
  return occurredAt === undefined ? created : { ...created, occurredAt };
};

function setup(repository = createMemoryRepository<Notification>()) {
  const service = createNotificationService(repository, {
    now: () => new Date(READ_AT),
  });
  return { repository, service };
}

const notFoundCode = (err: unknown) =>
  err instanceof AppError ? err.code : undefined;

describe("record", () => {
  it("stores a notification keyed by the event ID", async () => {
    const { repository, service } = setup();
    const e = event();
    await service.record(e);
    const stored = await repository.get(e.eventId);
    expect(stored).toMatchObject({
      amount: 150_000,
      createdAt: e.occurredAt,
      currency: "NGN",
      id: e.eventId,
      paymentId: e.data.paymentId,
      readAt: null,
      title: "Payment succeeded",
      type: "payment.succeeded",
      userId: USER,
    });
    expect(JSON.stringify(stored)).not.toContain("ada@example.com");
  });

  it("stores one notification when the same event is recorded twice", async () => {
    const { repository, service } = setup();
    const e = event();
    await service.record(e);
    await expect(service.record(e)).resolves.toBeUndefined();
    expect(await repository.find()).toHaveLength(1);
  });

  it("stores nothing for payment.processing", async () => {
    const { repository, service } = setup();
    await service.record(event("payment.processing"));
    expect(await repository.find()).toEqual([]);
  });

  it("rethrows other insert errors", async () => {
    const failing = {
      ...createMemoryRepository<Notification>(),
      insert: () => Promise.reject(new Error("disk full")),
    };
    const { service } = setup(failing);
    await expect(service.record(event())).rejects.toThrow("disk full");
  });
});

describe("list", () => {
  async function seed() {
    const ctx = setup();
    await ctx.service.record(
      event("payment.created", USER, "2026-10-19T10:00:00Z")
    );
    await ctx.service.record(
      event("payment.succeeded", USER, "2026-10-19T10:00:00.500Z")
    );
    await ctx.service.record(
      event("payment.failed", USER, "2026-10-19T09:00:00.000Z")
    );
    await ctx.service.record(event("payment.created", OTHER));
    return ctx;
  }

  it("returns only the caller's notifications, newest first", async () => {
    const { service } = await seed();
    const { items, meta } = await service.list(USER, { limit: 20, page: 1 });
    expect(items.map((item) => item.type)).toEqual([
      "payment.succeeded",
      "payment.created",
      "payment.failed",
    ]);
    expect(items.every((item) => item.userId === USER)).toBe(true);
    expect(items[0]).not.toHaveProperty("version");
    expect(meta).toEqual({ limit: 20, page: 1, total: 3, totalPages: 1 });
  });

  it("breaks a createdAt tie by id, descending", async () => {
    const { service } = setup();
    const at = "2026-10-19T10:00:00.000Z";
    const a = event("payment.created", USER, at);
    const b = event("payment.succeeded", USER, at);
    await service.record(a);
    await service.record(b);
    const { items } = await service.list(USER, { limit: 20, page: 1 });
    expect(items.map((item) => item.id)).toEqual(
      [a.eventId, b.eventId].sort().reverse()
    );
  });

  it("pages results", async () => {
    const { service } = await seed();
    const second = await service.list(USER, { limit: 2, page: 2 });
    expect(second.items.map((item) => item.type)).toEqual(["payment.failed"]);
    expect(second.meta).toEqual({ limit: 2, page: 2, total: 3, totalPages: 2 });
  });

  it("returns an empty page past the end", async () => {
    const { service } = await seed();
    expect(await service.list(USER, { limit: 2, page: 5 })).toEqual({
      items: [],
      meta: { limit: 2, page: 5, total: 3, totalPages: 2 },
    });
  });

  it("reports zero pages when there are none", async () => {
    const { service } = setup();
    expect((await service.list(USER, { limit: 20, page: 1 })).meta).toEqual({
      limit: 20,
      page: 1,
      total: 0,
      totalPages: 0,
    });
  });

  it("filters on unread", async () => {
    const { service } = await seed();
    const [first] = (await service.list(USER, { limit: 20, page: 1 })).items;
    await service.markRead(USER, first?.id ?? "");
    const unread = await service.list(USER, {
      limit: 20,
      page: 1,
      unread: true,
    });
    const read = await service.list(USER, {
      limit: 20,
      page: 1,
      unread: false,
    });
    expect(unread.meta.total).toBe(2);
    expect(unread.items.every((item) => item.readAt === null)).toBe(true);
    expect(read.items.map((item) => item.id)).toEqual([first?.id]);
  });
});

describe("markRead", () => {
  it("sets readAt", async () => {
    const { service } = setup();
    const e = event();
    await service.record(e);
    expect(await service.markRead(USER, e.eventId)).toMatchObject({
      id: e.eventId,
      readAt: READ_AT,
    });
  });

  it("keeps the first readAt when marked again", async () => {
    const repository = createMemoryRepository<Notification>();
    const e = event();
    await setup(repository).service.record(e);
    await setup(repository).service.markRead(USER, e.eventId);
    const later = createNotificationService(repository, {
      now: () => new Date("2026-10-20T00:00:00.000Z"),
    });
    expect((await later.markRead(USER, e.eventId)).readAt).toBe(READ_AT);
  });

  it("returns 404 for an unknown ID", async () => {
    const { service } = setup();
    const err = await service.markRead(USER, randomUUID()).catch((e) => e);
    expect(notFoundCode(err)).toBe("notification-not-found");
  });

  it("returns 404 for another user's notification", async () => {
    const { repository, service } = setup();
    const e = event("payment.created", OTHER);
    await service.record(e);
    const err = await service.markRead(USER, e.eventId).catch((x) => x);
    expect(notFoundCode(err)).toBe("notification-not-found");
    expect((await repository.get(e.eventId))?.readAt).toBeNull();
  });

  it("retries after a version conflict", async () => {
    const inner = createMemoryRepository<Notification>();
    let conflicts = 1;
    const repository: Repository<Notification> = {
      ...inner,
      update: (id, version, patch) => {
        if (conflicts > 0) {
          conflicts -= 1;
          return Promise.reject(new VersionConflictError({ id }));
        }
        return inner.update(id, version, patch);
      },
    };
    const { service } = setup(repository);
    const e = event();
    await service.record(e);
    expect((await service.markRead(USER, e.eventId)).readAt).toBe(READ_AT);
  });
});

describe("markRead conflicts", () => {
  it("rethrows the version conflict after 3 attempts", async () => {
    const inner = createMemoryRepository<Notification>();
    let updates = 0;
    const repository: Repository<Notification> = {
      ...inner,
      update: (id) => {
        updates += 1;
        return Promise.reject(new VersionConflictError({ id }));
      },
    };
    const { service } = setup(repository);
    const e = event();
    await service.record(e);
    await expect(service.markRead(USER, e.eventId)).rejects.toBeInstanceOf(
      VersionConflictError
    );
    expect(updates).toBe(3);
  });

  it("rethrows an update error other than a version conflict at once", async () => {
    const inner = createMemoryRepository<Notification>();
    let updates = 0;
    const repository: Repository<Notification> = {
      ...inner,
      update: () => {
        updates += 1;
        return Promise.reject(new Error("disk full"));
      },
    };
    const { service } = setup(repository);
    const e = event();
    await service.record(e);
    await expect(service.markRead(USER, e.eventId)).rejects.toThrow(
      "disk full"
    );
    expect(updates).toBe(1);
  });
});

describe("markAllRead", () => {
  it("marks only the caller's unread notifications and counts them", async () => {
    const repository = createMemoryRepository<Notification>();
    const early = createNotificationService(repository, {
      now: () => new Date("2026-10-19T08:00:00.000Z"),
    });
    const { service } = setup(repository);
    const read = event("payment.created");
    const unread = [event("payment.succeeded"), event("payment.failed")];
    const other = event("payment.created", OTHER);
    for (const e of [read, ...unread, other]) {
      // biome-ignore lint/performance/noAwaitInLoops: seed in order
      await service.record(e);
    }
    await early.markRead(USER, read.eventId);
    expect(await service.markAllRead(USER)).toEqual({ updated: 2 });
    expect((await repository.get(read.eventId))?.readAt).toBe(
      "2026-10-19T08:00:00.000Z"
    );
    for (const e of unread) {
      // biome-ignore lint/performance/noAwaitInLoops: read in order
      expect((await repository.get(e.eventId))?.readAt).toBe(READ_AT);
    }
    expect((await repository.get(other.eventId))?.readAt).toBeNull();
    expect(await service.markAllRead(USER)).toEqual({ updated: 0 });
  });
});
