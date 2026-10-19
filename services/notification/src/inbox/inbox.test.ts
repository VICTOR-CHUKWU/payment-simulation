import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRepository } from "@payment-be/shared";
import { type InboxRecord, inboxId, inboxRecordSchema } from "./inbox.js";

const EVENT_ID = randomUUID();

const record: InboxRecord = {
  channel: "email",
  eventId: EVENT_ID,
  id: `email:${EVENT_ID}`,
  processedAt: new Date().toISOString(),
  type: "payment.succeeded",
  version: 1,
};

describe("inboxId", () => {
  it("joins the channel and event ID", () => {
    expect(inboxId("inapp", EVENT_ID)).toBe(`inapp:${EVENT_ID}`);
  });
});

describe("inboxRecordSchema", () => {
  it("accepts a valid record", () => {
    expect(inboxRecordSchema.parse(record)).toEqual(record);
  });

  it.each([
    ["an unknown channel", { channel: "sms" }],
    ["a non-UUID eventId", { eventId: "evt-1" }],
    ["an empty type", { type: "" }],
    ["an unknown key", { email: "ada@example.com" }],
  ])("rejects %s", (_label, change) => {
    expect(inboxRecordSchema.safeParse({ ...record, ...change }).success).toBe(
      false
    );
  });

  it("accepts a type outside the current catalogue", () => {
    expect(
      inboxRecordSchema.safeParse({ ...record, type: "payment.refunded" })
        .success
    ).toBe(true);
  });
});

describe("inbox file storage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "payment-be-inbox-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const open = () =>
    openRepository({
      config: { DATA_DIR: dir, STORAGE_DRIVER: "file" },
      name: "inbox",
      schema: inboxRecordSchema,
    });

  it("keeps markers across a restart", async () => {
    const first = await open();
    const { version: _version, ...fresh } = record;
    await first.repository.insert(fresh);
    await first.close();

    const second = await open();
    expect(await second.repository.get(record.id)).toEqual(record);
    await second.close();
  });
});
