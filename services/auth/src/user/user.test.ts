import { normalizeEmail, userSchema } from "./user.js";

const valid = {
  createdAt: "2026-10-18T12:00:00.000Z",
  email: "ada@example.com",
  id: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
  passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
  role: "user",
  version: 1,
};

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });
});

describe("userSchema", () => {
  it("accepts a valid user", () => {
    expect(userSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["an unknown role", { role: "owner" }],
    ["an invalid email", { email: "not-an-email" }],
    ["an empty hash", { passwordHash: "" }],
    ["a missing hash", { passwordHash: undefined }],
    ["a non-ISO createdAt", { createdAt: "yesterday" }],
    ["a zero version", { version: 0 }],
  ])("rejects %s", (_label, override) => {
    expect(userSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});
