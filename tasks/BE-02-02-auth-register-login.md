# BE-02-02: Register and login

**Covers:** BE-02-02
**Status:** done

## Objective

The auth service exposes `POST /auth/register` and `POST /auth/login`. Register creates a `user`-role account with a bcrypt-hashed password and rejects an email that is already taken. Login checks the password and returns a 24-hour HS256 JWT with `sub`, `email` and `role` claims. The access-token claims schema and the `JWT_SECRET` config rule go in `libs/shared` now, so BE-02-03 verifies tokens against the same contract the auth service signs.

## Source Context

Roadmap milestone BE-02-02 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18. The user proposed a NestJS-style split: `user/` for finding and creating users, and a new `auth/` folder for register and login. The user approved the scope and the five recommendations listed under Decisions Required Before Implementation.

## Design Reference

- `ROADMAP.md`, Decisions table, Auth: "`auth` service owns users and issues JWT access tokens (claims: `sub`, `email`, `role`); other services verify tokens locally via shared-lib middleware (shared secret, no runtime calls). Roles: `user`, `admin`; register always creates `user`. … Token lifetime: 24h. Out of scope: refresh tokens, password reset, email verification, OAuth".
- `ROADMAP.md`, BE-02-02 row: "bcrypt, JWT with `sub`/`email`/`role` claims".
- `tasks/BE-02-01-auth-users-seed.md`, Follow-ups:
  - Register returns `409` for a taken email (after normalizing it).
  - Serialize the check-and-insert in-process.
  - Add `verifyPassword`, with a dummy-hash compare for unknown emails.
  - Cap passwords at 72 bytes.
  - Register sets `role: "user"` explicitly and never accepts a role from the request.
- `README.md`, API: "log in with `POST /auth/login` …, copy `accessToken` from the response". The response field name is fixed by this sentence.
- `AGENTS.md`, Code style: a module folder holds "its model and, as they arrive, its controller, routes and service".

## Architecture Summary

```
services/auth/src/
  user/
    user.ts             model (unchanged except roleSchema is imported from shared)
    user.service.ts     createUserService(users): findByEmail, create
  auth/
    auth.schema.ts      request/response Zod schemas (with OpenAPI ids)
    auth.service.ts     createAuthService({ userService, jwtSecret }): register, login
    auth.controller.ts  Express handlers: parse body → call service → send response
    auth.routes.ts      authRouter(controller): POST /auth/register, POST /auth/login
    auth.openapi.ts     registerAuthPaths(registry)
    auth.token.ts       signAccessToken(claims, secret) with jose
  core/password.ts      + verifyPassword, + passwordSchema (8–72 bytes)
libs/shared/src/auth.ts roleSchema, accessTokenClaimsSchema, jwtConfigSchema, token lifetime
```

Dependencies only point down: controller → auth.service → user.service → `Repository<User>`. `auth.service` never touches the repository directly. `createApp` builds this graph from the `users` repository and the `jwtSecret` it receives. `main.ts` passes the repository it already opens.

```
POST /auth/register {email, password}
  → registerBodySchema.parse (strict, passwordSchema)        400 on failure
  → hashPassword
  → userService.create({ email, passwordHash, role: "user" }) 409 email-taken
       └ serialized: findByEmail(normalized) then insert
  → 201 { id, email, role, createdAt }

POST /auth/login {email, password}
  → loginBodySchema.parse                                    400 on failure
  → userService.findByEmail(normalized)
  → verifyPassword(password, user?.passwordHash ?? dummyHash)
  → no user or mismatch                                      401 invalid-credentials
  → signAccessToken({ sub: id, email, role }, secret)
  → 200 { accessToken, tokenType: "Bearer", expiresIn: 86400 }
```

## Code Evidence

