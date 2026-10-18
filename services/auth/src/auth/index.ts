// biome-ignore lint/performance/noBarrelFile: module entry point
export { createAuthController } from "./auth.controller.js";
export { registerAuthPaths } from "./auth.openapi.js";
export { authRouter } from "./auth.routes.js";
export { type AuthService, createAuthService } from "./auth.service.js";
