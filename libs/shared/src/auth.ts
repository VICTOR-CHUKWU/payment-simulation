import { z } from "zod";

export const roleSchema = z.enum(["user", "admin"]);

export type Role = z.infer<typeof roleSchema>;

export const ACCESS_TOKEN_TTL_SECONDS = 86_400;

export const accessTokenClaimsSchema = z.object({
  email: z.email(),
  exp: z.int(),
  iat: z.int(),
  role: roleSchema,
  sub: z.uuid(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const jwtConfigSchema = z.object({
  JWT_SECRET: z.string().min(32).optional(),
});

const DEV_JWT_SECRET = "payment-be-dev-only-jwt-secret-do-not-use";

export function resolveJwtSecret(
  config: { JWT_SECRET?: string | undefined; NODE_ENV: string },
  ctx: z.RefinementCtx
): string {
  if (config.JWT_SECRET !== undefined) {
    return config.JWT_SECRET;
  }
  if (config.NODE_ENV === "production") {
    ctx.addIssue({
      code: "custom",
      message: "Required in production",
      path: ["JWT_SECRET"],
    });
    return "";
  }
  return DEV_JWT_SECRET;
}