| Behavior | Source |
|---|---|
| `createApp({ checks, docs, logger })` mounts the HTTP logger, health, optional docs, 404 and error handlers. It has no body parser and no routes | `services/auth/src/app.ts` |
| `main.ts` opens the `users` repository, seeds it, then calls `createApp({ checks: [check], docs, logger })` | `services/auth/src/main.ts` |
| `userSchema` has `id` (uuid), `email`, `passwordHash`, `role`, `createdAt` and `version`. `roleSchema` is `z.enum(["user", "admin"])`. `normalizeEmail` trims and lowercases | `services/auth/src/user/user.ts` |
| `hashPassword` uses `bcryptjs` at cost 10. There is no `verifyPassword` yet | `services/auth/src/core/password.ts` |
| The seed passwords already use an 8-to-72-byte rule (`Buffer.byteLength`) | `services/auth/src/config/config.ts` (`seedPassword`) |
| `authConfigSchema` is `baseConfigSchema.extend(storageConfigSchema.shape).extend({...}).transform(...)`. The transform adds production-only issues and fills dev defaults. Zod runs an object-level transform only when every field parses, so production-required fields must be `.optional()` and checked in the transform | `services/auth/src/config/config.ts`, `tasks/BE-02-01-auth-users-seed.md` (Code Evidence) |
| `Repository<T>` has `findOneBy(where)`, `get(id)` and `insert(record)`. There is no unique index on `email`, so uniqueness is up to the caller | `libs/shared/src/repository.ts` |
| `conflict(detail, { code })` and `unauthorized(detail, { code })` build an `AppError` with a custom `code` and a `tag:payment-be,2026:<code>` type. A `ZodError` thrown from a handler becomes a `400 validation-error` with one JSON Pointer per issue, built from the issue's `path`. Zod 4 reports an extra key in a `z.strictObject` as one `unrecognized_keys` issue with `path: []` (pointer `""`) and the key names in its message, and an `undefined` body as `invalid_type` at `""` | `libs/shared/src/errors.ts` |
| The body parser's 413 and 415 errors and its `entity.parse.failed` error map to `payload-too-large`, `unsupported-media-type` and `malformed-json`. A request whose content type is not JSON leaves `req.body` undefined, which fails schema parsing with a 400 | `libs/shared/src/errors.ts` (`clientProblem`), `libs/shared/src/errors.test.ts` |
| The logger redacts `password`, `token`, `accessToken` and `email` at up to two levels, plus `req.headers.authorization`. `bindLogUser(req, res, { userId, role })` adds the user to the request's log lines | `libs/shared/src/logger.ts` |
| `problemResponses(...statuses)` builds Problem Details error responses for a registered path. `createOpenApiRegistry()` already registers the `bearerAuth` scheme, whose description names `POST /auth/login` | `libs/shared/src/openapi.ts` |
| `buildDocument()` in auth registers no paths beyond health | `services/auth/src/openapi.ts` |
| No JWT library is installed. `jose` 6.2.12 is the latest at intake | `services/auth/package.json`, `libs/shared/package.json`, `pnpm view jose version` |
| `.env.example` has no `JWT_SECRET`. Seed passwords are listed commented out | `.env.example` |
| README API: "Only the health endpoints exist so far; endpoints will be summarised here as they land." The Errors table has no auth-specific codes. The status line says "No business endpoints are implemented yet." | `README.md` (status line, API, Errors) |
| `loadConfig` throws `Invalid environment configuration` plus `z.prettifyError`, which prints each issue's message and `→ at <KEY>`. `main.ts` calls it outside its `try`, so a bad config is an uncaught error and exit code 1 | `libs/shared/src/config.ts`, `services/auth/src/main.ts` |
| jose's `setIssuedAt()` and a relative `setExpirationTime("24h")` each read the clock separately, so `exp - iat` can be 86 401 across a second boundary. Passing numbers to both avoids that | jose 6.2.12 `dist/webapi/lib/jwt_claims_set.js` (`numericDate`, `setIssuedAt`) |

## Scope

- **Shared token contract** in `libs/shared/src/auth.ts`, exported by name from `index.ts`:
  - `roleSchema` (`"user" | "admin"`) and `Role`. Auth's `user/user.ts` imports `roleSchema` from `@payment-be/shared` for `userSchema` instead of defining its own, so the claims and the user model agree. `user/user.ts` and `user/index.ts` stop exporting `roleSchema`/`Role` (only `seed/seed.ts` uses `Role`, and it imports it from `@payment-be/shared` instead), so no non-index file re-exports another package.
  - `accessTokenClaimsSchema`: `sub` (uuid), `email`, `role`, `iat` and `exp` (integers). BE-02-03 parses verified payloads with it.
  - `ACCESS_TOKEN_TTL_SECONDS = 86_400`.
  - `jwtConfigSchema`, a `z.object` whose only field is an optional `JWT_SECRET` of at least 32 characters, so services spread its `.shape` into their own schema.
  - `resolveJwtSecret(config: { NODE_ENV: string; JWT_SECRET?: string }, ctx: z.RefinementCtx): string`, called from each service's object-level transform. It returns `JWT_SECRET` when set. In production, when it is missing, it adds a `custom` issue with `message: "Required in production"` and `path: ["JWT_SECRET"]` and returns `""` (the parse fails anyway). Elsewhere it returns a fixed dev default of at least 32 characters, so every service shares the same default. Issue messages never contain the value.
