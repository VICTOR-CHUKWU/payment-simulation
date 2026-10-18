# payment-simulation

A payment processing simulation built as Node.js microservices. Users create payments, a simulated gateway processes them in the background, and a notification service tells users the result in the app and by email.

> **Status:** in progress. The monorepo scaffold, local infrastructure (NATS, Mailpit) and shared config, event and NATS helpers are in place. Each service starts an HTTP server with health endpoints, structured request logging, graceful shutdown and Swagger UI in development. The auth service stores users, seeds demo accounts, and serves register and login with JWT access tokens. Payment and notification endpoints are not implemented yet. Progress is tracked in [ROADMAP.md](ROADMAP.md). Setup, run, API and testing instructions will be added as each part lands.

## The brief

Build a Node.js microservice that simulates payment processing, exposing a RESTful API to create payments, retrieve them by ID, and update their status. The brief asks for:

- An Express server with create (POST), retrieve by ID (GET) and update status (PUT/PATCH) endpoints
- Simulated payment processing with asynchronous operations
- In-memory or JSON-file persistence
- Proper error responses, with an emphasis on error handling and logging
- Unit tests (Mocha/Chai or Jest) and API documentation (Swagger or Markdown)
- A Git repository with a README covering setup, API details and testing

## Architecture

| Component | Responsibility |
|---|---|
| `services/auth` | Users, registration, login, JWT issuing. Seeds one admin and one normal user |
| `services/payment` | Payment API, status rules, simulated gateway and background processor. Publishes payment events |
| `services/notification` | Consumes payment events. Stores in-app notifications and sends email, with retries and a dead-letter queue |
| `libs/shared` | Event contracts, NATS client wrapper, logger, error model, config, auth middleware |

Services communicate through NATS JetStream. Each service owns its data, stored in memory or in a JSON file depending on configuration.

### Payment flow

1. A logged-in user calls `POST /payments`. The payment is saved as `pending` and a `payment.created` event is published.
2. The background processor sends the payment to a simulated gateway, which succeeds or fails after a random delay.
3. The payment service records the result and publishes `payment.succeeded` or `payment.failed`.
4. The notification service creates an in-app notification and sends an email. Failed emails are retried with backoff, and emails that still fail are moved to a dead-letter queue for inspection and replay.

## Tech stack

Node.js 24, TypeScript, Express, NATS JetStream, Zod, pino, Jest and supertest, Swagger UI, Biome (Ultracite), pnpm workspaces, docker-compose for local infrastructure (NATS and Mailpit).

## Getting started

### Prerequisites

- Node.js 24 (`.nvmrc` is included, so `nvm use` works)
- pnpm. Run `corepack enable`, or install pnpm on its own. pnpm switches to the version pinned in `package.json`.
- Docker with Compose v2.1.1 or later (`docker compose`), for NATS and the mail catcher.

### Install and run

```sh
pnpm install
cp .env.example .env
pnpm infra:up
pnpm dev
```

