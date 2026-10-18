import { ACCESS_TOKEN_TTL_SECONDS, unauthorized } from "@payment-be/shared";
import { hashPassword, verifyPassword } from "../core/index.js";
import type { UserService } from "../user/index.js";
import type {
  AccessTokenResponse,
  LoginBody,
  PublicUser,
  RegisterBody,
} from "./auth.schema.js";
import { signAccessToken } from "./auth.token.js";

// Compared against when the email is unknown, so a miss costs as much as a
// wrong password and response time does not reveal which emails exist.
const DUMMY_HASH =
  "$2b$10$tLiM1NXn1e5e2STxPeMJgOHdf/9o/pDnEvfPH1Vs2rgyKtBg/45kC";

export interface AuthService {
  login: (
    body: LoginBody
  ) => Promise<{ token: AccessTokenResponse; user: PublicUser }>;
  register: (body: RegisterBody) => Promise<PublicUser>;
}

export function createAuthService({
  jwtSecret,
  userService,
  verify = verifyPassword,
}: {
  jwtSecret: string;
  userService: UserService;
  verify?: (password: string, hash: string) => Promise<boolean>;
}): AuthService {
  const toPublic = ({
    createdAt,
    email,
    id,
    role,
  }: PublicUser): PublicUser => ({
    createdAt,
    email,
    id,
    role,
  });

  return {
    async login({ email, password }) {
      const user = await userService.findByEmail(email);
      const matches = await verify(password, user?.passwordHash ?? DUMMY_HASH);
      if (!(user && matches)) {
        throw unauthorized("Email or password is incorrect.", {
          code: "invalid-credentials",
        });
      }
      const accessToken = await signAccessToken(
        { email: user.email, role: user.role, sub: user.id },
        jwtSecret
      );
      return {
        token: {
          accessToken,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          tokenType: "Bearer",
        },
        user: toPublic(user),
      };
    },

    async register({ email, password }) {
      const user = await userService.create({
        email,
        passwordHash: await hashPassword(password),
        role: "user",
      });
      return toPublic(user);
    },
  };
}
