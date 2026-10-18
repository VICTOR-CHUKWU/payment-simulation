import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenClaims,
} from "@payment-be/shared";
import { SignJWT } from "jose";

export type TokenSubject = Pick<AccessTokenClaims, "email" | "role" | "sub">;

export function signAccessToken(
  { email, role, sub }: TokenSubject,
  secret: string
): Promise<string> {
  // One clock read for both claims; jose reads the clock separately for each.
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
    .sign(new TextEncoder().encode(secret));
}
