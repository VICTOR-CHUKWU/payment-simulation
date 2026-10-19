# BE-02-04: HTTP hardening

**Covers:** BE-02-04
**Status:** done

## Objective

Every service sends helmet's security headers, drops `X-Powered-By` and answers CORS for any origin. `POST /auth/login` is rate limited per client IP, counting failed attempts only. A limited request gets a `429` in the central error format, with `Retry-After` and `RateLimit` headers. Every part of this ships with tests and docs.

## Source Context

Roadmap milestone BE-02-04 in `ROADMAP.md` ("HTTP hardening (helmet, CORS, rate limit on login)"). Scope was agreed during task-doc intake on 2026-10-18. The user chose:
- **CORS:** allow any origin (`Access-Control-Allow-Origin: *`), with no allowlist setting.
- **Login limit:** failed attempts per client IP, 10 per 15 minutes by default, set through env vars.

## Design Reference

- `ROADMAP.md`, Decisions table: Caching is "None… everything runs as one instance per service". That is why the limiter keeps its counts in memory.
- `ROADMAP.md`, Decisions table, Auth: tokens are bearer JWTs. No cookies are used, so CORS needs no credentials.
- `AGENTS.md`: return errors only through the central error model. No `console.*`. Register every endpoint's error responses in the OpenAPI spec. Update the README when env vars, endpoints or errors change.
- `tasks/BE-02-03-auth-middleware.md`, Excluded: "Helmet, CORS and rate limiting (BE-02-04)."
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) §4 (`429 Too Many Requests`, `Retry-After`). The IETF RateLimit header fields draft, version 8, defines the `RateLimit` and `RateLimit-Policy` headers that express-rate-limit sends with `standardHeaders: "draft-8"`.

## Architecture Summary

```
libs/shared/src/
  security.ts        securityHeaders(): helmet with defaults; corsPolicy(): cors for any origin
  errors.ts          + tooManyRequests (429) factory
services/*/src/app.ts
  httpLogger → securityHeaders() → corsPolicy() → health → docs → routes → 404 → errorHandler
services/auth/src/
  auth/auth.limiter.ts   createLoginLimiter({ logger, max, windowMs })
  auth/auth.routes.ts    router.post("/auth/login", loginLimiter, controller.login)
  config/config.ts       + LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS
```

```
POST /auth/login
  → loginLimiter: hits(ip) += 1, RateLimit + RateLimit-Policy headers set
      hits > max → Retry-After set by the library
                 → next(tooManyRequests(...)) → errorHandler → 429 problem+json
  → controller.login
  → on finish: status < 400 → hits(ip) -= 1   (skipSuccessfulRequests)
```

## Code Evidence

