import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  createLogger,
  createMemoryRepository,
  type Role,
} from "@payment-be/shared";
import { SignJWT } from "jose";
import request from "supertest";
import { createApp } from "../app.js";
import type { Payment } from "./index.js";

const SECRET = "s".repeat(32);
const PROBLEM_JSON = /^application\/problem\+json/;
const KEY_REUSED_TYPE = /idempotency-key-reused$/;
const NOT_FOUND_TYPE = /payment-not-found$/;

const owner = {
  email: "ada@example.com",
  sub: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

function sign({
  role = "user",
  secret = SECRET,
  sub = owner.sub,
}: {
  role?: Role;
  secret?: string;
  sub?: string;
} = {}): Promise<string> {
  return new SignJWT({ email: owner.email, role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

function setup() {
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      raw.push(...chunk.toString().split("\n").filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({
    destination,
    level: "info",
    pretty: false,
    service: "test",
  });
  const payments = createMemoryRepository<Payment>();
  const app = createApp({
    checks: [],
    docs: false,
    jwtSecret: SECRET,
    logger,
    payments,
  });
  return { app, payments, raw };
}

async function create(
  app: ReturnType<typeof setup>["app"],
  body: unknown,
  token?: string
) {
  const req = request(app).post("/payments");
  if (token !== undefined) {
    req.set("authorization", `Bearer ${token}`);
  }
  return await req.send(body as object);
}

const valid = { amount: 150_000, currency: "NGN", description: "Order #42" };

describe("POST /payments", () => {
  it("creates a pending payment owned by the caller", async () => {
    const { app, payments } = setup();

    const res = await create(app, valid, await sign());

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: {
        ...valid,
        createdAt: expect.any(String),
        email: owner.email,
        id: expect.any(String),
        status: "pending",
        updatedAt: res.body.data.createdAt,
        userId: owner.sub,
      },
      message: "Payment created",
      status: 201,
      success: true,
    });
    expect(res.body.data).not.toHaveProperty("version");
    expect(await payments.get(res.body.data.id)).toEqual({
      ...res.body.data,
      version: 1,
    });
  });

  it("lets an admin create a payment", async () => {
    const { app } = setup();

    const res = await create(app, valid, await sign({ role: "admin" }));

    expect(res.status).toBe(201);
  });

  it("logs the payment id without the email", async () => {
    const { app, raw } = setup();

    const res = await create(app, valid, await sign());

    const line = raw
      .map((entry) => JSON.parse(entry))
      .find((entry) => entry.msg === "payment created");
    expect(line).toMatchObject({
      paymentId: res.body.data.id,
      userId: owner.sub,
    });
    expect(raw.join("\n")).not.toContain(owner.email);
  });

  it("returns 401 without a token", async () => {
    const { app, payments } = setup();

    const res = await create(app, valid);

    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("unauthorized");
    expect(await payments.find()).toEqual([]);
  });

  it("returns 401 for a token signed with another secret", async () => {
    const { app } = setup();

    const res = await create(
      app,
      valid,
      await sign({ secret: "o".repeat(32) })
    );

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid-token");
  });

  it("returns 401 before reading a malformed body", async () => {
    const { app } = setup();

    const res = await request(app)
      .post("/payments")
      .set("content-type", "application/json")
      .send("{");

    expect(res.status).toBe(401);
  });

  it.each([
    ["a float amount", { amount: 10.5 }],
    ["a zero amount", { amount: 0 }],
    ["a negative amount", { amount: -100 }],
    ["a string amount", { amount: "100" }],
    ["an unknown currency", { currency: "JPY" }],
    ["a lowercase currency", { currency: "ngn" }],
    ["a 141-character description", { description: "x".repeat(141) }],
    ["a missing amount", { amount: undefined }],
    ["a missing currency", { currency: undefined }],
    ["a status", { status: "succeeded" }],
    ["a userId", { userId: randomUUID() }],
    ["an email", { email: "eve@example.com" }],
    ["an idempotencyKey", { idempotencyKey: "order-42" }],
  ])("returns 400 for %s", async (_label, override) => {
    const { app, payments } = setup();

    const res = await create(app, { ...valid, ...override }, await sign());

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("validation-error");
    expect(await payments.find()).toEqual([]);
  });

  it("returns 400 for malformed JSON", async () => {
    const { app } = setup();

    const res = await request(app)
      .post("/payments")
      .set("authorization", `Bearer ${await sign()}`)
      .set("content-type", "application/json")
      .send("{");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("malformed-json");
  });

  it("returns 400 for a non-JSON body", async () => {
    const { app } = setup();

    const res = await request(app)
      .post("/payments")
      .set("authorization", `Bearer ${await sign()}`)
      .set("content-type", "text/plain")
      .send("amount=100");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation-error");
  });

  it("returns 413 for a body over 16kb", async () => {
    const { app } = setup();

    const res = await create(
      app,
      { ...valid, description: "x".repeat(17 * 1024) },
      await sign()
    );

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("payload-too-large");
  });

  it("returns 415 for an unsupported charset", async () => {
    const { app } = setup();

    const res = await request(app)
      .post("/payments")
      .set("authorization", `Bearer ${await sign()}`)
      .set("content-type", "application/json; charset=latin1")
      .send(JSON.stringify(valid));

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("unsupported-media-type");
  });
});

describe("POST /payments with an Idempotency-Key", () => {
  const key = "order-42";

  async function createWithKey(
    app: ReturnType<typeof setup>["app"],
    body: unknown,
    idempotencyKey: string,
    token: string
  ) {
    return await request(app)
      .post("/payments")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", idempotencyKey)
      .send(body as object);
  }

  it("returns 201 and then 200 with the same payment", async () => {
    const { app, payments, raw } = setup();
    const token = await sign();

    const first = await createWithKey(app, valid, key, token);
    const second = await createWithKey(app, valid, key, token);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      ...first.body,
      message: "Payment already exists for this Idempotency-Key",
      status: 200,
    });
    expect(first.body.data).not.toHaveProperty("idempotencyKey");
    expect(second.body.data).not.toHaveProperty("idempotencyKey");
    expect(await payments.find()).toHaveLength(1);
    const messages = raw.map((entry) => JSON.parse(entry).msg);
    expect(messages).toContain("payment create replayed");
  });

  it("returns 422 when the key is reused with a different body", async () => {
    const { app, payments } = setup();
    const token = await sign();
    await createWithKey(app, valid, key, token);

    const res = await createWithKey(app, { ...valid, amount: 1 }, key, token);

    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("idempotency-key-reused");
    expect(res.body.type).toMatch(KEY_REUSED_TYPE);
    expect(await payments.find()).toHaveLength(1);
  });

  it.each([
    ["an empty key", ""],
    ["a 256-character key", "k".repeat(256)],
    ["a key with a space", "a b"],
    ["a repeated header, which Node joins", "order-42, order-43"],
  ])("returns 400 for %s", async (_label, idempotencyKey) => {
    const { app, payments } = setup();

    const res = await createWithKey(app, valid, idempotencyKey, await sign());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation-error");
    expect(res.body.errors).toEqual([
      expect.objectContaining({ pointer: "/idempotency-key" }),
    ]);
    expect(await payments.find()).toEqual([]);
  });

  it("accepts a 255-character key", async () => {
    const { app } = setup();

    const res = await createWithKey(app, valid, "k".repeat(255), await sign());

    expect(res.status).toBe(201);
  });

  it("scopes keys to the caller", async () => {
    const { app } = setup();

    const mine = await createWithKey(app, valid, key, await sign());
    const theirs = await createWithKey(
      app,
      valid,
      key,
      await sign({ sub: randomUUID() })
    );

    expect(theirs.status).toBe(201);
    expect(theirs.body.data.id).not.toBe(mine.body.data.id);
  });

  it("creates a new payment each time without the header", async () => {
    const { app, payments } = setup();
    const token = await sign();

    const first = await create(app, valid, token);
    const second = await create(app, valid, token);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await payments.find()).toHaveLength(2);
  });
});

