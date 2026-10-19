# Payment Processing Microservice — Roadmap

Source requirements: `~/Downloads/Node js assessment.xlsx` (Node.js Microservice – Payment Processing Simulation).

**Status legend:** `todo` · `in-progress` · `blocked` · `done` · `deferred` · `cancelled`

**Milestone IDs:** `BE-<phase>-<milestone>`, e.g. `BE-01-02` is phase 1, milestone 2. Task docs are named `tasks/<ID>-<slug>.md`.

## Decisions

| Area | Choice |
|---|---|
| Runtime / language / framework | Node.js 24 LTS, TypeScript 6.x (not 7: ts-jest does not support it), Express |
| Architecture | Three services — `auth`, `payment` and `notification` — plus a shared lib, in one monorepo (pnpm workspaces) |
| Lint / format | Biome via Ultracite |
| Package manager / task runner | pnpm, version pinned through the `packageManager` field. Root pnpm scripts only, including docker-compose commands. No Makefile, so `pnpm` is the single entry point on every OS |
| Auth | `auth` service owns users and issues JWT access tokens (claims: `sub`, `email`, `role`); other services verify tokens locally via shared-lib middleware (shared secret, no runtime calls). Roles: `user`, `admin`; register always creates `user`. Seeded on startup: one admin and one normal user. Token lifetime: 24h. Out of scope: refresh tokens, password reset, email verification, OAuth |
| Inter-service messaging | NATS JetStream (durable streams, durable consumers, ack/redelivery). Every event has a unique ID, published as `Nats-Msg-Id` for publish-side dedupe; consumers are idempotent |
| Async model | Background processing: POST returns `pending`; a simulated gateway resolves it after a random delay. The processor updates status in-process, not over HTTP |
| Money | Integer amounts in minor units (e.g. kobo, cents) plus ISO 4217 currency code; no floats |
| Persistence | Generic repository interface in the shared lib with in-memory and JSON-file adapters, selected by env var (each service owns its data). Updates are compare-and-set on a `version` field. No database or ORM |
| Notifications | In-app (stored, readable via API) and email (SMTP to Mailpit locally), each on its own durable consumer |
| Email failure handling | Retries with backoff (consumer `backoff` / `nak` delay, bounded by `max_deliver`). On the last attempt the handler publishes to a `DLQ` stream and terminates the message — JetStream has no built-in dead-letter stream |
| Validation | Zod schemas at the HTTP boundary, for event payloads and for env config |
| Logging | pino + pino-http (JSON logs, pino-pretty in dev) with per-request IDs propagated as correlation IDs in event headers; passwords, tokens and auth headers redacted |
| Observability | Structured logs and health/readiness endpoints are core. Prometheus metrics are stretch; no tracing, Prometheus server or Grafana |
| Testing | Jest + supertest (unit + API), plus cross-service integration tests against NATS (from the BE-01-03 compose stack) |
| API docs | OpenAPI spec generated from the Zod schemas (`@asteasolutions/zod-to-openapi`), served via Swagger UI at `/docs`, summarised in README. Each endpoint milestone registers its route |
| Caching | None. Data already lives in memory (the JSON-file adapter loads into memory too), and everything runs as one instance per service, so Redis would add infrastructure without speeding anything up |
| Scope | Core requirements + polish; stretch items in Phase 7. Auth, NATS and notifications go beyond the "for simplicity" requirements on purpose, to show service boundaries and failure handling; persistence stays simple |

## Phase 1 — Foundation

