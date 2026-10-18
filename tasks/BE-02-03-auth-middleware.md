# BE-02-03: Shared auth middleware

**Covers:** BE-02-03
**Status:** done

## Objective

`libs/shared` exports Express middleware that verifies the JWT access tokens the auth service issues, a role guard, and a typed accessor for the verified claims. Verification is local, with the shared `JWT_SECRET`, and never calls `auth`. Payment and notification load `JWT_SECRET` through the shared config rule now, so a production deploy without it fails at startup before their first protected route lands (BE-03-02, BE-05-03).

## Source Context

Roadmap milestone BE-02-03 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18. The user chose the recommended option for both open questions: claims are read through a `getAuth(req)` accessor, and wiring stops at the shared lib plus the payment and notification configs (no protected routes, no `GET /auth/me`).

## Design Reference

- `ROADMAP.md`, Decisions table, Auth: "other services verify tokens locally via shared-lib middleware (shared secret, no runtime calls). Roles: `user`, `admin`".
- `AGENTS.md`, Architecture constraints: "services verify JWTs locally using the shared secret and never call `auth` at runtime". "Never log passwords, tokens or auth headers."
- `tasks/BE-02-02-auth-register-login.md`, Follow-ups: "add `jose` to `libs/shared`. Verify with `algorithms: ["HS256"]` and parse the payload with `accessTokenClaimsSchema`. Return `401` with `WWW-Authenticate: Bearer` for a missing or invalid token. Call `bindLogUser` with the claims. Payment and notification configs extend `jwtConfigSchema.shape` and call `resolveJwtSecret` in an object-level transform."
- `tasks/BE-01-05-structured-logging.md`, Follow-ups: "call `bindLogUser(req, res, { userId: claims.sub, role: claims.role })` after verifying the token. Never pass `email`."
- `tasks/BE-01-06-error-model.md`, Follow-ups: "missing or invalid tokens use `unauthorized` with `WWW-Authenticate: Bearer`. Role failures use `forbidden`."
- `tasks/BE-01-09-openapi-setup.md`, Follow-ups: "every protected route sets `security: bearerSecurity` and includes `problemResponses(401, 403)` as applicable." This applies to the routes that adopt the middleware, not to this milestone.
- [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) §3: a request with no credentials gets a plain `Bearer` challenge, and a rejected token gets `error="invalid_token"`.

## Architecture Summary

```
libs/shared/src/
  auth.ts              unchanged: roleSchema, accessTokenClaimsSchema, jwtConfigSchema, resolveJwtSecret
  auth-middleware.ts   authenticate(secret), requireRole(...roles), getAuth(req)
services/payment/src/config/       paymentConfigSchema (moved out of main.ts, + JWT_SECRET)
services/notification/src/config/  notificationConfigSchema (moved out of main.ts, + JWT_SECRET)
```

```
request
  → authenticate(secret)
      no "Authorization: Bearer <token>"        401 unauthorized          WWW-Authenticate: Bearer
      jwtVerify(token, key, { algorithms: ["HS256"] }) fails
        or accessTokenClaimsSchema fails        401 invalid-token         WWW-Authenticate: Bearer error="invalid_token"
      ok → claims stored for getAuth(req), bindLogUser(req, res, { userId: sub, role })
  → requireRole("admin")                         403 forbidden when role not listed
  → handler: const { sub, email, role } = getAuth(req)
```

A future route mounts them as `router.patch("/payments/:id/status", authenticate(secret), requireRole("admin"), handler)`.

## Code Evidence

| Behavior | Source |
|---|---|
| `accessTokenClaimsSchema` (`sub` uuid, `email`, `role`, `iat`, `exp` integers), `roleSchema`/`Role`, `jwtConfigSchema` (optional `JWT_SECRET`, min 32) and `resolveJwtSecret(config, ctx)` already exist and are exported | `libs/shared/src/auth.ts`, `libs/shared/src/index.ts` |
| Auth signs with `jose` `SignJWT`, `alg: "HS256"`, `typ: "JWT"`, `sub` via `setSubject`, `email` and `role` in the payload, no `iss`/`aud` | `services/auth/src/auth/auth.token.ts` |
| `jose` 6.2.12 is a dependency of auth only. `libs/shared/package.json` has no JWT library | `services/auth/package.json`, `libs/shared/package.json` |
| `unauthorized(detail, { code, headers })` and `forbidden(detail)` build `AppError`s. Without `code` the problem is plain (`about:blank`, code from the status phrase). `errorHandler` sets `err.headers` on the response when the status is unchanged, and sets `res.err` only for 5xx, so a 4xx cause is never logged | `libs/shared/src/errors.ts` (`problemFactory`, `errorHandler`) |
| A non-`AppError` thrown from middleware becomes `500 internal-error` with the real error on the log line | `libs/shared/src/errors.ts` (`toProblem`, `errorHandler`) |
| `bindLogUser(req, res, { userId, role })` adds both fields to `req.log` and to pino-http's completion line. It keeps per-response state in a `WeakMap` | `libs/shared/src/logger.ts` |
| The logger redacts `req.headers.authorization`, `token`, `accessToken` and `email` | `libs/shared/src/logger.ts` (`REDACT_PATHS`) |
| No file in the repo augments Express's `Request` type | `grep -rn "declare global\|namespace Express" libs services` (no hits) |
| Payment and notification build their config inline in `main.ts` with `baseConfigSchema.extend({ <SERVICE>_PORT })`. Neither has a `config/` folder. `createApp` takes `{ checks, docs, logger }` and mounts no routes | `services/payment/src/main.ts`, `services/notification/src/main.ts`, `services/*/src/app.ts` |
| Auth's config shows the pattern: `.extend(jwtConfigSchema.shape)` and `JWT_SECRET: resolveJwtSecret(config, ctx)` in an object-level transform | `services/auth/src/config/config.ts` |
| `bearerSecurity` and `problemResponses(...)` exist for protected routes | `libs/shared/src/openapi.ts` |
| README Install and run: "With `NODE_ENV=production` it has no default: set it, or `auth` refuses to start." The Errors table lists `401 invalid-credentials` and no token or role errors | `README.md` (Install and run, Errors) |

