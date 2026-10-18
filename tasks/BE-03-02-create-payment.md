# BE-03-02: Create payment

**Covers:** BE-03-02
**Status:** done

## Objective

A logged-in user can call `POST /payments` with an amount, currency and optional description. The payment service validates the body, stores a `pending` payment owned by the caller, and returns it with `201`. This is also the point where the payment service starts storing data: its config, readiness and shutdown gain the payments repository. The endpoint is registered in the payment OpenAPI spec and ships with unit and supertest tests. Nothing else happens to the payment yet: no event, no processing.

## Source Context

Roadmap milestone BE-03-02 in `ROADMAP.md` ("`POST /payments` — create payment with validation"). Scope was agreed during task-doc intake on 2026-10-18. The user asked to keep it as simple as possible and approved this scope, including two defaults:
- **Who can create:** any authenticated user, admins included. A payment is owned by its creator.
- **Response:** the stored payment without `version`.

## Design Reference

- `ROADMAP.md`, Decisions table: Async model ("POST returns `pending`"); Money (integer minor units plus ISO 4217 code); Persistence (repository selected by `STORAGE_DRIVER`, each service owns its data); API docs (each endpoint milestone registers its route).
- `AGENTS.md`: validate HTTP input with Zod at the boundary; errors only through the central error model; payment events carry `userId` and email (so both are stored now); register every endpoint and its error responses in OpenAPI in the same change; update the README when env vars or endpoints change; never log tokens, auth headers or emails.
- `tasks/BE-03-01-payment-model.md`, Follow-ups: "BE-03-02: open the repository with `openRepository({ name: "payments", schema: paymentSchema, ... })`, wire its check and close; derive the request schema from `paymentFieldsSchema` (amount, currency, description) and set `userId`/`email` from `getAuth(req)`."
- `tasks/BE-02-03-auth-middleware.md`, Follow-ups: pass `config.JWT_SECRET` into `createApp`, mount `authenticate(secret)` on protected routers, read the caller with `getAuth(req)`, register routes with `security: bearerSecurity` and `problemResponses(401, ...)`.

## Architecture Summary

```
services/payment/src/
  config/config.ts          + storageConfigSchema.shape
  main.ts                   connectNats → openRepository("payments") → createApp({ checks: [natsCheck, check], jwtSecret, payments, ... })
                            onShutdown tasks: [drainNats, close]
  app.ts                    + paymentRouter(controller, jwtSecret)
  openapi.ts                + registerPaymentPaths(registry)
  payment/
    payment.schema.ts       createPaymentBodySchema, paymentResponseSchema (+ OpenAPI ids)
    payment.service.ts      createPaymentService(repository, { now? }).create({ owner, body })
    payment.controller.ts   create: parse body, getAuth(req), service.create, 201
    payment.routes.ts       POST /payments → authenticate(secret) → express.json({ limit: "16kb" }) → controller.create
    payment.openapi.ts      registerPaymentPaths
    index.ts                + new exports
```

Request and response:

```
POST /payments
Authorization: Bearer <token>
{ "amount": 150000, "currency": "NGN", "description": "Order #42" }

201
{ "id", "userId", "email", "amount", "currency", "status": "pending",
  "description"?, "createdAt", "updatedAt" }        // no version, no failureReason on create
```

## Code Evidence

