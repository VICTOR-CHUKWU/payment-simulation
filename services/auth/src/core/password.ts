import bcrypt from "bcryptjs";
import { z } from "zod";

const COST = 10;

// bcrypt ignores everything past 72 bytes, and .max() counts UTF-16 units.
export const passwordSchema = z
  .string()
  .min(8)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Must be at most 72 bytes",
  });

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