describe("GET /payments/:id", () => {
  const stranger = "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f";

  async function stored() {
    const ctx = setup();
    const created = await request(ctx.app)
      .post("/payments")
      .set("authorization", `Bearer ${await sign()}`)
      .set("idempotency-key", "key-1")
      .send(valid);
    return { ...ctx, created: created.body.data };
  }

  async function get(
    app: ReturnType<typeof setup>["app"],
    id: string,
    token?: string
  ) {
    const req = request(app).get(`/payments/${id}`);
    if (token !== undefined) {
      req.set("authorization", `Bearer ${token}`);
    }
    return await req;
  }

  it("returns the owner's payment as POST returned it", async () => {
    const { app, created } = await stored();

    const res = await get(app, created.id, await sign());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: created,
      message: null,
      status: 200,
      success: true,
    });
    expect(res.body.data).not.toHaveProperty("version");
    expect(res.body.data).not.toHaveProperty("idempotencyKey");
  });

  it("returns another user's payment to an admin", async () => {
    const { app, created } = await stored();

    const res = await get(
      app,
      created.id,
      await sign({ role: "admin", sub: stranger })
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(created);
  });

  it("returns the same 404 for another user's payment and an unknown ID", async () => {
    const { app, created } = await stored();
    const token = await sign({ sub: stranger });

    const foreign = await get(app, created.id, token);
    const unknown = await get(app, randomUUID(), token);

    for (const res of [foreign, unknown]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("payment-not-found");
      expect(res.body.type).toMatch(NOT_FOUND_TYPE);
    }
    expect(foreign.body.detail).toBe(unknown.body.detail);
  });

  it("rejects an ID that is not a UUID", async () => {
    const { app } = setup();

    const res = await get(app, "not-a-uuid", await sign());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation-error");
    expect(res.body.errors).toEqual([
      expect.objectContaining({ pointer: "/id" }),
    ]);
  });

  it("requires a token", async () => {
    const { app, created } = await stored();

    const res = await get(app, created.id);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });
});
