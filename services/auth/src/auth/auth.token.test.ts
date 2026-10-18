import { accessTokenClaimsSchema } from "@payment-be/shared";
import { jwtVerify } from "jose";
import { signAccessToken } from "./auth.token.js";

const SECRET = "s".repeat(32);
const key = (secret: string) => new TextEncoder().encode(secret);

const subject = {
  email: "ada@example.com",
  role: "admin" as const,
  sub: "0b6f4c8e-2f1a-4c3d-9e8f-1a2b3c4d5e6f",
};

describe("signAccessToken", () => {
  it("signs an HS256 token whose claims match the contract", async () => {
    const token = await signAccessToken(subject, SECRET);

    const { payload, protectedHeader } = await jwtVerify(token, key(SECRET), {
      algorithms: ["HS256"],
    });

    expect(protectedHeader.alg).toBe("HS256");
    const claims = accessTokenClaimsSchema.parse(payload);
    expect(claims).toMatchObject(subject);
    expect(claims.exp - claims.iat).toBe(86_400);
  });

  it("does not verify with a different secret", async () => {
    const token = await signAccessToken(subject, SECRET);
    await expect(jwtVerify(token, key("t".repeat(32)))).rejects.toThrow();
  });
});
