import { roleSchema } from "@payment-be/shared";
import { z } from "zod";

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