| ID | Milestone | Status | Task doc |
|---|---|---|---|
| BE-01-01 | Monorepo scaffold (pnpm workspaces, TS project refs, root `dev` script starting all services, Biome with `noConsole` as an error, `.env.example`) | done | [tasks/BE-01-01-monorepo-scaffold.md](tasks/BE-01-01-monorepo-scaffold.md) |
| BE-01-03 | Local infra via docker-compose (NATS JetStream, Mailpit), wrapped in root pnpm scripts (`infra:up`, `infra:down`, `infra:logs`, `infra:reset`) | done | [tasks/BE-01-03-local-infra.md](tasks/BE-01-03-local-infra.md) |
| BE-01-02 | Shared lib package (config loader, event contracts, NATS client wrapper) | done | [tasks/BE-01-02-shared-lib.md](tasks/BE-01-02-shared-lib.md) |
| BE-01-04 | Express app skeleton per service: liveness, readiness based on each service's real dependencies, graceful shutdown (drain NATS, stop timers) | done | [tasks/BE-01-04-service-skeleton.md](tasks/BE-01-04-service-skeleton.md) |
| BE-01-05 | Structured logging with redaction and request/correlation-ID middleware (shared lib) | done | [tasks/BE-01-05-structured-logging.md](tasks/BE-01-05-structured-logging.md) |
| BE-01-06 | Central error model and error-handling middleware (shared lib) | done | [tasks/BE-01-06-error-model.md](tasks/BE-01-06-error-model.md) |
| BE-01-07 | Generic repository interface (with compare-and-set updates) + in-memory adapter (shared lib) | done | [tasks/BE-01-07-repository-interface.md](tasks/BE-01-07-repository-interface.md) |
| BE-01-08 | JSON-file adapter with serialized, atomic writes (temp file + rename, single writer per file) (shared lib) | done | [tasks/BE-01-08-json-file-adapter.md](tasks/BE-01-08-json-file-adapter.md) |
| BE-01-09 | OpenAPI setup per service (spec generated from Zod schemas, Swagger UI at `/docs`) | done | [tasks/BE-01-09-openapi-setup.md](tasks/BE-01-09-openapi-setup.md) |
| BE-01-10 | Standard success response envelope (`status`, `success`, `data`, `message`, `meta` for pages) (shared lib) | done | [tasks/BE-01-10-response-envelope.md](tasks/BE-01-10-response-envelope.md) |

## Phase 2 — Users & Auth

| ID | Milestone | Status | Task doc |
|---|---|---|---|
| BE-02-01 | Auth service scaffold with user model, repository and seeded admin + user accounts | done | [tasks/BE-02-01-auth-users-seed.md](tasks/BE-02-01-auth-users-seed.md) |
| BE-02-02 | `POST /auth/register` and `POST /auth/login` (bcrypt, JWT with `sub`/`email`/`role` claims) | done | [tasks/BE-02-02-auth-register-login.md](tasks/BE-02-02-auth-register-login.md) |
| BE-02-03 | Shared-lib auth middleware (JWT verification, role guard) | done | [tasks/BE-02-03-auth-middleware.md](tasks/BE-02-03-auth-middleware.md) |
| BE-02-04 | HTTP hardening (helmet, CORS, rate limit on login) | in-progress | [tasks/BE-02-04-http-hardening.md](tasks/BE-02-04-http-hardening.md) |

## Phase 3 — Payments

| ID | Milestone | Status | Task doc |
|---|---|---|---|
| BE-03-01 | Payment model (owner `userId` + email, minor-unit amount + currency, `version`) and status state machine (allowed transitions) | done | [tasks/BE-03-01-payment-model.md](tasks/BE-03-01-payment-model.md) |
| BE-03-02 | `POST /payments` — create payment with validation | done | [tasks/BE-03-02-create-payment.md](tasks/BE-03-02-create-payment.md) |
| BE-03-07 | Idempotency keys on payment creation | done | [tasks/BE-03-07-idempotency-keys.md](tasks/BE-03-07-idempotency-keys.md) |
| BE-03-03 | `GET /payments/:id` — retrieve payment | done | [tasks/BE-03-03-get-payment.md](tasks/BE-03-03-get-payment.md) |
| BE-03-04 | `PATCH /payments/:id/status` — update status, enforcing transitions atomically | done | [tasks/BE-03-04-update-payment-status.md](tasks/BE-03-04-update-payment-status.md) |
| BE-03-06 | Payment status PATCH is admin-only (read ownership shipped in BE-03-03) | done | [tasks/BE-03-04-update-payment-status.md](tasks/BE-03-04-update-payment-status.md) |
| BE-03-05 | Simulated gateway and background processor (delay, random failure, timeouts, resumes in-flight payments after restart) | done | [tasks/BE-03-05-payment-processor.md](tasks/BE-03-05-payment-processor.md) |

## Phase 4 — Messaging (NATS)