- **Auth config:** `authConfigSchema` adds `.extend(jwtConfigSchema.shape)` and its existing transform returns `JWT_SECRET: resolveJwtSecret(config, ctx)` alongside the seed-password defaults, so its output type has `JWT_SECRET: string`.
- **Passwords** in `core/password.ts`:
  - `passwordSchema` holds the 8-to-72-byte rule (required, no `.optional()`), along with the 72-byte comment now in `config.ts`. `config.ts` replaces `seedPassword` with `passwordSchema.optional()`, imported from `../core/index.js` (as it already imports from `../user/index.js`), so the rule lives in one place.
  - `verifyPassword(password, hash)` wraps `bcryptjs.compare`.
- **User service** in `user/user.service.ts`, `createUserService(users: Repository<User>)`:
  - `findByEmail(email)` normalizes the email, then calls `findOneBy`.
  - `create({ email, passwordHash, role })` normalizes the email and runs the existing-email check and the insert inside a per-instance promise chain. Only one create is in flight at a time, and a failed create does not break the chain. A taken email throws `conflict(…, { code: "email-taken" })`. The new record gets a `randomUUID()` id and the current `createdAt`.
- **Auth service** in `auth/auth.service.ts`:
  - `register({ email, password })` hashes the password and calls `userService.create` with `role: "user"`. It returns the public user `{ id, email, role, createdAt }`, never the hash.
  - `login({ email, password })` looks the user up and compares the password. For an unknown email it compares against a dummy bcrypt hash, so the response time does not reveal whether the email exists. The dummy is a constant cost-10 bcrypt hash literal (generated once with `hashPassword`), so neither startup nor the first unknown-email request pays for a hash.
  - Both an unknown email and a wrong password throw the same `unauthorized("Email or password is incorrect.", { code: "invalid-credentials" })`.
  - On success it returns `{ accessToken, tokenType: "Bearer", expiresIn: ACCESS_TOKEN_TTL_SECONDS }`.
- **Token** in `auth/auth.token.ts`: `signAccessToken({ sub, email, role }, secret)` with `jose` `SignJWT` and `alg: "HS256"`. It reads the clock once (`iat = Math.floor(Date.now() / 1000)`) and calls `setIssuedAt(iat)` and `setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)`, so `exp - iat` is always exactly the TTL. There are no `iss` or `aud` claims.
- **Schemas** in `auth/auth.schema.ts`:
  - `registerBodySchema` is `z.strictObject({ email: z.email(), password: passwordSchema })`, so an extra key such as `role` returns 400.
  - `loginBodySchema` has the same email check, and its password is any non-empty string. It is not length-checked, so login never reveals the password rules.
  - Response schemas for the public user and the token.
  - Each schema gets an OpenAPI id via `.meta({ id })`.
- **HTTP:**
  - `auth.controller.ts` handlers parse `req.body` with the schemas and let errors flow to the existing `errorHandler`. On success they call `bindLogUser(req, res, { role, userId })` and log one `info` line on `req.log` (`"user registered"` / `"user logged in"`) with no extra fields: `bindLogUser` already adds `userId` and `role`.
  - `auth.routes.ts` mounts `POST /auth/register` (201) and `POST /auth/login` (200).
  - `createApp` gains `users: Repository<User>` and `jwtSecret: string`. It adds `express.json({ limit: "16kb" })` before the routes and mounts the auth router before `notFoundHandler`.
  - `main.ts` passes `repository` and `config.JWT_SECRET`.
- **OpenAPI:**
  - `auth/auth.openapi.ts` registers both paths under the `auth` tag, with request bodies and success schemas.
  - Register lists `problemResponses(400, 409, 413, 415)` and login lists `problemResponses(400, 401, 413, 415)`.
  - `openapi.ts`'s `buildDocument` calls it.
- **Layout rule:** add one line to `AGENTS.md` Code style: module files beyond the model are named `<module>.<role>.ts` (`auth.service.ts`, `user.service.ts`).
- **Docs:**
  - `.env.example`: add `# JWT_SECRET=` as a commented-out line, with a note that it is required in production and must be at least 32 characters.
  - `README.md` Install and run: describe `JWT_SECRET` and its production rule.
  - `README.md` status line: replace "No business endpoints are implemented yet" with a mention of register and login.
  - `README.md` API: replace the "Only the health endpoints exist so far" sentence with an endpoint table for auth and `curl` examples for register and login. Keep the Swagger UI sentence that says to copy `accessToken`.
  - `README.md` Errors table: add `409 email-taken` and `401 invalid-credentials`.
  - `README.md` Testing: mention that API tests use supertest against `createApp` with the memory adapter.