| Behavior | Source |
|---|---|
| Payment `main.ts` connects NATS, builds `createApp({ checks: [natsCheck(nc)], docs, logger })` and registers `onShutdown` with `[() => drainNats(nc)]`; no storage | `services/payment/src/main.ts` |
| Payment `createApp({ checks, docs, logger })` mounts logger, security headers, CORS, health, docs, 404 and error handlers only | `services/payment/src/app.ts` |
| Payment config extends `baseConfigSchema` with `jwtConfigSchema` and `PAYMENT_PORT`, then resolves `JWT_SECRET` in a `.transform` | `services/payment/src/config/config.ts` |
| Auth config adds storage with `.extend(storageConfigSchema.shape)`; `STORAGE_DRIVER` and `DATA_DIR` are already in `.env.example` | `services/auth/src/config/config.ts`, `.env.example` |
| `openRepository({ config, logger, name, schema })` returns `{ repository, check, close }` | `libs/shared/src/storage.ts` |
| Auth wiring to copy: `openRepository` before `listen`, `checks: [check]`, `onShutdown({ tasks: [close] })`, inside the existing `try`/`startup failed` block | `services/auth/src/main.ts` |
| Auth module layout: `auth.routes.ts` (router factory taking the controller), `auth.controller.ts` (parses with Zod, `res.status(201).json(...)`), `auth.service.ts`, `auth.schema.ts` (schemas with `.meta({ id })`), `auth.openapi.ts` (`registerAuthPaths`), and `app.ts` mounting `express.json({ limit: "16kb" })` on its path prefix | `services/auth/src/auth/`, `services/auth/src/app.ts` |
| `authenticate(secret)` throws `401` (missing or invalid token) and binds `userId`/`role` to the request log; `getAuth(req)` returns `{ sub, email, role }` | `libs/shared/src/auth-middleware.ts` |
| `bearerSecurity` and `problemResponses(...statuses)` exist for OpenAPI registration | `libs/shared/src/openapi.ts` |
| The error model maps body-parser failures to `413 payload-too-large`, `415 unsupported-media-type` and `400 malformed-json`, and Zod errors to `400 validation-error` | `libs/shared/src/errors.ts` |
| `paymentFieldsSchema` is unrefined, so `.pick()`/`.omit()` work; `paymentSchema` is the refined record schema; `Repository.insert` takes the record without `version` and returns it with `version: 1` | `services/payment/src/payment/payment.ts`, `libs/shared/src/repository.ts` |
| Auth route tests build the app with `createMemoryRepository` and a 32-char `jwtSecret`; tests sign their own tokens with `jose` (shared middleware tests) | `services/auth/src/auth/auth.routes.test.ts`, `libs/shared/src/auth-middleware.test.ts` |
| README says "Only `auth` stores data so far" and has an "Auth endpoints" table to mirror | `README.md`, Storage and demo accounts; API |

## Scope

- **Storage wiring:** payment config extends `storageConfigSchema.shape`. `main.ts` connects NATS, then opens the `payments` repository with `paymentSchema` before `listen` (opening storage last means a NATS failure cannot leave its lock file behind), passes `[natsCheck(nc), check]` as readiness checks, and registers shutdown tasks `[() => drainNats(nc), close]`. A bad or locked data file stops startup through the existing `startup failed` path.
- **`createApp`** gains `jwtSecret: string` and `payments: Repository<Payment>`. It mounts `paymentRouter(...)` before the 404 handler. `authenticate(jwtSecret)` runs before the JSON body parser for `/payments`, so an unauthenticated request gets `401` without its body being parsed.
- **Schemas** in `payment/payment.schema.ts`:
  - `createPaymentBodySchema`: `paymentFieldsSchema.pick({ amount, currency, description })` as a strict object, so unknown fields (`status`, `userId`, `email`, `id`) are rejected with `400`. OpenAPI id `CreatePaymentRequest`.
  - `paymentResponseSchema`: `paymentFieldsSchema.omit({ version })`. OpenAPI id `Payment`.
- **Service** `createPaymentService(payments)` with an optional `now` factory option and `create({ owner: { userId, email }, body })`: inserts `{ id: randomUUID(), userId, email, amount, currency, description?, status: "pending", createdAt, updatedAt }` with `createdAt === updatedAt`, and returns the stored payment. It strips `version` for the response (or the controller does; one place only).
- **Controller** reads `getAuth(req)` (`sub` → `userId`, `email`), parses the body with `createPaymentBodySchema`, calls the service, logs `"payment created"` with the payment `id` (never the email), and responds `201` with the response shape.
- **OpenAPI** `registerPaymentPaths` registers `POST /payments`: tag `payments`, `security: bearerSecurity`, required JSON body, `201` with `Payment`, and `problemResponses(400, 401, 413, 415)`. `openapi.ts` calls it.
- **Tests**, next to each file:
  - Service: stores a `pending` payment with the owner, a uuid id, matching timestamps from the injected `now`, `version: 1` in the repository; omits `description` when not given.
  - Config: storage defaults (`file`, `data`) and `STORAGE_DRIVER=memory` parse; an invalid driver is rejected.
  - Routes (supertest, memory repository, tokens signed with `jose`): `201` with the payment and no `version`, owner taken from the token, stored record present in the repository; `401` without a token and with a bad token (body not required); `400 validation-error` for a float, zero or negative amount, an unknown or lowercase currency, a 141-character description, a missing field, and an extra field such as `status` or `userId`; `400 malformed-json`; `413` over 16 kB; `400 validation-error` for a non-JSON content type (the JSON parser skips it, as in auth); `415` for an unsupported charset such as `application/json; charset=latin1`. A `user` and an `admin` token both create.
  - App or OpenAPI: the generated spec contains `POST /payments` with bearer security and responses `201`, `400`, `401`, `413`, `415`.
