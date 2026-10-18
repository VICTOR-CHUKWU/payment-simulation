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
      ...valid,
      createdAt: expect.any(String),
      email: owner.email,
      id: expect.any(String),
      status: "pending",
      updatedAt: res.body.createdAt,
      userId: owner.sub,
    });
    expect(res.body).not.toHaveProperty("version");
    expect(await payments.get(res.body.id)).toEqual({
      ...res.body,
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
    expect(line).toMatchObject({ paymentId: res.body.id, userId: owner.sub });
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
