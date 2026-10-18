import { Router } from "express";
import type { AuthController } from "./auth.controller.js";

export function authRouter(controller: AuthController): Router {
  const router = Router();
  router.post("/auth/register", controller.register);
  router.post("/auth/login", controller.login);
  return router;
}
