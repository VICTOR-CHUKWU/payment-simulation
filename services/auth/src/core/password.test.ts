import bcrypt from "bcryptjs";
import { hashPassword } from "./password.js";

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
