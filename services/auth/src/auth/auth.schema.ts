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
  .meta({
    example: { email: "ada@example.com", password: "Password1!" },
    id: "RegisterRequest",
  });

export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z
  .object({
    email: z.email(),
    password: z.string().min(1),
  })
  .meta({
    example: { email: "user@example.com", password: "User123!" },
    id: "LoginRequest",
  });

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
  example: {
    data: {
      createdAt: "2026-10-19T10:00:00.000Z",
      email: "ada@example.com",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      role: "user",
    },
    message: "Account created",
    status: 201,
    success: true,
  },
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
).meta({
  example: {
    data: {
      accessToken:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3YzllNjY3OSJ9.c2lnbmF0dXJl",
      expiresIn: 86_400,
      tokenType: "Bearer",
    },
    message: "Logged in",
    status: 200,
    success: true,
  },
  id: "AccessTokenResponse",
});