| Behavior | Source |
|---|---|
| Each `createApp` mounts `httpLogger`, `healthRouter`, `docsRouter` (development only), its routes, `notFoundHandler` and `errorHandler`. None sets security headers or CORS. Express 5 sends `X-Powered-By: Express` | `services/{auth,payment,notification}/src/app.ts` |
| Auth parses JSON on `/auth` with a 16 kB limit, then mounts `authRouter(controller)` with `POST /auth/register` and `POST /auth/login` | `services/auth/src/app.ts`, `services/auth/src/auth/auth.routes.ts` |
| `problemFactory(status)` builds the plain factories (`badRequest` … `serviceUnavailable`). There is no 429 factory. `errorHandler` copies `AppError.headers` onto the response and leaves headers set earlier, such as the limiter's, in place | `libs/shared/src/errors.ts` |
| `problemResponses(...statuses)` registers problem responses. Login currently lists `400, 401, 413, 415` | `libs/shared/src/openapi.ts`, `services/auth/src/auth/auth.openapi.ts` |
| Auth config extends `baseConfigSchema`, storage and JWT shapes, with `AUTH_PORT` and seed settings | `services/auth/src/config/config.ts` |
| Swagger UI's HTML loads only external scripts (`swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`, `swagger-ui-init.js`) and uses inline `<style>`. Helmet's default CSP allows both (`script-src 'self'`, `style-src 'self' https: 'unsafe-inline'`, `img-src 'self' data:`). It also sends `upgrade-insecure-requests`, which a browser that does not exempt `http://localhost` would apply to those scripts | `node_modules/.pnpm/swagger-ui-express@5.0.1_*/node_modules/swagger-ui-express/index.js`, `helmet@8.3.0` `index.mjs` |
| express-rate-limit 8.7.0 sets `Retry-After` before calling `handler(req, res, next, options)` when `standardHeaders` or `legacyHeaders` is on. With `skipSuccessfulRequests` it decrements the count after `finish` when `requestWasSuccessful` (default `statusCode < 400`) holds. Its `MemoryStore` timer is `unref`'d. It sets `RateLimit`/`RateLimit-Policy` (draft-8) on every counted request. Each validation reports at most once per limiter, through the `logger` option or `console.warn`/`console.error` when none is given. `xForwardedForHeader` fires whenever `X-Forwarded-For` is present while `trust proxy` is `false`, `forwardedHeader` on `Forwarded`, `ip` on an undefined `req.ip`, and the `MemoryStore` rejects a `windowMs` above `2^31 − 1` | `express-rate-limit@8.7.0` `dist/index.mjs` |
| Neither `trust proxy` nor `app.disable("x-powered-by")` is set anywhere | `grep -rn "trust proxy\|x-powered-by" services libs` (no hits) |
| The README has no env var table: Install and run points to `.env.example` and describes `JWT_SECRET` in prose. It has the auth endpoint table (login errors `400, 401, 413, 415`) and the Errors table | `README.md` (Install and run, Auth endpoints, Errors) |

## Scope

- **Dependencies (exact versions):**
  - `libs/shared`: `helmet@8.3.0`, `cors@2.8.6`, `@types/cors@2.8.19`. `@types/cors` goes in `dependencies`, the same way `@types/express` already does.
  - `services/auth`: `express-rate-limit@8.7.0`. 8.7.1 was published 2026-10-06, under two weeks before intake, so it was skipped.
- **`libs/shared/src/security.ts`**, exported by name from `index.ts`:
  - `securityHeaders(): RequestHandler` returns `helmet()` with its defaults. Helmet also removes `X-Powered-By`.
  - `corsPolicy(): RequestHandler` returns `cors({ exposedHeaders: [...] })` with any origin and no credentials. The exposed headers are `x-request-id`, `retry-after`, `ratelimit`, `ratelimit-policy` and `www-authenticate`, so browser clients can read the request ID, rate-limit state and auth challenges. The `cors` package answers preflight `OPTIONS` with `204` by default.
- **`libs/shared/src/errors.ts`:** add `tooManyRequests = problemFactory(429)`, exported by name. A plain call gives `code: "too-many-requests"` and `type: "about:blank"`.
- **All three `createApp` functions:** mount `securityHeaders()` and `corsPolicy()` right after `httpLogger(logger)`. That way every response gets the headers, including health, docs, `404`, error responses and preflights, and preflights still get a request ID and a log line. `createApp` signatures for payment and notification stay unchanged.
- **Auth login limiter:**
  - `services/auth/src/auth/auth.limiter.ts`: `createLoginLimiter({ logger, max, windowMs }): RequestHandler`, exported by name from `auth/index.ts`, built on `rateLimit` with these options:
    - `limit: max`, `windowMs` and `skipSuccessfulRequests: true`
    - `standardHeaders: "draft-8"` and `legacyHeaders: false`
    - the default key generator: `req.ip`, with IPv6 grouped by subnet
    - the default `MemoryStore`
    - `handler: (_req, _res, next) => next(tooManyRequests("Too many failed login attempts. Try again later."))`
    - `logger`: a small adapter over the app's pino logger (`error`/`warn` → `logger.error({ err }, message)` / `logger.warn(...)`), so any validation that still fires never reaches `console`
    - `validate: { xForwardedForHeader: false, forwardedHeader: false }`. Add a one-line comment giving the reason: the services do not set `trust proxy`, so those headers are deliberately ignored and the warning would be noise.
  - `authRouter(controller, loginLimiter)` mounts it as `router.post("/auth/login", loginLimiter, controller.login)`. Register is not limited.
  - What counts: the limiter runs after `express.json` on `/auth`, so body-parser rejections (`413`, `415`, `400 malformed-json`) never reach it and are neither counted nor limited; they never reach bcrypt either. `400 validation-error`, `401`, `429` and any `5xx` on login count as failures. Document this in the README bullet.
  - `createApp` takes a new `loginRateLimit: { max: number; windowMs: number }` and builds one limiter per app, so each test app starts with fresh counts.
  - `authConfigSchema` adds `LOGIN_RATE_LIMIT_MAX` (int ≥ 1, default `10`) and `LOGIN_RATE_LIMIT_WINDOW_MS` (int from 1000 to 2147483647, the `MemoryStore` timer limit; default `900000`). `main.ts` passes both values through.