`.env.example` lists the environment variables with values that work locally. The two seed passwords and `JWT_SECRET` are commented out, because they fall back to demo values outside production (see [Storage and demo accounts](#storage-and-demo-accounts)).

`JWT_SECRET` signs access tokens in `auth`, and `payment` and `notification` verify them with it locally, so every service must use the same value. It must be at least 32 characters, or the service refuses to start. Outside production, services share a built-in dev secret. With `NODE_ENV=production` it has no default: set it, or every service refuses to start.

`LOGIN_RATE_LIMIT_MAX` (default `10`) and `LOGIN_RATE_LIMIT_WINDOW_MS` (default `900000`, 15 minutes) set how many failed logins `auth` allows per client IP in each window (see [Auth endpoints](#auth-endpoints)).

`pnpm infra:up` starts NATS (with JetStream) and Mailpit in Docker and returns once both are healthy.

`pnpm dev` starts all three services in watch mode. To run the compiled build instead:

```sh
pnpm build
pnpm start
```

A service stops at startup with a clear error if an environment variable is invalid, NATS is unreachable, or (for `auth`) its data file is invalid or locked by another running process. The error names the variable but never shows its value. Once a service is running, it reconnects to NATS on its own if the connection drops. On SIGTERM or SIGINT it stops taking new connections, drains NATS (payment and notification), closes its storage (auth) and exits.

### Health checks

| Service | Port | Liveness | Readiness |
|---|---|---|---|
| auth | 3001 | `/health/live` | `/health/ready` |
| payment | 3002 | `/health/live` | `/health/ready` |
| notification | 3003 | `/health/live` | `/health/ready` |

Liveness always returns `200` while the process is up. Readiness returns `200` when every dependency check passes and `503` when one fails, for example while NATS is down. The response lists each check as `ok` or `fail`. `auth` reports `storage`, which fails if its data file can no longer be written.

```sh
curl -i localhost:3002/health/ready
```

### Storage and demo accounts

Each service keeps its own data. `STORAGE_DRIVER=file` (the default) stores it as JSON in `services/<service>/data/` (set by `DATA_DIR`, relative to the service folder), so it survives restarts. `STORAGE_DRIVER=memory` keeps it in memory only. Delete the `data` folder to start fresh. Only `auth` stores data so far.

On every start, `auth` creates these accounts if their emails are not stored yet. An existing account is never changed, so a password you change stays changed.

| Role | Email | Password |
|---|---|---|
| admin | `admin@example.com` | `Admin123!` |
| user | `user@example.com` | `User123!` |

`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` override them. Passwords must be 8 to 72 bytes. With `NODE_ENV=production` there are no default passwords: both must be set, or `auth` refuses to start.

### Logging

Each service logs one JSON object per line through pino. In development (`NODE_ENV=development`) the lines are printed in a readable, coloured format instead. `LOG_LEVEL` sets the minimum level (`info` by default; `silent` turns logging off).

Every HTTP request gets an ID. If the request sends an `x-request-id` header of up to 128 letters, digits, `.`, `_` or `-`, that value is reused; otherwise a UUID is generated. The ID is returned in the `x-request-id` response header and appears as `correlationId` on every log line for that request, and it travels to other services in event headers. Search for one `correlationId` to follow a request across services. Health probes are not logged.

Log lines identify a signed-in user by `userId` and `role`, never by email. The `authorization`, `cookie` and `set-cookie` headers, and any `password`, `token`, `accessToken` or `email` field, are replaced with `"[Redacted]"`.

```sh
curl -i -H 'x-request-id: abc-123' localhost:3002/nope
```

### Local infrastructure

| Service | Address |
|---|---|
| NATS | `nats://localhost:4222` |
| NATS monitoring | http://localhost:8222 |
| Mailpit web UI (caught emails) | http://localhost:8025 |
| Mailpit SMTP | `localhost:1025` |

All ports listen on `127.0.0.1` only. If NATS or Mailpit is already running directly on your machine (for example through Homebrew), stop it first: it would hold the same port and answer instead of the container.

```sh
pnpm infra:logs    # follow NATS and Mailpit logs
pnpm infra:down    # stop containers, keep JetStream data
pnpm infra:reset   # stop containers and wipe JetStream data
```

Mailpit keeps emails in memory, so they are cleared whenever its container stops.

### Checks

```sh
pnpm check       # lint and format (Biome via Ultracite)
pnpm fix         # apply safe fixes
pnpm typecheck   # TypeScript, including tests
pnpm test        # Jest
```

## API

Each service serves Swagger UI and its OpenAPI 3.1 spec, generated from Zod schemas. Endpoints are summarised below as they land.

| Service | Swagger UI | Spec |
|---|---|---|
| auth | http://localhost:3001/docs | http://localhost:3001/docs/openapi.json |
| payment | http://localhost:3002/docs | http://localhost:3002/docs/openapi.json |
| notification | http://localhost:3003/docs | http://localhost:3003/docs/openapi.json |

Every service sends [helmet](https://helmetjs.github.io/)'s default security headers, including a Content Security Policy, and no `X-Powered-By`. CORS allows any origin without credentials, which is safe because access tokens travel in the `Authorization` header, not in cookies. Browsers can read the `x-request-id`, `Retry-After`, `RateLimit`, `RateLimit-Policy` and `WWW-Authenticate` response headers.

The docs are served only when `NODE_ENV=development`. With `test` or `production`, `/docs` returns the usual `404`.

Once login and protected routes exist, call them from Swagger UI like this: log in with `POST /auth/login` on the auth service's page, copy `accessToken` from the response, then click **Authorize** on the other service's page and paste it. Swagger UI sends it as `Authorization: Bearer <token>`. Each service runs on its own port, which the browser treats as a separate origin, so authorize once per service; the token survives page reloads.

### Auth endpoints

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `POST` | `/auth/register` | `{ email, password }` | `201` with `{ id, email, role, createdAt }` | `400`, `409 email-taken`, `413`, `415` |
| `POST` | `/auth/login` | `{ email, password }` | `200` with `{ accessToken, tokenType: "Bearer", expiresIn }` | `400`, `401 invalid-credentials`, `413`, `415`, `429 too-many-requests` |

- Register always creates a `user`. Emails are trimmed and lowercased, so `Ada@Example.com` and `ada@example.com` are the same account. Passwords must be 8 to 72 bytes. Any other field in the body, such as `role`, is rejected with `400`.
- Login returns an HS256 JWT valid for 24 hours (`expiresIn` is in seconds), with the claims `sub` (user ID), `email`, `role`, `iat` and `exp`. An unknown email and a wrong password get the same `401`.
- Login is rate limited per client IP: after `LOGIN_RATE_LIMIT_MAX` failed attempts (default 10) within `LOGIN_RATE_LIMIT_WINDOW_MS` (default 15 minutes), further logins from that IP get `429 too-many-requests`, even with the right password, until the window passes. Successful logins do not count. Any `400` from failed validation, `401`, `429` or `5xx` counts as a failure. Bodies the JSON parser rejects (`413`, `415`, malformed JSON) are answered before the limiter runs, so they are neither counted nor limited. Every other login response carries `RateLimit` and `RateLimit-Policy` headers, and a `429` also carries `Retry-After` in seconds. Counts are kept in memory and reset when `auth` restarts.
- Request bodies must be JSON (`Content-Type: application/json`) and at most 16 kB.

```sh
curl -i -X POST localhost:3001/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"Passw0rd!"}'

curl -s -X POST localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"Admin123!"}'
```

### Errors

Every error response uses [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457), with content type `application/problem+json` and `Cache-Control: no-store`. Unknown paths get a `404` in this format too. The one exception is `/health/ready`, whose `503` keeps its own `{ checks, status }` body.

```json
{
  "type": "tag:payment-be,2026:validation-error",
  "title": "Validation failed",
  "status": 400,
  "detail": "The request is invalid.",
  "instance": "/payments",
  "code": "validation-error",
  "requestId": "abc-123",
  "errors": [
    { "pointer": "/amount", "detail": "Too small: expected number to be >0", "code": "too_small" }
  ]
}
```

- `code` is a stable string to branch on. `type` is `about:blank` when the HTTP status says it all, and a `tag:payment-be,2026:<code>` URI for errors specific to this service.
- `requestId` matches the `x-request-id` response header and the `correlationId` in the logs, so quote it when reporting a problem.
- `instance` is the request path, without the query string.
- `errors` appears only on validation errors. Each entry points at the invalid field with a [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901).

| Status | `code` | When |
|---|---|---|
| 400 | `validation-error` | The request does not match its schema |
| 400 | `malformed-json` | The request body is not valid JSON |
| 400–499 | the status name in kebab case, for example `not-found` | Other client errors |
| 401 | `invalid-credentials` | Login with an unknown email or a wrong password |
| 401 | `unauthorized` | A protected endpoint was called without an `Authorization: Bearer <token>` header. The response carries `WWW-Authenticate: Bearer` |
| 401 | `invalid-token` | The access token is invalid, expired or has bad claims; log in again. The response carries `WWW-Authenticate: Bearer error="invalid_token"` |
| 403 | `forbidden` | The caller's role is not allowed to use the endpoint |
| 409 | `email-taken` | Register with an email that already has an account |
| 409 | `version-conflict` | The resource changed since it was read; fetch it and retry |
| 413 | `payload-too-large` | The request body is too large |
| 415 | `unsupported-media-type` | The body's media type, charset or encoding is not supported |
| 429 | `too-many-requests` | Too many failed logins from this IP. The response carries `Retry-After` in seconds |
| 500 | `internal-error` | Anything unexpected |

A `500` response never includes the error message, stack or request body. The real error is logged once, on the request's log line, with its `correlationId`.

```sh
curl -i localhost:3002/nope
```

## Testing

Run `pnpm test` from the repo root. To run one package, pass its path, for example `pnpm test -- services/auth`. Tests sit next to the code they cover as `*.test.ts`. API tests drive each service's `createApp` with supertest, using the in-memory storage adapter, so they need neither Docker nor a running server. This section will grow to cover cross-service integration tests.

## Project docs

- [ROADMAP.md](ROADMAP.md): scope, decisions and status
- [tasks/](tasks/): task docs for individual roadmap items
