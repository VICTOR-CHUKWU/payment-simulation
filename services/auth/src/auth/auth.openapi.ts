import { type OpenAPIRegistry, problemResponses } from "@payment-be/shared";
import type { z } from "zod";
import {
  accessTokenEnvelopeSchema,
  loginBodySchema,
  registerBodySchema,
  userEnvelopeSchema,
} from "./auth.schema.js";

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

export function registerAuthPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    description:
      "Creates an account with the `user` role. The email is trimmed and lowercased, and must not already be registered.",
    method: "post",
    path: "/auth/register",
    request: {
      body: { content: json(registerBodySchema), required: true },
    },
    responses: {
      201: {
        content: json(userEnvelopeSchema),
        description: "Account created",
      },
      ...problemResponses(400, 409, 413, 415),
    },
    summary: "Register",
    tags: ["auth"],
  });
  registry.registerPath({
    description:
      "Returns a 24-hour access token. An unknown email and a wrong password get the same 401. Failed attempts are limited per client IP; once over the limit, the response is a 429 with a `Retry-After` header.",
    method: "post",
    path: "/auth/login",
    request: {
      body: { content: json(loginBodySchema), required: true },
    },
    responses: {
      200: {
        content: json(accessTokenEnvelopeSchema),
        description: "Logged in",
      },
      ...problemResponses(400, 401, 413, 415, 429),
    },
    summary: "Log in",
    tags: ["auth"],
  });
}