- **README:** add a "Payment endpoints" section after "Auth endpoints" (table row, notes: amount in minor units, allowed currencies, owner from token, new payments start `pending`, body rules; one `curl` example using a token from login). Change "Only `auth` stores data so far" to cover payment, and mention `services/payment/data/payments.json`.
- **Roadmap:** BE-03-02 row status and link to this doc.

## Preserve

- Health, readiness (NATS still checked), docs and shutdown behavior of the payment service. `PAYMENT_PORT` and `JWT_SECRET` handling unchanged.
- `libs/shared` unchanged. The BE-03-01 model and state machine unchanged.
- Auth and notification services unchanged.
- Every existing test.

## Excluded

- Publishing `payment.created` or any event, and the outbox (BE-04-01, BE-04-02).
- Idempotency keys (BE-03-07).
- Starting processing or any status change after create (BE-03-04, BE-03-05).
- `GET /payments/:id` and any list endpoint (BE-03-03, BE-07-02).
- Ownership checks beyond setting the owner from the token, and role restrictions (BE-03-06).
- Trimming or normalising `description`, amount caps beyond `amountSchema`, rate limiting.

## Likely Files To Touch

- `services/payment/src/config/config.ts`, `config.test.ts`
- `services/payment/src/main.ts`, `app.ts`, `app.test.ts`, `openapi.ts`
- `services/payment/src/payment/` (new: `payment.schema.ts`, `payment.service.ts`, `payment.service.test.ts`, `payment.controller.ts`, `payment.routes.ts`, `payment.routes.test.ts`, `payment.openapi.ts`; update `index.ts`)
- `services/payment/package.json`, `pnpm-lock.yaml`: route tests sign tokens with `jose`, which `libs/shared` does not export a signer for and payment does not depend on yet. Add it as a dev dependency with `pnpm --filter @payment-be/payment add -D -E jose@6.2.12` (the version `libs/shared` uses). This is the only allowed dependency change.
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None.

Settled during intake on 2026-10-18: any authenticated role can create; the response omits `version`; the route layout mirrors the auth module; storage wiring lands here (deferred from BE-03-01).

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons.
- Never log the token, `Authorization` header or email. Log the payment by `id`.
- Errors only through the central error model; no hand-built error responses.
- No new runtime dependencies; the only new dev dependency is `jose` (see Likely Files To Touch). Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or `libs/shared`. If one turns out to be needed, stop and record why in this doc first.
- Set the BE-03-02 roadmap row to `in-progress` and link this doc when starting.

## Deliverables

- `POST /payments` behind authentication, storing `pending` payments in the payment service's own repository.
- Payment service storage wired into config, readiness and shutdown.
- OpenAPI registration, unit and supertest tests.
- `README.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual run (`pnpm infra:up && pnpm dev`): log in as the seeded user on auth, `POST /payments` on port 3002 with the token returns `201` with `status: "pending"` and no `version`; the payment is in `services/payment/data/payments.json`; restart the payment service and the file still loads; `/health/ready` reports both `nats` and `storage`; `POST /payments` without a token returns `401`.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc (the ignored `services/payment/data/` excluded).

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-03-02 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-03-03: reuse `paymentResponseSchema` and the service's version-stripping for `GET /payments/:id`.
- BE-03-06: restrict `GET` to the owner (admins see all).
- BE-03-07: add the idempotency key to the create body or header and the service.
- BE-04-02: publish `payment.created` from the service's `create`, with the outbox stored on the payment.
- BE-03-05: pick up `pending` payments created here.
