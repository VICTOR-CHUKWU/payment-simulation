import { randomUUID } from "node:crypto";
import { conflict, type Repository, type Role } from "@payment-be/shared";
import { normalizeEmail, type User } from "./user.js";

export interface NewUser {
  email: string;
  passwordHash: string;
  role: Role;
}

export interface UserService {
  create: (user: NewUser) => Promise<User>;
  findByEmail: (email: string) => Promise<User | undefined>;
}

export function createUserService(users: Repository<User>): UserService {
  // The repository has no unique index on email, so creates run one at a time
  // to stop two concurrent registrations for one email both passing the check.
  let queue: Promise<unknown> = Promise.resolve();

  const findByEmail = (email: string) =>
    users.findOneBy({ email: normalizeEmail(email) });

  const insertUnique = async ({ email, passwordHash, role }: NewUser) => {
    if (await findByEmail(email)) {
      throw conflict("An account with this email already exists.", {
        code: "email-taken",
      });
    }
    return users.insert({
      createdAt: new Date().toISOString(),
      email: normalizeEmail(email),
      id: randomUUID(),
      passwordHash,
      role,
    });
  };

  const create = (user: NewUser): Promise<User> => {
    const result = queue.then(() => insertUnique(user));
    queue = result.catch(() => undefined);
    return result;
  };

  return { create, findByEmail };
}