- **OpenAPI:** login adds `429` to `problemResponses`. Its description says failed attempts are limited per IP and a limited response carries `Retry-After`.
- **Docs:**
  - `README.md` Install and run: one sentence naming the two `LOGIN_RATE_LIMIT_*` variables and their defaults, next to the `.env.example` paragraph.
  - `README.md` Auth endpoints: add `429 too-many-requests` to login's errors, with a bullet on the limit (failed attempts per IP, defaults, `Retry-After`/`RateLimit` headers, counts reset on restart).
  - `README.md` Errors table: add a `429 too-many-requests` row.
  - `README.md` API: one sentence saying every service sends helmet's security headers and allows CORS from any origin, with no credentials.
  - `.env.example`: add `LOGIN_RATE_LIMIT_MAX=10` and `LOGIN_RATE_LIMIT_WINDOW_MS=900000`.
  - `ROADMAP.md`: link this doc from the BE-02-04 row and update its status.
- **Tests** (Jest, next to the code):
  - `libs/shared/src/security.test.ts`, supertest against a small app using `securityHeaders()`, `corsPolicy()` and a route:
    - `content-security-policy` and `x-content-type-options: nosniff` are present, and `x-powered-by` is absent.
    - A request with `Origin: https://example.test` gets `access-control-allow-origin: *` and the exposed-headers list, and no `access-control-allow-credentials`.
    - A preflight `OPTIONS` with `Access-Control-Request-Method: PATCH` gets `204` and `access-control-allow-methods` containing `PATCH`.
  - `libs/shared/src/errors.test.ts`, in "problem helpers": `tooManyRequests()` gives a `429` with `code: "too-many-requests"`, `type: "about:blank"` and title `Too Many Requests`.
  - `services/*/src/app.test.ts`: each service's responses (health and a `404`) carry the helmet headers and `access-control-allow-origin: *`, and no `x-powered-by`.
  - `services/auth/src/auth/auth.routes.test.ts`, with `setup()` taking an optional `loginRateLimit` (here `{ max: 2, windowMs: 60_000 }`). Send requests with sequential `await`s, never `Promise.all`: a success is only uncounted once its response has finished.
    - Two wrong-password logins get `401`. The third gets `429`: `application/problem+json`, `code: "too-many-requests"`, `cache-control: no-store`, a numeric `retry-after`, and `ratelimit` and `ratelimit-policy` headers.
    - Successful logins do not count: with `max: 2`, three successful logins in a row all get `200`.
    - A limited login does not reach the controller: after two failures, the correct password gets `429` (the controller would answer `200`) and no `user logged in` line appears in `raw`.
    - Requests carrying `X-Forwarded-For` and `Forwarded` headers are still counted per socket IP, and no `ERR_ERL_` text appears in `raw`.
    - Register is not limited: more than `max` failed registers (`409`) never return `429`.
  - `services/auth/src/config/config.test.ts`: the two new defaults, and rejection of `LOGIN_RATE_LIMIT_MAX=0` and of a window above `2147483647`.
  - Pass `loginRateLimit` from the existing helpers (`deps()` in `app.test.ts`, `setup()` in `auth.routes.test.ts`) with values large enough that current tests never hit the limit.

