import bcrypt from "bcryptjs";
import { hashPassword, passwordSchema, verifyPassword } from "./password.js";

const BCRYPT_COST_10 = /^\$2[aby]\$10\$/;

describe("hashPassword", () => {
  it("returns a cost-10 bcrypt hash that verifies", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).not.toContain("correct horse");
    expect(hash).toMatch(BCRYPT_COST_10);
    await expect(bcrypt.compare("correct horse", hash)).resolves.toBe(true);
    await expect(bcrypt.compare("wrong horse", hash)).resolves.toBe(false);
  });

  it("salts each hash", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same password"),
      hashPassword("same password"),
    ]);
    expect(first).not.toBe(second);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse");
    await expect(verifyPassword("correct horse", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong horse", hash)).resolves.toBe(false);
  });
});

describe("passwordSchema", () => {
  it.each([
    ["8 characters", "a".repeat(8)],
    ["exactly 72 bytes", "é".repeat(36)],
  ])("accepts %s", (_label, password) => {
    expect(passwordSchema.safeParse(password).success).toBe(true);
  });

  it.each([
    ["7 characters", "a".repeat(7)],
    ["73 bytes in under 72 characters", `${"é".repeat(36)}a`],
  ])("rejects %s", (_label, password) => {
    expect(passwordSchema.safeParse(password).success).toBe(false);
  });
});