| ID | Milestone | Status | Task doc |
|---|---|---|---|
| BE-04-01 | JetStream streams, subjects and event catalogue (one subject per status change, e.g. `payment.created`, `payment.succeeded`; final list follows BE-03-01) | done | [tasks/BE-04-01-event-catalogue.md](tasks/BE-04-01-event-catalogue.md) |
| BE-04-02 | Payment service publishes lifecycle events (event ID, `userId` + email) through an outbox stored with the payment, republished on startup | done | [tasks/BE-04-02-payment-event-outbox.md](tasks/BE-04-02-payment-event-outbox.md) |

## Phase 5 — Notification Service

| ID | Milestone | Status | Task doc |
|---|---|---|---|
| BE-05-01 | Notification service scaffold with separate durable consumers for in-app and email | done | [tasks/BE-05-01-notification-consumers.md](tasks/BE-05-01-notification-consumers.md) |
| BE-05-02 | Idempotent event handling, deduped per channel (`eventId` + channel) | done | [tasks/BE-05-02-idempotent-event-handling.md](tasks/BE-05-02-idempotent-event-handling.md) |
| BE-05-03 | In-app notifications: store, `GET /notifications` (own notifications only), mark as read | done | [tasks/BE-05-03-inapp-notifications.md](tasks/BE-05-03-inapp-notifications.md) |
| BE-05-04 | Email channel via SMTP (templates per payment event) | todo | — |
| BE-05-05 | Email retries with backoff (bounded redelivery, short delays configurable for tests) | todo | — |
| BE-05-06 | Dead-letter stream for exhausted emails, with inspect and replay (admin only) | todo | — |
| BE-05-07 | ~~Ownership and role checks~~ — split into BE-03-06 and BE-05-03 | cancelled | — |

## Phase 6 — Quality & Deliverables

| ID | Milestone | Status | Task doc |
|---|---|---|---|
| BE-06-01 | Unit test suite completed: gaps closed across state machine, services, repositories, processor and notification handlers, plus a coverage report | todo | — |
| BE-06-02 | API test suite completed with supertest (happy paths + error responses for every endpoint) | todo | — |
| BE-06-03 | Cross-service integration tests (event flow, retries, DLQ, duplicate delivery) | todo | — |
| BE-06-04 | OpenAPI spec reviewed for completeness across all services (examples, error responses, auth) | todo | — |
| BE-06-05 | README finalised (setup, run locally, demo accounts, API reference, testing approach, design notes) | todo | — |
| BE-06-06 | Architecture docs (service diagram, event catalogue, failure handling) | todo | — |
| BE-06-07 | Git repository published with run-locally instructions verified from a clean clone | todo | — |

## Phase 7 — Stretch

| ID | Milestone | Status | Task doc |
|---|---|---|---|
| BE-07-01 | ~~Idempotency keys on payment creation~~ — moved to BE-03-07 | cancelled | — |
| BE-07-02 | `GET /payments` list with pagination and status filter | todo | — |
| BE-07-03 | Dockerfiles for all services + full-stack docker-compose | todo | — |
| BE-07-04 | GitHub Actions CI (lint, typecheck, test, with NATS service container) | todo | — |
| BE-07-05 | Prometheus `/metrics` per service via prom-client (payments by status, email retries, DLQ size) | todo | — |

## Requirements coverage

| Requirement | Milestones |
|---|---|
| Microservice architecture | BE-01-01, BE-01-02, BE-02-01, BE-04-01, BE-04-02, BE-05-01 |
| Express server with create / get / update-status endpoints | BE-01-04, BE-03-02 – BE-03-04 |
| Simulated async payment processing | BE-03-05, BE-04-02 |
| In-memory or JSON-file persistence | BE-01-07, BE-01-08 |
| Proper error responses | BE-01-06, BE-03-02 – BE-03-04, BE-06-02 |
| Error handling and logging emphasis | BE-01-05, BE-01-06, BE-05-02, BE-05-05, BE-05-06 |
| Unit tests | Every milestone ships its own tests; BE-06-01, BE-06-02 close gaps |
| Test scripts demonstrating the testing approach (Jest) | BE-01-01, BE-06-01 – BE-06-03, BE-06-05 |
| Swagger or Markdown API docs | BE-01-09, BE-01-10, BE-06-04, BE-06-05 |
| Git repo + README with setup, API, testing instructions | BE-06-05, BE-06-07 |
| Clear instructions to run locally | BE-01-01, BE-06-05, BE-06-07 |
| Users and ownership (added) | BE-02-01 – BE-02-04, BE-03-03, BE-03-06, BE-05-03 |