## Preserve

- The error model's response shape, `Cache-Control: no-store` on errors, and every existing error code.
- Health, readiness, docs, request IDs, log redaction and graceful shutdown in all three services.
- The register and login request and response contracts, and the `401 invalid-credentials` behavior.
- `/docs` keeps working in development under helmet's default CSP.
- Every existing test, adjusted only for the new `createApp` parameter and the added headers.

## Excluded

- A `CORS_ORIGINS` allowlist or CORS credentials.
- Rate limits on register or on any other route, and a global limiter.
- Keys based on email or account, account lockout, and a shared or persistent limiter store (such as Redis). Counts reset when auth restarts.
- `trust proxy` configuration and proxy deployment. This is revisited with BE-07-03 if needed.
- Custom CSP directives, per-route helmet settings, and HTTPS.
- Refresh tokens, password reset, email verification, OAuth.

## Likely Files To Touch

- `libs/shared/src/security.ts`, `security.test.ts`, `errors.ts`, `errors.test.ts`, `index.ts`, `package.json`
- `services/auth/src/auth/auth.limiter.ts`, `auth.routes.ts`, `auth.routes.test.ts`, `auth.openapi.ts`, `index.ts`
- `services/auth/src/app.ts`, `app.test.ts`, `main.ts`, `config/config.ts`, `config/config.test.ts`, `package.json`
- `services/payment/src/app.ts`, `app.test.ts`; `services/notification/src/app.ts`, `app.test.ts`
- `pnpm-lock.yaml`, `.env.example`, `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None.

Settled during intake on 2026-10-18:
- **CORS:** any origin, no credentials. Bearer tokens travel in a header, not cookies, so `*` exposes no ambient credentials. Rejected: an env allowlist that is empty by default; an allowlist with a dev default.
- **Limiter key and counting:** failed attempts per client IP, using `skipSuccessfulRequests`. Rejected: counting every attempt (lets a busy shared IP lock out legitimate users); IP plus email (one IP could then try many accounts).
- **Store:** in-memory, matching the Caching decision (one instance per service).
- **Placement:** helmet and CORS in `libs/shared` for every service. The limiter only in auth, because no other service has a login.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as the `validate` override.
- Install with `pnpm --filter @payment-be/shared add -E helmet@8.3.0 cors@2.8.6 @types/cors@2.8.19` and `pnpm --filter @payment-be/auth add -E express-rate-limit@8.7.0`. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Never log, or put in an error message, an email, password or token from the limited request.
- Set the BE-02-04 roadmap row to `in-progress` when starting.

## Deliverables

- `securityHeaders`, `corsPolicy` and `tooManyRequests` exported from `@payment-be/shared`, with tests.
- All three services mount the headers and CORS, with app tests.
- A login rate limiter in auth with env config, OpenAPI `429`, and tests.
- `README.md`, `.env.example` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- `pnpm infra:up && pnpm dev`, then:
  - `curl -si localhost:3002/health/live` shows `content-security-policy`, `access-control-allow-origin: *` and no `x-powered-by`.
  - Eleven wrong-password logins in a row against `localhost:3001/auth/login` return ten `401`s and then a `429` problem body with `retry-after`. A login with the seeded admin's correct password from the same IP also gets `429` until the window passes.
  - `http://localhost:3001/docs` renders in Chrome and Firefox with no CSP errors in the console, and **Try it out** on `POST /auth/login` works. If the default CSP blocks it (for example through `upgrade-insecure-requests`), stop and record it here: custom CSP directives are excluded, so the fix needs a user decision.
- No express-rate-limit validation output (`ERR_ERL_`/`WRN_ERL_`) appears in the dev logs during the curl checks, including a login sent with `-H 'X-Forwarded-For: 1.2.3.4'`.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-02-04 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-07-03: if the services run behind a proxy, set `trust proxy` to the proxy hop count and turn express-rate-limit's `xForwardedForHeader` validation back on.
- BE-06-04: check that the `429` on login and its headers are described in the OpenAPI review.
