import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { jwtVerify } from "jose";
import {
  type AccessTokenClaims,
  accessTokenClaimsSchema,
  type Role,
} from "./auth.js";
import { forbidden, unauthorized } from "./errors.js";
import { bindLogUser } from "./logger.js";

const BEARER = /^Bearer +(\S+)$/i;

const verifiedClaims = new WeakMap<IncomingMessage, AccessTokenClaims>();

const missingCredentials = () =>
  unauthorized("Authentication is required.", {
    headers: { "www-authenticate": "Bearer" },
  });

const invalidToken = (cause: unknown) =>
  unauthorized("The access token is invalid or has expired.", {
    cause,
    code: "invalid-token",
    headers: { "www-authenticate": 'Bearer error="invalid_token"' },
  });

async function verify(
  token: string,
  key: Uint8Array
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return accessTokenClaimsSchema.parse(payload);
  } catch (err) {
    throw invalidToken(err);
  }
}

export function authenticate(secret: string): RequestHandler {
  const key = new TextEncoder().encode(secret);
  return async (req, res, next) => {
    const token = BEARER.exec(req.headers.authorization ?? "")?.[1];
    if (token === undefined) {
      throw missingCredentials();
    }
    const claims = await verify(token, key);
    verifiedClaims.set(req, claims);
    bindLogUser(req, res, { role: claims.role, userId: claims.sub });
    next();
  };
}

export function getAuth(req: IncomingMessage): AccessTokenClaims {
  const claims = verifiedClaims.get(req);
  if (claims === undefined) {
    throw new Error(
      "getAuth called on a request that authenticate did not run for"
    );
  }
  return claims;
}

export function requireRole(...roles: [Role, ...Role[]]): RequestHandler {
  return (req, _res, next) => {
    if (!roles.includes(getAuth(req).role)) {
      throw forbidden("You do not have permission to perform this action.");
    }
    next();
  };
}