## Scope

- **Dependency:** add `jose` to `libs/shared` at the exact version auth uses (6.2.12), so the workspace has one copy.
- **`libs/shared/src/auth-middleware.ts`**, exported by name from `index.ts`:
  - `authenticate(secret: string): RequestHandler`
    - Encodes the secret once when the middleware is created.
    - Reads `Authorization`. It accepts `Bearer <token>` with a case-insensitive scheme and a non-empty token. A missing header, another scheme (`Basic …`) or `Bearer` with no token throws `unauthorized("Authentication is required.", { headers: { "www-authenticate": "Bearer" } })`, a plain `401` with `code: "unauthorized"`.
    - Verifies with `jwtVerify(token, key, { algorithms: ["HS256"] })` and parses the payload with `accessTokenClaimsSchema`. Any failure (bad signature, malformed token, expired, `alg: none` or another algorithm, payload failing the schema) throws `unauthorized("The access token is invalid or has expired.", { code: "invalid-token", headers: { "www-authenticate": 'Bearer error="invalid_token"' } })`. The detail is the same for every cause and never includes the token or jose's message.
    - On success stores the parsed claims for `getAuth`, calls `bindLogUser(req, res, { userId: claims.sub, role: claims.role })` (never `email`) and calls `next()`.
    - No clock tolerance; jose's default `exp` check applies. jose accepts a token with no `exp` at all, so `accessTokenClaimsSchema` (which requires `exp`) is what rejects it.
  - `requireRole(...roles: [Role, ...Role[]]): RequestHandler` — reads `getAuth(req)` and throws `forbidden("You do not have permission to perform this action.")` (plain `403`, `code: "forbidden"`) when the role is not listed.
  - `getAuth(req): AccessTokenClaims` — returns the claims stored by `authenticate`, from a module-level `WeakMap` keyed by the request (the same pattern as `bindLogUser`). If `authenticate` did not run for this request it throws a plain `Error` naming the missing middleware, which the error handler turns into a `500` and logs. This is a wiring bug, not a client error. `requireRole` inherits this behavior when mounted without `authenticate`.
- **Payment and notification config:**
  - Move each service's inline schema into `src/config/config.ts` (`paymentConfigSchema`, `notificationConfigSchema`) with an `index.ts` barrel, following auth's layout. Each is `baseConfigSchema.extend(jwtConfigSchema.shape).extend({ <SERVICE>_PORT })` with a transform returning `{ ...config, JWT_SECRET: resolveJwtSecret(config, ctx) }`.
  - `main.ts` loads the schema from `./config/index.js`. It does not pass `JWT_SECRET` anywhere yet; BE-03-02 and BE-05-03 pass it to `createApp` with their first protected routes.
- **Docs:**
  - `README.md` Install and run: `JWT_SECRET` is now read by every service, and in production any service refuses to start without it.
  - `README.md` Errors table: add `401 unauthorized` (no or non-Bearer `Authorization` header), `401 invalid-token` (token invalid, expired or with bad claims) and `403 forbidden` (role not allowed). Mention the `WWW-Authenticate` header on both `401`s.
  - `ROADMAP.md`: the BE-02-03 row already links this doc; only its status changes.