- **Tests** (Jest, next to the code, memory adapter only):
  - `libs/shared/src/auth.test.ts` (config cases parse a test schema built from `baseConfigSchema.extend(jwtConfigSchema.shape)` with a transform that calls `resolveJwtSecret`):
    - The claims schema accepts valid claims and rejects an unknown role or a missing `exp`.
    - Production without `JWT_SECRET` fails and names the variable without its value. A secret under 32 characters fails. Outside production the default applies.
  - `config/config.test.ts`: production without `JWT_SECRET` fails through `authConfigSchema`; the parsed config has the dev default outside production.
  - `core/password.test.ts`: `verifyPassword` is true for the right password and false for a wrong one. `passwordSchema` rejects 7 characters and a 73-byte string under 72 characters, and accepts 8 characters and exactly 72 bytes. The existing seed-password cases in `config/config.test.ts` stay, since they test config behavior.
  - `user/user.service.test.ts`:
    - `create` stores a normalized email, a UUID and the given role.
    - A second create with the same email in different case throws `email-taken`.
    - Two concurrent creates for the same email (`Promise.allSettled`) produce exactly one user and one `email-taken`.
    - A create after a failed create still runs.
    - `findByEmail` is case-insensitive and returns `undefined` for an unknown email.
  - `auth/auth.token.test.ts`: a signed token verifies with `jose.jwtVerify` and the same secret, its payload parses with `accessTokenClaimsSchema`, and `exp - iat` equals 86 400. It fails to verify with a different secret.
  - `auth/auth.service.test.ts`:
    - `register` never returns or stores a plaintext password, and always uses `role: "user"`.
    - `login` returns a token whose claims match the user.
    - An unknown email and a wrong password both throw `invalid-credentials`, and the unknown-email path still runs a bcrypt compare (spy or injected verifier).
  - `auth/auth.routes.test.ts` (supertest via `createApp`):
    - Register: `201` with a body that has no `passwordHash`.
    - Register again with a different-case email: `409 email-taken`.
    - Register with an extra `role: "admin"` key: `400 validation-error` with an `unrecognized_keys` error at pointer `""` whose `detail` names `role`, and no user is created.
    - Short password, 73-byte password, or bad email: `400` with pointers.
    - Malformed JSON: `400 malformed-json`. Body over 16 kb: `413 payload-too-large`. A `text/plain` body: `400 validation-error` with an `invalid_type` error at pointer `""`.
    - Login with the seeded-style account: `200` with `tokenType: "Bearer"` and `expiresIn: 86400`.
    - Wrong password and unknown email: identical `401 invalid-credentials` bodies apart from `requestId`.
    - All errors are `application/problem+json`.
    - A captured log line contains neither the email, the password nor the token.
  - `app.test.ts`: existing tests pass the new params. The OpenAPI test also expects `/auth/register` and `/auth/login` in `paths`.

## Preserve

- Every existing auth route (health, docs, 404) and test behavior. Existing `createApp` calls only gain the two new params.
- `userSchema`'s fields, `normalizeEmail`, the seed's behavior and its use of the repository, and the seed config rules (only their password rule moves to `passwordSchema`).
- `libs/shared` error model, logger redaction, repository, storage and OpenAPI helpers, apart from the new `auth.ts` exports.
- The `accessToken` response field name and the `bearerAuth` scheme description.

## Excluded

- Token verification middleware and role guards (BE-02-03). This milestone adds `jose` to auth only. BE-02-03 adds it to `libs/shared` when it needs it.
- Helmet, CORS and the login rate limit (BE-02-04).
- Users endpoints such as `GET /users` and `GET /users/:id`. They would need a new milestone after BE-02-03.
- Returning a token from register, logout, token revocation, refresh tokens, password reset, email verification, OAuth.
- `iss` and `aud` claims, and configurable token lifetime or bcrypt cost.
- `userService.findById`: nothing calls it yet. Add it with its first caller.
- `500` responses in the OpenAPI spec. No current endpoint documents them; BE-06-04 decides this for every service at once.
- Email uniqueness across multiple auth instances: the in-process lock covers one instance, which is all this project runs.

## Likely Files To Touch

- `libs/shared/src/auth.ts`, `auth.test.ts`, `index.ts`
- `services/auth/src/auth/` (new): the files listed under Architecture Summary, their tests and `index.ts`
- `services/auth/src/user/user.ts`, `user.service.ts`, `user.service.test.ts`, `index.ts`
- `services/auth/src/seed/seed.ts` (`Role` import)
- `services/auth/src/core/password.ts`, `password.test.ts`, `index.ts`
- `services/auth/src/config/config.ts`, `config.test.ts`
- `services/auth/src/app.ts`, `app.test.ts`, `main.ts`, `openapi.ts`
- `services/auth/package.json`, `pnpm-lock.yaml` (`jose`)
- `.env.example`, `README.md`, `ROADMAP.md`, `AGENTS.md`

