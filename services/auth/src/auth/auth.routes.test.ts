import { Writable } from "node:stream";
import {
  createLogger,
  createMemoryRepository,
  type Repository,
} from "@payment-be/shared";
import request from "supertest";
import { createApp } from "../app.js";
import { hashPassword } from "../core/index.js";
import type { User } from "../user/index.js";

const PROBLEM_JSON = /^application\/problem\+json/;

async function setup() {
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
  const users: Repository<User> = createMemoryRepository<User>();
  await users.insert({
    createdAt: new Date().toISOString(),
    email: "user@example.com",
    id: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
    passwordHash: await hashPassword("User123!"),
    role: "user",
  });
  const app = createApp({
    checks: [],
    docs: false,
    jwtSecret: "s".repeat(32),
    logger,
    users,
  });
  return { app, raw, users };
}

const register = (
  app: Awaited<ReturnType<typeof setup>>["app"],
  body: object
) => request(app).post("/auth/register").send(body);

const login = (app: Awaited<ReturnType<typeof setup>>["app"], body: object) =>
  request(app).post("/auth/login").send(body);

describe("POST /auth/register", () => {
  it("creates a user-role account", async () => {
    const { app } = await setup();

    const res = await register(app, {
      email: "New@Example.com",
      password: "Passw0rd!",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      createdAt: expect.any(String),
      email: "new@example.com",
      id: expect.any(String),
      role: "user",
    });
    expect(res.body).not.toHaveProperty("passwordHash");
  });

  it("returns 409 email-taken for an email that differs only in case", async () => {
    const { app } = await setup();

    const res = await register(app, {
      email: "USER@example.com",
      password: "Passw0rd!",
    });

    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("email-taken");
  });

  it("rejects a role in the body and creates nothing", async () => {
    const { app, users } = await setup();

    const res = await register(app, {
      email: "new@example.com",
      password: "Passw0rd!",
      role: "admin",
    });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("validation-error");
    expect(res.body.errors).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        detail: expect.stringContaining("role"),
        pointer: "",
      }),
    ]);
    expect(await users.find()).toHaveLength(1);
  });

  it.each([
    ["a short password", { password: "short" }, "/password"],
    ["a 73-byte password", { password: `${"é".repeat(36)}a` }, "/password"],
    ["an invalid email", { email: "not-an-email" }, "/email"],
  ])("rejects %s", async (_label, override, pointer) => {
    const { app } = await setup();

    const res = await register(app, {
      email: "new@example.com",
      password: "Passw0rd!",
      ...override,
    });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.errors).toEqual([expect.objectContaining({ pointer })]);
  });

  it("returns 400 malformed-json for invalid JSON", async () => {
    const { app } = await setup();

    const res = await request(app)
      .post("/auth/register")
      .set("content-type", "application/json")
      .send('{"email":');

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("malformed-json");
  });

  it("returns 413 for a body over 16kb", async () => {
    const { app } = await setup();

    const res = await register(app, {
      email: "new@example.com",
      password: "x".repeat(17 * 1024),
    });

    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("payload-too-large");
  });

  it("returns 400 for a non-JSON body", async () => {
    const { app } = await setup();

    const res = await request(app)
      .post("/auth/register")
      .set("content-type", "text/plain")
      .send("email=new@example.com");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("validation-error");
    expect(res.body.errors).toEqual([
      expect.objectContaining({ code: "invalid_type", pointer: "" }),
    ]);
  });
});

describe("POST /auth/login", () => {
  it("returns a bearer token", async () => {
    const { app } = await setup();

    const res = await login(app, {
      email: "user@example.com",
      password: "User123!",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      expiresIn: 86_400,
      tokenType: "Bearer",
    });
  });

  it("returns the same 401 for a wrong password and an unknown email", async () => {
    const { app } = await setup();

    const wrong = await login(app, {
      email: "user@example.com",
      password: "Wrong123!",
    });
    const unknown = await login(app, {
      email: "nobody@example.com",
      password: "User123!",
    });

    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("invalid-credentials");
    }
    const { requestId: _w, ...wrongBody } = wrong.body;
    const { requestId: _u, ...unknownBody } = unknown.body;
    expect(wrongBody).toEqual(unknownBody);
  });

  it("rejects a missing password", async () => {
    const { app } = await setup();

    const res = await login(app, { email: "user@example.com" });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ pointer: "/password" }),
    ]);
  });
});

describe("auth logging", () => {
  it("logs userId and role but never the email, password or token", async () => {
    const { app, raw } = await setup();

    await register(app, { email: "new@example.com", password: "Passw0rd!" });
    await register(app, { email: "new@example.com", password: "Passw0rd!" });
    const res = await login(app, {
      email: "user@example.com",
      password: "User123!",
    });
    await login(app, { email: "user@example.com", password: "Wrong123!" });
    await login(app, { email: "nobody@example.com", password: "Wrong123!" });

    const logs = raw.join("\n");
    expect(logs).toContain('"msg":"user registered"');
    expect(logs).toContain('"msg":"user logged in"');
    expect(logs).toContain('"userId":"0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f"');
    expect(logs).not.toContain("example.com");
    expect(logs).not.toContain("Passw0rd!");
    expect(logs).not.toContain("User123!");
    expect(logs).not.toContain("Wrong123!");
    expect(logs).not.toContain(res.body.accessToken);
  });
});
