// biome-ignore lint/performance/noBarrelFile: module entry point
export { normalizeEmail, type User, userSchema } from "./user.js";
export {
  createUserService,
  type NewUser,
  type UserService,
} from "./user.service.js";