- **Tests** (Jest, next to the code):
  - `libs/shared/src/auth-middleware.test.ts`, supertest against a small Express app built in the test with `httpLogger`, the middleware, a handler returning `getAuth(req)`, and `errorHandler`. Tokens are signed in the test with `jose` `SignJWT` (shared must not import auth's `signAccessToken`). The `alg: none` token is built with `jose` `UnsecuredJWT(...).encode()`, because `SignJWT` refuses `alg: none` (`JOSENotSupported`).
    - A valid token: `200` and the handler sees `sub`, `email`, `role`.
    - Scheme `bearer` in lower case is accepted.
    - No header, `Basic …`, and `Bearer` with no token: `401` `code: "unauthorized"`, `WWW-Authenticate: Bearer`, `application/problem+json`.
    - Malformed token, wrong secret, expired token, HS512-signed token, `alg: none` token, valid signature with no `exp`, valid signature with a non-uuid `sub`, and valid signature with an unknown role: each `401` `code: "invalid-token"` with `WWW-Authenticate: Bearer error="invalid_token"`, and identical bodies apart from `requestId`.
    - `requireRole("admin")`: `403` `code: "forbidden"` for a `user` token, `200` for an `admin` token. `requireRole("user", "admin")` lets both through.
    - `requireRole` or `getAuth` without `authenticate`: `500 internal-error`.
    - With a captured log destination: the completion line of an authenticated request has `userId` and `role`, and no line contains the token or the email.
  - `services/payment/src/config/config.test.ts` and `services/notification/src/config/config.test.ts`: production without `JWT_SECRET` fails and names the variable; outside production the dev default applies and equals the one auth resolves (compare with `resolveJwtSecret` through a minimal schema, not by importing auth); the port default is unchanged.
  - Existing `app.test.ts` files pass unchanged.

## Preserve

- `libs/shared/src/auth.ts` exports and behavior, and auth's token signing and config.
- The error model's response shape and logger redaction. No new `AppError` options.
- Payment and notification startup, health, docs and shutdown behavior, and their `<SERVICE>_PORT` defaults. `createApp` signatures stay the same.
- Every existing test.

## Excluded

- Any protected route, in any service, and `GET /auth/me`. Routes adopt the middleware in BE-03-02, BE-03-06 and BE-05-03, and register `security: bearerSecurity` with `problemResponses(401, 403)` there.
- Passing `JWT_SECRET` into payment or notification `createApp`.
- Checking that the user still exists or that its role is current. A token stays valid with its role until it expires (at most 24h); there is no revocation.
- `iss`/`aud` checks, clock tolerance, refresh tokens, password reset, email verification, OAuth.
- An Express `Request` type augmentation or `res.locals` use for the claims.
- Helmet, CORS and rate limiting (BE-02-04).

## Likely Files To Touch

- `libs/shared/src/auth-middleware.ts`, `auth-middleware.test.ts`, `index.ts`
- `libs/shared/package.json`, `pnpm-lock.yaml` (`jose`)
- `services/payment/src/config/` (new: `config.ts`, `config.test.ts`, `index.ts`), `services/payment/src/main.ts`
- `services/notification/src/config/` (new: `config.ts`, `config.test.ts`, `index.ts`), `services/notification/src/main.ts`
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None.

Settled during intake on 2026-10-18:
- **Claims access:** `getAuth(req)` backed by a `WeakMap`, throwing when `authenticate` did not run. Rejected: `req.auth` via a global Express type augmentation (optional in every handler, and the first augmentation in the repo); `res.locals.auth` (untyped, needs casts).
- **Wiring:** shared middleware plus `JWT_SECRET` in the payment and notification configs. Rejected: shared lib only (production misconfiguration would surface later, with the first route); adding `GET /auth/me` (no roadmap milestone asks for it, and BE-02-02 rejected users endpoints for that reason).
- **Error codes:** a missing credential is a plain `401 unauthorized` with `WWW-Authenticate: Bearer`; a rejected token is `401 invalid-token` with `Bearer error="invalid_token"` and one detail for every cause; a role failure is a plain `403 forbidden`. This follows RFC 6750 §3 and keeps the error model unchanged.
- **Algorithm:** HS256 only, matching auth's signer.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons.
- Never log, or put in an error message, a token, `Authorization` header, email or secret.
- `libs/shared` must not import from any service. Tests sign their own tokens with `jose`.
- Add only `jose`, with `pnpm --filter @payment-be/shared add -E jose@6.2.12`. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Set the BE-02-03 roadmap row to `in-progress` when starting.

## Deliverables

- `authenticate`, `requireRole` and `getAuth` exported from `@payment-be/shared`, with tests.
- Payment and notification configs in `config/` folders, resolving `JWT_SECRET`, with tests.
- `README.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual production check after `pnpm build`, for each of payment and notification: `cd services/payment && env -u JWT_SECRET NODE_ENV=production node dist/main.js; echo $?` prints `Invalid environment configuration` with `Required in production` `→ at JWT_SECRET`, then `1`, before any NATS connection attempt.
- `pnpm infra:up && pnpm dev`, with `.env` copied from `.env.example` (`JWT_SECRET` commented out, `NODE_ENV=development`): all three services start on the shared dev secret, as before. `pnpm dev` loads `../../.env`, so a `JWT_SECRET` set there is used instead and must be at least 32 characters, or every service now refuses to start.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-02-03 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-03-02, BE-03-06, BE-05-03: pass `config.JWT_SECRET` into `createApp`, mount `authenticate(secret)` on protected routers, use `requireRole("admin")` for admin-only routes, read the caller with `getAuth(req)`, and register each route with `security: bearerSecurity` and `problemResponses(401, 403)` as applicable.
- BE-04-02: payment events take `userId` and `email` from `getAuth(req)` at creation time.
