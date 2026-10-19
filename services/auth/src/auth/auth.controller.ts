import { bindLogUser, sendData } from "@payment-be/shared";
import type { RequestHandler } from "express";
import { loginBodySchema, registerBodySchema } from "./auth.schema.js";
import type { AuthService } from "./auth.service.js";

export interface AuthController {
  login: RequestHandler;
  register: RequestHandler;
}

export function createAuthController(service: AuthService): AuthController {
  return {
    async login(req, res) {
      const { token, user } = await service.login(
        loginBodySchema.parse(req.body)
      );
      bindLogUser(req, res, { role: user.role, userId: user.id });
      req.log.info("user logged in");
      sendData(res, token, { message: "Logged in" });
    },

    async register(req, res) {
      const user = await service.register(registerBodySchema.parse(req.body));
      bindLogUser(req, res, { role: user.role, userId: user.id });
      req.log.info("user registered");
      sendData(res, user, { message: "Account created", status: 201 });
    },
  };
}
