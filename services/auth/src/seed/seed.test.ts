import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createMemoryRepository } from "@payment-be/shared";
import bcrypt from "bcryptjs";
import type { User } from "../user/index.js";
import { type SeedAccount, seedUsers } from "./seed.js";

const accounts: SeedAccount[] = [
  { email: " Admin@Example.com ", password: "Admin123!", role: "admin" },
  { email: "user@example.com", password: "User123!", role: "user" },
];

function capture() {
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
  const lines = () =>
    raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, logger, raw };
}

const byEmail = (users: User[]) =>
  Object.fromEntries(users.map((user) => [user.email, user]));

describe("seedUsers", () => {
  it("creates both accounts with normalized emails, roles and bcrypt hashes", async () => {
    const users = createMemoryRepository<User>();
    const { lines, logger } = capture();

    await seedUsers({ accounts, logger, users });

    const stored = byEmail(await users.find());
    expect(Object.keys(stored).sort()).toEqual([
      "admin@example.com",
      "user@example.com",
    ]);
    expect(stored["admin@example.com"]?.role).toBe("admin");
    expect(stored["user@example.com"]?.role).toBe("user");
    await expect(
      bcrypt.compare(
        "Admin123!",
        stored["admin@example.com"]?.passwordHash ?? ""
      )
    ).resolves.toBe(true);
    expect(
      lines()
        .filter((line) => line.msg === "seeded user")
        .map((line) => line.role)
    ).toEqual(["admin", "user"]);
  });

  it("stores and logs no plaintext password or email", async () => {
    const users = createMemoryRepository<User>();
    const { logger, raw } = capture();

    await seedUsers({ accounts, logger, users });

    const records = JSON.stringify(await users.find());
    expect(records).not.toContain("Admin123!");
    expect(records).not.toContain("User123!");
    const logs = raw.join("\n");
    expect(logs).not.toContain("example.com");
    expect(logs).not.toContain("[Redacted]");
    expect(logs).not.toContain("Admin123!");
    expect(logs).not.toContain("User123!");
    expect(logs).not.toContain("$2");
  });

  it("creates nothing on a second run and keeps the same IDs", async () => {
    const users = createMemoryRepository<User>();
    await seedUsers({ accounts, logger: capture().logger, users });
    const before = await users.find();
    const { lines, logger } = capture();

    await seedUsers({ accounts, logger, users });

    expect(await users.find()).toEqual(before);
    expect(lines()).toEqual([]);
  });

  it("does not overwrite an existing account with a different password", async () => {
    const users = createMemoryRepository<User>();
    const existing = await users.insert({
      createdAt: new Date().toISOString(),
      email: "user@example.com",
      id: randomUUID(),
      passwordHash: "$2b$10$changedchangedchangedchanged",
      role: "user",
    });

    await seedUsers({ accounts, logger: capture().logger, users });

    expect(await users.get(existing.id)).toEqual(existing);
  });

  it("warns without changes when the admin email belongs to a user", async () => {
    const users = createMemoryRepository<User>();
    const existing = await users.insert({
      createdAt: new Date().toISOString(),
      email: "admin@example.com",
      id: randomUUID(),
      passwordHash: "$2b$10$existingexistingexisting",
      role: "user",
    });
    const { lines, logger, raw } = capture();

    await seedUsers({ accounts, logger, users });

    expect(await users.get(existing.id)).toEqual(existing);
    const warnings = lines().filter((line) => line.level === 40);
    expect(warnings).toEqual([
      expect.objectContaining({
        expectedRole: "admin",
        role: "user",
        userId: existing.id,
      }),
    ]);
    expect(raw.join("\n")).not.toContain("example.com");
    expect(raw.join("\n")).not.toContain("[Redacted]");
  });
});
