import { randomUUID } from "node:crypto";
import type { Logger, Repository } from "@payment-be/shared";
import { hashPassword } from "../core/index.js";
import { normalizeEmail, type Role, type User } from "../user/index.js";

export interface SeedAccount {
  email: string;
  password: string;
  role: Role;
}

async function seedAccount(
  users: Repository<User>,
  account: SeedAccount,
  logger: Logger
): Promise<void> {
  const email = normalizeEmail(account.email);
  const existing = await users.findOneBy({ email });
  if (existing) {
    if (existing.role !== account.role) {
      logger.warn(
        {
          expectedRole: account.role,
          role: existing.role,
          userId: existing.id,
        },
        "seeded account exists with a different role; leaving it unchanged"
      );
    }
    return;
  }
  const user = await users.insert({
    createdAt: new Date().toISOString(),
    email,
    id: randomUUID(),
    passwordHash: await hashPassword(account.password),
    role: account.role,
  });
  logger.info({ role: user.role, userId: user.id }, "seeded user");
}

export async function seedUsers({
  accounts,
  logger,
  users,
}: {
  accounts: SeedAccount[];
  logger: Logger;
  users: Repository<User>;
}): Promise<void> {
  for (const account of accounts) {
    // biome-ignore lint/performance/noAwaitInLoops: one at a time, so two accounts never race on the same email
    await seedAccount(users, account, logger);
  }
}
