import { type RequestHandler, Router } from "express";
import type { AuthController } from "./auth.controller.js";

export function authRouter(
  controller: AuthController,
  loginLimiter: RequestHandler
): Router {
  const router = Router();
  router.post("/auth/register", controller.register);
  router.post("/auth/login", loginLimiter, controller.login);
  return router;
}
