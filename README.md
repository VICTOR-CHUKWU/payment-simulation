# payment-simulation

A payment processing simulation built as Node.js microservices. Users create payments, a simulated gateway processes them in the background, and a notification service tells users the result in the app and by email.

> **Status:** in progress. The monorepo scaffold, local infrastructure (NATS, Mailpit) and shared config, event and NATS helpers are in place. Each service starts an HTTP server with health endpoints, structured request logging, graceful shutdown and Swagger UI in development. The auth service stores users, seeds demo accounts, and serves register and login with JWT access tokens. The payment service stores payments, serves `POST /payments`, `GET /payments/:id` and the admin-only `PATCH /payments/:id/status`, and settles new payments in the background through a simulated gateway. Payment events and the notification service are not implemented yet. Progress is tracked in [ROADMAP.md](ROADMAP.md). Setup, run, API and testing instructions will be added as each part lands.

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
2. The background processor claims the payment by moving it to `processing`, then sends it to a simulated gateway, which succeeds or fails after a random delay.
3. The payment service records the result and publishes `payment.succeeded` or `payment.failed`.
4. The notification service creates an in-app notification and sends an email. Failed emails are retried with backoff, and emails that still fail are moved to a dead-letter queue for inspection and replay.

A payment that is still `pending` can be cancelled instead. `succeeded`, `failed` and `cancelled` are final, and any status change outside this flow is rejected with `409 invalid-status-transition`.

How the processor behaves:

- It checks for work every `PROCESSOR_POLL_INTERVAL_MS`, so a new payment can wait up to one interval before it is claimed. It works on the oldest payments first, at most `PROCESSOR_CONCURRENCY` at a time.
- The simulated gateway answers after a random delay between `GATEWAY_MIN_DELAY_MS` and `GATEWAY_MAX_DELAY_MS`, and declines a share of payments (`GATEWAY_FAILURE_RATE`) with a reason such as `Card declined`. On a share of calls (`GATEWAY_TIMEOUT_RATE`) it never answers. If no answer arrives within `GATEWAY_TIMEOUT_MS`, the payment becomes `failed` with `failureReason` `Gateway timed out`.
- On shutdown the processor stops first and abandons any gateway call still waiting, without recording a result. Those payments stay `processing`. On the next start, and whenever a result could not be saved, they are sent to the gateway again, with the payment ID as the idempotency key a real gateway would use.
- An admin's `PATCH /payments/:id/status` to `succeeded` or `failed` races the processor for a `processing` payment. Whichever change is saved first wins: the other gets `409 invalid-status-transition` (the admin) or is dropped and logged as `payment already settled` (the processor).

### Events

Payment events go to the JetStream stream `PAYMENTS`, which captures `payment.>`, with one subject per status change. Each event's `type` is also its subject. The payment service starts publishing them in BE-04-02; until then the stream exists but stays empty.

| Type | Emitted when |
|---|---|
| `payment.created` | A payment is saved as `pending` |
| `payment.processing` | The processor claims the payment |
| `payment.succeeded` | The payment succeeds, through the gateway or an admin |
| `payment.failed` | The payment fails, through the gateway or an admin |
| `payment.cancelled` | An admin cancels a `pending` payment |

Every event has the shared envelope (`eventId`, `type`, `occurredAt`, `data`). `data` holds `paymentId`, `userId`, `email`, `amount` (integer minor units), `currency` (ISO 4217 code) and the optional `description`. `payment.failed` also carries `failureReason`. The request's correlation ID travels in the `x-correlation-id` message header.

The stream stores messages on disk for 7 days. JetStream drops a second publish of the same `eventId` within 2 minutes; consumers still handle duplicates themselves.

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

