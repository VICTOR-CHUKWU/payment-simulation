import { dataResponseSchema, roleSchema } from "@payment-be/shared";
import { z } from "zod";
import { passwordSchema } from "../core/index.js";

export const registerBodySchema = z
  .strictObject({
    email: z.email(),
    password: passwordSchema.meta({
      description: "8 to 72 bytes when UTF-8 encoded.",
    }),
  })
  .meta({ id: "RegisterRequest" });

export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z
  .object({
    email: z.email(),
    password: z.string().min(1),
  })
  .meta({ id: "LoginRequest" });

export type LoginBody = z.infer<typeof loginBodySchema>;

export const publicUserSchema = z
  .object({
    createdAt: z.iso.datetime(),
    email: z.email(),
    id: z.uuid(),
    role: roleSchema,
  })
  .meta({ id: "User" });

export type PublicUser = z.infer<typeof publicUserSchema>;

export const userEnvelopeSchema = dataResponseSchema(publicUserSchema).meta({
  id: "UserResponse",
});

export const accessTokenResponseSchema = z
  .object({
    accessToken: z.string(),
    expiresIn: z.int().positive(),
    tokenType: z.literal("Bearer"),
  })
  .meta({ id: "AccessToken" });

export type AccessTokenResponse = z.infer<typeof accessTokenResponseSchema>;

export const accessTokenEnvelopeSchema = dataResponseSchema(
  accessTokenResponseSchema
).meta({ id: "AccessTokenResponse" });
