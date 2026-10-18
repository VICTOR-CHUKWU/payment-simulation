import { loadConfig } from "@payment-be/shared";
import { authConfigSchema } from "./config.js";

const ADMIN_PASSWORD_NAMED = /SEED_ADMIN_PASSWORD/;
const USER_PASSWORD_NAMED = /SEED_USER_PASSWORD/;
const USER_EMAIL_NAMED = /SEED_USER_EMAIL/;

const load = (env: Record<string, string>) => loadConfig(authConfigSchema, env);

describe("authConfigSchema", () => {
  it("applies demo defaults outside production", () => {
    expect(load({ NODE_ENV: "development" })).toMatchObject({
      AUTH_PORT: 3001,
      DATA_DIR: "data",
      SEED_ADMIN_EMAIL: "admin@example.com",
      SEED_ADMIN_PASSWORD: "Admin123!",
      SEED_USER_EMAIL: "user@example.com",
      SEED_USER_PASSWORD: "User123!",
      STORAGE_DRIVER: "file",
    });
  });

  it("requires both seed passwords in production and names them", () => {
    const loadProduction = () => load({ NODE_ENV: "production" });
    expect(loadProduction).toThrow(ADMIN_PASSWORD_NAMED);
    expect(loadProduction).toThrow(USER_PASSWORD_NAMED);
  });

  it("accepts production with both seed passwords", () => {
    expect(
      load({
        NODE_ENV: "production",
        SEED_ADMIN_PASSWORD: "admin-secret",
        SEED_USER_PASSWORD: "user-secret",
      })
    ).toMatchObject({
      SEED_ADMIN_PASSWORD: "admin-secret",
      SEED_USER_PASSWORD: "user-secret",
    });
  });

  it("rejects a password over 72 bytes even when under 72 characters", () => {
    const password = `${"é".repeat(36)}a`;
    expect(password.length).toBeLessThan(72);
    expect(Buffer.byteLength(password)).toBe(73);
    expect(() => load({ SEED_ADMIN_PASSWORD: password })).toThrow(
      ADMIN_PASSWORD_NAMED
    );
  });

  it("rejects a password under 8 characters", () => {
    expect(() => load({ SEED_USER_PASSWORD: "short" })).toThrow(
      USER_PASSWORD_NAMED
    );
  });

  it("rejects seed emails that differ only in case", () => {
    expect(() =>
      load({
        SEED_ADMIN_EMAIL: "same@example.com",
        SEED_USER_EMAIL: "Same@Example.com",
      })
    ).toThrow(USER_EMAIL_NAMED);
  });

  it("does not echo a rejected password", () => {
    expect(() => load({ SEED_ADMIN_PASSWORD: "short1" })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("short1"),
      })
    );
  });
});