The payment processor and simulated gateway (see [Payment flow](#payment-flow)) read these:

| Variable | Default | Meaning |
|---|---|---|
| `PROCESSOR_POLL_INTERVAL_MS` | `1000` | Time between checks for payments to process (at least `10`) |
| `PROCESSOR_CONCURRENCY` | `5` | Most payments processed at once |
| `GATEWAY_MIN_DELAY_MS`, `GATEWAY_MAX_DELAY_MS` | `1000`, `5000` | Range of the gateway's random answer delay; the minimum cannot exceed the maximum |
| `GATEWAY_FAILURE_RATE` | `0.2` | Share of answers that decline the payment, from `0` to `1` |
| `GATEWAY_TIMEOUT_RATE` | `0.05` | Share of calls the gateway never answers, from `0` to `1` |
| `GATEWAY_TIMEOUT_MS` | `10000` | How long the processor waits before failing the payment; must be greater than `GATEWAY_MAX_DELAY_MS` |

`pnpm infra:up` starts NATS (with JetStream) and Mailpit in Docker and returns once both are healthy.

`pnpm dev` starts all three services in watch mode. To run the compiled build instead:

```sh
pnpm build
pnpm start
```

A service stops at startup with a clear error if an environment variable is invalid, NATS is unreachable, or (for `auth` and `payment`) its data file is invalid or locked by another running process. The error names the variable but never shows its value. On start, `payment` and `notification` create the `PAYMENTS` stream if it is missing, or update it to match the expected settings. If NATS refuses the change (for example a different storage type left over from an older setup), the service stops with the server's error; `pnpm infra:reset` clears the old stream locally. Once a service is running, it reconnects to NATS on its own if the connection drops. On SIGTERM or SIGINT it stops taking new connections, stops the payment processor (payment), drains NATS (payment and notification), closes its storage (auth and payment) and exits.

### Health checks

| Service | Port | Liveness | Readiness |
|---|---|---|---|
| auth | 3001 | `/health/live` | `/health/ready` |
| payment | 3002 | `/health/live` | `/health/ready` |
| notification | 3003 | `/health/live` | `/health/ready` |

Liveness always returns `200` while the process is up. Readiness returns `200` when every dependency check passes and `503` when one fails, for example while NATS is down. The response lists each check as `ok` or `fail`. `auth` reports `storage`, and `payment` reports `nats` and `storage`; `storage` fails if the data file can no longer be written.

```sh
curl -i localhost:3002/health/ready
```

### Storage and demo accounts

Each service keeps its own data. `STORAGE_DRIVER=file` (the default) stores it as JSON in `services/<service>/data/` (set by `DATA_DIR`, relative to the service folder), so it survives restarts. `STORAGE_DRIVER=memory` keeps it in memory only. Delete the `data` folder to start fresh. `auth` stores users in `services/auth/data/users.json` and `payment` stores payments in `services/payment/data/payments.json`.

On every start, `auth` creates these accounts if their emails are not stored yet. An existing account is never changed, so a password you change stays changed.

| Role | Email | Password |
|---|---|---|
| admin | `admin@example.com` | `Admin123!` |
| user | `user@example.com` | `User123!` |

`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` override them. Passwords must be 8 to 72 bytes. With `NODE_ENV=production` there are no default passwords: both must be set, or `auth` refuses to start.

### Logging

Each service logs one JSON object per line through pino. In development (`NODE_ENV=development`) the lines are printed in a readable, coloured format instead. `LOG_LEVEL` sets the minimum level (`info` by default; `silent` turns logging off).

Every HTTP request gets an ID. If the request sends an `x-request-id` header of up to 128 letters, digits, `.`, `_` or `-`, that value is reused; otherwise a UUID is generated. The ID is returned in the `x-request-id` response header and appears as `correlationId` on every log line for that request, and it travels to other services in event headers. Search for one `correlationId` to follow a request across services. Health probes are not logged.

Each request produces one `request completed` line with the method, URL, status code and response time. Request and response headers are never logged. Log lines identify a signed-in user by `userId` and `role`, never by email. Any `password`, `token`, `accessToken` or `email` field is replaced with `"[Redacted]"`.

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

Once login and protected routes exist, call them from Swagger UI like this: log in with `POST /auth/login` on the auth service's page, copy `data.accessToken` from the response, then click **Authorize** on the other service's page and paste it. Swagger UI sends it as `Authorization: Bearer <token>`. Each service runs on its own port, which the browser treats as a separate origin, so authorize once per service; the token survives page reloads.

### Responses

Every successful response uses one envelope. The payload is in `data`, and `status` repeats the HTTP status. `message` is a short summary of what happened, or `null` when there is nothing to add (for example, a plain read).

```json
{
  "status": 201,
  "success": true,
  "data": { "id": "9b89…", "status": "pending" },
  "message": "Payment created"
}
```

Paginated responses also carry `meta`, and `data` is an array:

```json
{
  "status": 200,
  "success": true,
  "data": [ … ],
  "message": null,
  "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 }
}
```

Errors do not use the envelope; they use Problem Details (see [Errors](#errors)). Health endpoints and `/docs/openapi.json` also return their own bodies unwrapped. The tables below list the shape of `data`.

### Auth endpoints

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `POST` | `/auth/register` | `{ email, password }` | `201` with `data: { id, email, role, createdAt }` | `400`, `409 email-taken`, `413`, `415` |
| `POST` | `/auth/login` | `{ email, password }` | `200` with `data: { accessToken, tokenType: "Bearer", expiresIn }` | `400`, `401 invalid-credentials`, `413`, `415`, `429 too-many-requests` |

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

### Payment endpoints

Every payment endpoint needs `Authorization: Bearer <accessToken>`, using a token from `POST /auth/login`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `POST` | `/payments` | `{ amount, currency, description? }` | `201` with `data: { id, userId, email, amount, currency, status: "pending", description?, createdAt, updatedAt }`, or `200` with the existing payment and the message `Payment already exists for this Idempotency-Key` on an idempotent replay | `400`, `401`, `413`, `415`, `422` |
| `GET` | `/payments/:id` | — | `200` with `data`: the payment, in the same shape | `400`, `401`, `404` |
| `PATCH` | `/payments/:id/status` | `{ status, failureReason? }` | `200` with `data`: the updated payment, and the message `Payment status updated` | `400`, `401`, `403`, `404`, `409`, `413`, `415` |

- `amount` is a positive integer in minor units (kobo, cents), so `150000` in `NGN` is ₦1,500.00. Decimals are rejected.
- `currency` is one of `NGN`, `USD`, `EUR` or `GBP`. `description` is optional, 1 to 140 characters.
- The owner (`userId`, `email`) comes from the access token. Any other field in the body, such as `status` or `userId`, is rejected with `400`. Any logged-in user, admin included, can create a payment.
- A new payment is `pending`. The token is checked before the body is read, so a request without a valid token gets `401` whatever its body.
- Request bodies must be JSON (`Content-Type: application/json`) and at most 16 kB.
- An optional `Idempotency-Key` header (1 to 255 printable ASCII characters, no spaces) makes retries safe. Keys are scoped to the caller and never expire. Repeating a request with the same key and body returns `200` with the existing payment in its current state, without creating another. Reusing the key with a different `amount`, `currency` or `description` returns `422 idempotency-key-reused`. Sending the header more than once returns `400`. Without the header, every request creates a new payment.
- `GET /payments/:id` returns a user's own payments only. Admins can read any payment. Another user's payment returns `404 payment-not-found`, the same as an unknown ID. An ID that is not a UUID returns `400`.
- `PATCH /payments/:id/status` is for admins only. Any other caller gets `403`, checked before the body is read. An admin can cancel a `pending` payment (`cancelled`), or mark a `processing` payment `succeeded` or `failed`. `processing` is set only by the payment processor, so asking for it, or for `pending`, returns `400`. `failureReason` (1 to 200 characters) is required for `failed` and rejected for any other status.
- A change the payment's current status does not allow, including setting the status it already has, returns `409 invalid-status-transition`, with a `detail` naming both statuses. If the payment changes under the request (for example the processor updates it at the same moment), the update is re-checked against the fresh state and tried up to 3 times in total before returning `409 version-conflict`.

```sh
TOKEN=$(curl -s -X POST localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"User123!"}' | jq -r .data.accessToken)

curl -i -X POST localhost:3002/payments \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-42' \
  -d '{"amount":150000,"currency":"NGN","description":"Order #42"}'

curl -i localhost:3002/payments/<id> -H "authorization: Bearer $TOKEN"

ADMIN_TOKEN=$(curl -s -X POST localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"Admin123!"}' | jq -r .data.accessToken)

curl -i -X PATCH localhost:3002/payments/<id>/status \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"status":"cancelled"}'
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
| 409 | `invalid-status-transition` | The payment's current status does not allow the requested status |
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
