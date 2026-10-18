import {
  accessTokenClaimsSchema,
  createMemoryRepository,
} from "@payment-be/shared";
import { decodeJwt } from "jose";
import { hashPassword, verifyPassword } from "../core/index.js";
import { createUserService, type User } from "../user/index.js";
import { createAuthService } from "./auth.service.js";

const SECRET = "s".repeat(32);
const BCRYPT = /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/;

const invalidCredentials = expect.objectContaining({
  code: "invalid-credentials",
  status: 401,
});

function setup() {
  const users = createMemoryRepository<User>();
  const compared: string[] = [];
  const service = createAuthService({
    jwtSecret: SECRET,
    userService: createUserService(users),
    verify: (password, hash) => {
      compared.push(hash);
      return verifyPassword(password, hash);
    },
  });
  return { compared, service, users };
}

describe("createAuthService", () => {
  describe("register", () => {
    it("creates a user-role account and returns it without the hash", async () => {
      const { service, users } = setup();

      const user = await service.register({
        email: "Ada@Example.com",
        password: "Passw0rd!",
      });

      expect(Object.keys(user).sort()).toEqual([
        "createdAt",
        "email",
        "id",
        "role",
      ]);
      expect(user).toMatchObject({ email: "ada@example.com", role: "user" });
      const stored = await users.get(user.id);
      expect(stored?.passwordHash).toMatch(BCRYPT);
      expect(JSON.stringify(stored)).not.toContain("Passw0rd!");
    });
  });

  describe("login", () => {
    it("returns a token whose claims match the user", async () => {
      const { service, users } = setup();
      const admin = await users.insert({
        createdAt: new Date().toISOString(),
        email: "admin@example.com",
        id: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
        passwordHash: await hashPassword("Admin123!"),
        role: "admin",
      });

      const { token, user } = await service.login({
        email: " ADMIN@example.com",
        password: "Admin123!",
      });

      expect(token).toMatchObject({ expiresIn: 86_400, tokenType: "Bearer" });
      expect(user.id).toBe(admin.id);
      expect(
        accessTokenClaimsSchema.parse(decodeJwt(token.accessToken))
      ).toMatchObject({
        email: "admin@example.com",
        role: "admin",
        sub: admin.id,
      });
    });

    it("rejects a wrong password", async () => {
      const { service } = setup();
      await service.register({
        email: "ada@example.com",
        password: "Passw0rd!",
      });

      await expect(
        service.login({ email: "ada@example.com", password: "wrong-pass" })
      ).rejects.toEqual(invalidCredentials);
    });

    it("rejects an unknown email after still running a bcrypt compare", async () => {
      const { compared, service } = setup();

      await expect(
        service.login({ email: "nobody@example.com", password: "Passw0rd!" })
      ).rejects.toEqual(invalidCredentials);
      expect(compared).toHaveLength(1);
      expect(compared[0]).toMatch(BCRYPT);
    });
  });
});
