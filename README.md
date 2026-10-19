# payment-simulation

A payment processing simulation built as Node.js microservices. Users create payments, a simulated gateway processes them in the background, and a notification service tells users the result in the app and by email.

> **Status:** in progress. The monorepo scaffold, local infrastructure (NATS, Mailpit) and shared config, event and NATS helpers are in place. Each service starts an HTTP server with health endpoints, structured request logging, graceful shutdown and Swagger UI in development. The auth service stores users, seeds demo accounts, and serves register and login with JWT access tokens. The payment service stores payments, serves `POST /payments`, `GET /payments/:id` and the admin-only `PATCH /payments/:id/status`, and settles new payments in the background through a simulated gateway. The payment service publishes lifecycle events to NATS JetStream. The notification service consumes them, stores in-app notifications and serves them through `GET /notifications` and mark-as-read endpoints. It also emails the payment's owner when a payment is received, succeeds, fails or is cancelled, through SMTP (Mailpit locally), retrying failed sends with growing delays and moving emails that still fail to a dead-letter queue that admins can inspect and replay. Progress is tracked in [ROADMAP.md](ROADMAP.md). Setup, run, API and testing instructions will be added as each part lands.

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

Payment events go to the JetStream stream `PAYMENTS`, which captures `payment.>`, with one subject per status change. Each event's `type` is also its subject.

| Type | Emitted when |
|---|---|
| `payment.created` | A payment is saved as `pending` |
| `payment.processing` | The processor claims the payment |
| `payment.succeeded` | The payment succeeds, through the gateway or an admin |
| `payment.failed` | The payment fails, through the gateway or an admin |
| `payment.cancelled` | An admin cancels a `pending` payment |

Every event has the shared envelope (`eventId`, `type`, `occurredAt`, `data`). `data` holds `paymentId`, `userId`, `email`, `amount` (integer minor units), `currency` (ISO 4217 code) and the optional `description`. `payment.failed` also carries `failureReason`. A correlation ID travels in the `x-correlation-id` message header. Events from the processor carry the ID of the `POST /payments` request that created the payment, so one ID follows a payment through every service. Events from an admin `PATCH /payments/:id/status` carry that request's own ID.

The stream stores messages on disk for 7 days. JetStream drops a second publish of the same `eventId` within 2 minutes; consumers still handle duplicates themselves.

How the payment service publishes:

- Each event is saved in an outbox on the payment record, in the same write that changes the status. A status change and its event are always saved together, even if NATS is down.
- An outbox relay publishes waiting events right after each change, then checks again every `OUTBOX_RELAY_INTERVAL_MS`, and once at startup for events left from the previous run. A sent event is removed from the outbox. The outbox is internal and never appears in API responses.
- One payment's events are always published in order. If a publish fails, that payment's later events wait for the next try.
- Delivery is at least once. If the service stops after a publish but before removing the event, the event is sent again with the same `eventId`. Within 2 minutes JetStream drops the repeat; after that, consumers ignore it.

How the notification service consumes:

- Two durable pull consumers read `PAYMENTS`, one per channel: `notification-inapp` and `notification-email`. Both take every event (`payment.>`) and ack each message explicitly.
- A consumer created for the first time reads from the start of the stream, so events published before `notification` first started are not lost. After that, each consumer continues from its last ack.
- Each message is checked against the event schema. A valid event is logged, handled and acked; one the channel has already processed is acked without being handled again. A message that is not valid JSON or does not match the schema is terminated, so it is never redelivered, and a warning is logged without its contents. If handling a valid event fails, the message is nak'd and redelivered after 5 seconds.
- Each channel records an event as processed (in its inbox) only after its work succeeds, and skips it on any later delivery, such as a redelivery, a replay from a recreated consumer or a late outbox republish. The two channels track this separately, so one channel's record never hides an event from the other. Handling is at least once: if the service stops after the work but before the record is saved, the event is handled again.
- The in-app handler stores a notification for every event except `payment.processing`, which follows `payment.created` within milliseconds. Each notification is keyed by the event's `eventId`, so an event handled again after a crash still leaves one notification. The email handler sends an email for the same four types, to the address carried in the event, with a plain-text and an HTML body. If sending fails (for example while Mailpit is down), the email is tried up to `EMAIL_MAX_ATTEMPTS` times (5 by default), waiting 5 seconds, 30 seconds, 2 minutes and then 10 minutes between attempts. A permanent rejection (a 5xx SMTP reply, such as an unknown recipient, or an envelope error with no SMTP reply) is not retried; a 4xx reply is retried, even for a refused recipient. An email that still fails, or is rejected, is published to the `DLQ` stream and its message is acked, so it is never redelivered; an admin can inspect and replay it (see [Admin DLQ endpoints](#admin-dlq-endpoints)). Attempts are counted per delivery, so a redelivery caused by something other than a send (for example the inbox file being unreadable) also uses one. The in-app handler is not bounded: if storing fails, it retries every 5 seconds until it succeeds. If the service stops after sending but before recording the event as processed, the email is sent again with the same `Message-ID`.

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