## Decisions Required Before Implementation

None.

Settled during intake on 2026-10-18 (each the recommended option):
- **Folder split:** `user/` holds user lookup and creation as service functions. `auth/` holds register and login. No users HTTP endpoints. Rejected: users endpoints now, since no roadmap milestone asks for them and BE-02-03's role guard does not exist yet.
- **JWT library:** `jose` 6.2.12, pinned exact. It is ESM-native, ships its own types and has no dependencies. Rejected: `jsonwebtoken`, which is CommonJS and needs `@types`.
- **Token contract location:** the claims schema, role enum, lifetime and `JWT_SECRET` rule go in `libs/shared` now, and signing stays in auth. Rejected: defining them in auth and moving them in BE-02-03.
- **`JWT_SECRET`:** at least 32 characters, a shared dev default outside production, required in production, and commented out in `.env.example`. This mirrors the seed passwords.
- **Register response:** `201` with the public user and no token. Login is the only place a token is issued.
- **No `iss`/`aud` claims:** the Decisions table names only `sub`, `email` and `role`, and all services share one secret.

Settled after review on 2026-10-18:
- **No `500` in the OpenAPI spec:** keep the current convention, where no endpoint lists `500`, and leave the decision for all services to BE-06-04.
- **No `findById` yet:** the user service has only the methods this milestone calls. Rejected: adding `findById` now with no caller.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as the dummy-hash compare or the serialized create.
- Never log, or put in an error message, an email, password, hash, token or secret.
- Add only `jose`, with `pnpm --filter @payment-be/auth add -E jose@6.2.12` (or the current latest, exact). Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Tests use the memory adapter and must not write to `services/auth/data`. Tests that hash passwords may use the real cost.
- Set the BE-02-02 roadmap row to `in-progress` when starting.

## Deliverables

- Both endpoints working as described, registered in the auth OpenAPI document with their error responses.
- The shared token contract exported from `libs/shared`.
- The modules and tests listed under Scope.
- `.env.example`, `README.md`, `AGENTS.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual run from the repo root: `STORAGE_DRIVER=memory pnpm --filter @payment-be/auth dev`, then:
  - `curl -i -X POST localhost:3001/auth/register -H 'content-type: application/json' -d '{"email":"New@Example.com","password":"Passw0rd!"}'` returns `201` with `"email":"new@example.com"` and `"role":"user"`. Repeating it returns `409` with `"code":"email-taken"`.
  - `curl -s -X POST localhost:3001/auth/login -H 'content-type: application/json' -d '{"email":"admin@example.com","password":"Admin123!"}'` returns an `accessToken`. Decoding its payload shows `sub`, `email`, `role: "admin"`, `iat` and `exp`, with `exp - iat = 86400`. The payload is unpadded base64url, which `base64 -d` does not reliably decode, so pipe the login response through `node -e 'const t=JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken;const p=JSON.parse(Buffer.from(t.split(".")[1],"base64url"));process.stdout.write(JSON.stringify({...p,ttl:p.exp-p.iat})+"\n")'`.
  - A wrong password returns `401` with `"code":"invalid-credentials"`.
  - The terminal log has no email, password or token in any line.
  - `http://localhost:3001/docs` shows both endpoints with their error responses.
- Manual production check after `pnpm build` (running `node` directly does not load `.env`): `cd services/auth && env -u JWT_SECRET NODE_ENV=production SEED_ADMIN_PASSWORD=Admin123! SEED_USER_PASSWORD=User123! STORAGE_DRIVER=memory node dist/main.js; echo $?` prints `Invalid environment configuration` with `Required in production` `→ at JWT_SECRET`, and then `1`.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-02-02 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-02-03: add `jose` to `libs/shared`. Verify with `algorithms: ["HS256"]` and parse the payload with `accessTokenClaimsSchema`. Return `401` with `WWW-Authenticate: Bearer` for a missing or invalid token. Call `bindLogUser` with the claims. Payment and notification configs extend `jwtConfigSchema.shape` and call `resolveJwtSecret` in an object-level transform.
- BE-06-04: decide whether every endpoint's OpenAPI entry lists `500` (for example, a storage write failure on register).
- BE-02-04: the login rate limit goes on `POST /auth/login`. Register may want one too.
