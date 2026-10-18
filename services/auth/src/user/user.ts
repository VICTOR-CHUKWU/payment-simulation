import { z } from "zod";

export const roleSchema = z.enum(["user", "admin"]);

export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  createdAt: z.iso.datetime(),
  email: z.email(),
  id: z.uuid(),
  passwordHash: z.string().min(1),
  role: roleSchema,
  version: z.number().int().positive(),
});

export type User = z.infer<typeof userSchema>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
