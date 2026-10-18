import {
  AppError,
  createMemoryRepository,
  type Repository,
} from "@payment-be/shared";
import type { User } from "./user.js";
import { createUserService } from "./user.service.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const newUser = {
  email: " Ada@Example.com ",
  passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
  role: "user" as const,
};

const emailTaken = expect.objectContaining({
  code: "email-taken",
  status: 409,
});

describe("createUserService", () => {
  it("creates a user with a normalized email, a UUID and the given role", async () => {
    const users = createMemoryRepository<User>();
    const service = createUserService(users);

    const user = await service.create({ ...newUser, role: "admin" });

    expect(user).toMatchObject({
      email: "ada@example.com",
      passwordHash: newUser.passwordHash,
      role: "admin",
      version: 1,
    });
    expect(user.id).toMatch(UUID);
    expect(await users.get(user.id)).toEqual(user);
  });

  it("rejects an email that differs only in case", async () => {
    const service = createUserService(createMemoryRepository<User>());
    await service.create(newUser);

    const error = await service
      .create({ ...newUser, email: "ADA@example.COM" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toEqual(emailTaken);
  });

  it("creates only one user for concurrent creates with the same email", async () => {
    const users = createMemoryRepository<User>();
    const service = createUserService(users);

    const results = await Promise.allSettled([
      service.create(newUser),
      service.create({ ...newUser, email: "ada@example.com" }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(results.find((result) => result.status === "rejected")).toEqual(
      expect.objectContaining({ reason: emailTaken })
    );
    expect(await users.find()).toHaveLength(1);
  });

  it("keeps working after a failed create", async () => {
    const users = createMemoryRepository<User>();
    let failNext = true;
    const failing: Repository<User> = {
      ...users,
      insert: (record) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("disk full"));
        }
        return users.insert(record);
      },
    };
    const service = createUserService(failing);

    await expect(service.create(newUser)).rejects.toThrow("disk full");
    await expect(service.create(newUser)).resolves.toMatchObject({
      email: "ada@example.com",
    });
  });

  it("finds users by email case-insensitively", async () => {
    const service = createUserService(createMemoryRepository<User>());
    const user = await service.create(newUser);

    await expect(service.findByEmail(" ADA@example.com")).resolves.toEqual(
      user
    );
    await expect(
      service.findByEmail("nobody@example.com")
    ).resolves.toBeUndefined();
  });
});