The payment processor, simulated gateway (see [Payment flow](#payment-flow)) and outbox relay (see [Events](#events)) read these:

| Variable | Default | Meaning |
|---|---|---|
| `PROCESSOR_POLL_INTERVAL_MS` | `1000` | Time between checks for payments to process (at least `10`) |
| `PROCESSOR_CONCURRENCY` | `5` | Most payments processed at once |
| `GATEWAY_MIN_DELAY_MS`, `GATEWAY_MAX_DELAY_MS` | `1000`, `5000` | Range of the gateway's random answer delay; the minimum cannot exceed the maximum |
| `GATEWAY_FAILURE_RATE` | `0.2` | Share of answers that decline the payment, from `0` to `1` |
| `GATEWAY_TIMEOUT_RATE` | `0.05` | Share of calls the gateway never answers, from `0` to `1` |
| `GATEWAY_TIMEOUT_MS` | `10000` | How long the processor waits before failing the payment; must be greater than `GATEWAY_MAX_DELAY_MS` |
| `OUTBOX_RELAY_INTERVAL_MS` | `1000` | Time between checks for payment events still waiting to be published (at least `10`) |

The notification service sends email with these:

| Variable | Default | Meaning |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT` | `localhost`, `1025` | SMTP server; the defaults point at Mailpit. No login or TLS is used |
| `SMTP_FROM` | `Payment Simulation <no-reply@payment-simulation.local>` | Sender of every email |
| `EMAIL_MAX_ATTEMPTS` | `5` | Send attempts per email before it moves to the dead-letter queue, from `1` to `20` |
| `EMAIL_RETRY_DELAYS_MS` | `5000,30000,120000,600000` | Comma-separated waits after each failed attempt; the last one repeats if the list is shorter |

`notification` starts and stays ready without Mailpit. Emails are retried on the schedule above and then moved to the dead-letter queue. For a quick demo, start with `EMAIL_MAX_ATTEMPTS=3 EMAIL_RETRY_DELAYS_MS=1000,2000 pnpm dev`.

`pnpm infra:up` starts NATS (with JetStream) and Mailpit in Docker and returns once both are healthy.

`pnpm dev` starts all three services in watch mode. To run the compiled build instead:

```sh
pnpm build
pnpm start
```

A service stops at startup with a clear error if an environment variable is invalid, NATS is unreachable, or (for `auth`, `payment` and `notification`) its data file is invalid or locked by another running process. The error names the variable but never shows its value. On start, `payment` and `notification` create the `PAYMENTS` stream if it is missing, or update it to match the expected settings, and `notification` does the same for the `DLQ` stream (dead-lettered emails, kept 30 days). `notification` then does the same for its two consumers and starts reading from them. If NATS refuses the change (for example a different storage type left over from an older setup), the service stops with the server's error; `pnpm infra:reset` clears the old stream locally. The same applies to a notification consumer whose settings NATS refuses to change, such as its start point. `payment` then publishes any events left waiting from its previous run. Once a service is running, it reconnects to NATS on its own if the connection drops. On SIGTERM or SIGINT it stops taking new connections, stops the payment processor and then the outbox relay (payment), stops reading from its consumers (notification), drains NATS (payment and notification), closes its storage (auth, payment and notification) and exits.

### Health checks

| Service | Port | Liveness | Readiness |
|---|---|---|---|
| auth | 3001 | `/health/live` | `/health/ready` |
| payment | 3002 | `/health/live` | `/health/ready` |
| notification | 3003 | `/health/live` | `/health/ready` |

Liveness always returns `200` while the process is up. Readiness returns `200` when every dependency check passes and `503` when one fails, for example while NATS is down. The response lists each check as `ok` or `fail`. `auth` reports `storage`, `payment` reports `nats` and `storage`, and `notification` reports `nats`, `consumers` and `storage`; `storage` fails if the data file can no longer be written (for `notification`, if either `inbox.json` or `notifications.json` can no longer be written), and `consumers` fails if either notification consumer's read loop has ended, for example after the NATS connection closed for good. A consumer deleted on the server does not end the loop: the service logs a warning and keeps retrying until it is recreated (a restart recreates it).

```sh
curl -i localhost:3002/health/ready
```

### Storage and demo accounts

Each service keeps its own data. `STORAGE_DRIVER=file` (the default) stores it as JSON in `services/<service>/data/` (set by `DATA_DIR`, relative to the service folder), so it survives restarts. `STORAGE_DRIVER=memory` keeps it in memory only. Delete the `data` folder to start fresh. `auth` stores users in `services/auth/data/users.json`, `payment` stores payments in `services/payment/data/payments.json`, and `notification` stores which events each channel has processed in `services/notification/data/inbox.json` and in-app notifications in `services/notification/data/notifications.json`.

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

Emails sent by `notification` appear in the Mailpit web UI at http://localhost:8025. Mailpit keeps emails in memory, so they are cleared whenever its container stops.

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

### Notification endpoints

Every notification endpoint needs `Authorization: Bearer <accessToken>`, using a token from `POST /auth/login`.

| Method | Path | Query | Success | Errors |
|---|---|---|---|---|
| `GET` | `/notifications` | `page?`, `limit?`, `unread?` | `200` with `data`: notifications `{ id, userId, type, paymentId, amount, currency, title, message, readAt, createdAt }` newest first, and `meta` | `400`, `401` |
| `PATCH` | `/notifications/:id/read` | — | `200` with `data`: the notification, and the message `Notification marked as read` | `400`, `401`, `404` |
| `PATCH` | `/notifications/read` | — | `200` with `data: { updated }` and the message `Notifications marked as read` | `401` |

- Every user sees only their own notifications, admins included. Another user's notification returns `404 notification-not-found`, the same as an unknown ID. An ID that is not a UUID returns `400`.
- A notification is stored for `payment.created`, `payment.succeeded`, `payment.failed` and `payment.cancelled`. `id` is the event's `eventId`, `createdAt` is when the event happened, and `readAt` is `null` until read. `amount` is in minor units; `message` shows it formatted, such as `Your payment of NGN 1,500.00 succeeded.`
- `page` starts at 1 and `limit` defaults to 20, up to 100. A page past the end returns an empty `data` with the usual `meta`.
- `unread=true` returns only unread notifications, so `meta.total` is the unread count. `unread=false` returns only read ones. Leave it out for both. Any other value, or an unknown query parameter, returns `400`.
- Marking a notification that is already read returns `200` and keeps its first `readAt`.
- `PATCH /notifications/read` returns how many notifications this request marked. Neither `PATCH` takes a body.

```sh
curl -i 'localhost:3003/notifications?unread=true' -H "authorization: Bearer $TOKEN"

curl -i -X PATCH localhost:3003/notifications/<id>/read -H "authorization: Bearer $TOKEN"

curl -i -X PATCH localhost:3003/notifications/read -H "authorization: Bearer $TOKEN"
```

### Admin DLQ endpoints

Emails that could not be sent are kept in the JetStream `DLQ` stream. These endpoints are for admins only: any other caller gets `403`. Each entry is identified by its sequence number in the stream (`seq`).

| Method | Path | Query | Success | Errors |
|---|---|---|---|---|
| `GET` | `/admin/dlq` | `page?`, `limit?` | `200` with `data`: entries `{ seq, deadLetteredAt, reason, attempts, code?, responseCode?, command?, event }` newest first, and `meta` | `400`, `401`, `403` |
| `GET` | `/admin/dlq/:seq` | — | `200` with `data`: one entry | `400`, `401`, `403`, `404` |
| `POST` | `/admin/dlq/:seq/replay` | — | `200` with `data: { seq, eventId }` and the message `Email sent` | `400`, `401`, `403`, `404`, `409`, `500`, `502` |

- `reason` is `exhausted` when every attempt failed and `rejected` when the SMTP server refused the email permanently. `code`, `responseCode` and `command` describe the last failure, for example `ESOCKET` when the server could not be reached. `event` is the original payment event, including the recipient's address.
- `page` and `limit` work as in `GET /notifications`. An unknown query parameter returns `400`.
- Replay sends the email now, inside the request. If it is sent, the entry is deleted. If the SMTP server still refuses it, the request returns `502 email-send-failed` with the error code in `detail`, and the entry stays for another try. Replaying an entry that is already being replayed returns `409 replay-in-progress`.
- Replay sends the email even though the event is already recorded as processed, so it is the only way a dead-lettered email is sent again.

```sh
ADMIN_TOKEN=$(curl -s -X POST localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"Admin123!"}' | jq -r .data.accessToken)

curl -i localhost:3003/admin/dlq -H "authorization: Bearer $ADMIN_TOKEN"

curl -i -X POST localhost:3003/admin/dlq/<seq>/replay -H "authorization: Bearer $ADMIN_TOKEN"
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
| 409 | `replay-in-progress` | A dead-lettered email is already being replayed |
| 413 | `payload-too-large` | The request body is too large |
| 415 | `unsupported-media-type` | The body's media type, charset or encoding is not supported |
| 429 | `too-many-requests` | Too many failed logins from this IP. The response carries `Retry-After` in seconds |
| 500 | `internal-error` | Anything unexpected |
| 502 | `email-send-failed` | Replaying a dead-lettered email failed because the SMTP server refused it; `detail` names the error code |

A `500` response never includes the error message, stack or request body. The real error is logged once, on the request's log line, with its `correlationId`.

```sh
curl -i localhost:3002/nope
```

## Testing

Run `pnpm test` from the repo root. To run one package, pass its path, for example `pnpm test -- services/auth`. Tests sit next to the code they cover as `*.test.ts`. API tests drive each service's `createApp` with supertest, using the in-memory storage adapter, so they need neither Docker nor a running server. `pnpm test:coverage` runs the same tests with a coverage report: a summary in the terminal and the full HTML report in `coverage/index.html`. Each service also has an `openapi.test.ts` that fails if an operation in its OpenAPI document lacks a description, examples, its error responses or its auth rules.

### Integration tests

The integration suite runs `auth`, `payment` and `notification` as real processes from source and drives them over HTTP, against their own NATS and Mailpit containers. It needs Docker, and it never touches the dev containers or their data, so it can run while `pnpm dev` is up.

```sh
pnpm infra:test:up      # NATS on 127.0.0.1:4223 (JetStream in memory) and Mailpit on 127.0.0.1:1026 / 8026
pnpm test:integration   # tests/integration/*.int.test.ts, one file at a time
pnpm infra:test:down    # stop and remove the test containers
```

It covers four flows: a payment settling and reaching its owner in-app and by email with one correlation ID throughout; temporary SMTP failures retried and then dead-lettered, and permanent rejections dead-lettered at once (switched on through Mailpit's chaos API); replaying a DLQ entry; and the same event delivered twice being handled once per channel. The services use ports `4101` to `4103`, in-memory storage, a gateway that always succeeds after 10 to 50 ms, and three email attempts 200 and 400 ms apart. `pnpm test` does not run this suite and needs no Docker. `pnpm infra:down` and `pnpm infra:reset` leave the test containers running; stop them with `pnpm infra:test:down`.

## Project docs

- [ROADMAP.md](ROADMAP.md): scope, decisions and status
- [tasks/](tasks/): task docs for individual roadmap items
