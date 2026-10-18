# BE-03-07: Idempotency keys on payment creation

**Covers:** BE-03-07
**Status:** done

## Objective

A client can send an optional `Idempotency-Key` header with `POST /payments`. When it retries with the same key and the same body (after a timeout, for example), it gets back the payment it already created instead of a second one. If it reuses a key with a different body, it gets an error. Keys are scoped to the caller and stored on the payment, so they survive restarts. Requests without the header behave exactly as they do now.

## Source Context

Roadmap milestone BE-03-07 in `ROADMAP.md` ("Idempotency keys on payment creation", moved from the stretch item BE-07-01). Scope was agreed during task-doc intake on 2026-10-18. The user approved the proposed scope and both recommended defaults:
- **The key is optional.** Without it, creation is unchanged.
- **A replay returns `200`**, not the original `201`, so the client can tell no new payment was created without needing an extra header.

## Design Reference

- IETF draft "The Idempotency-Key HTTP Header Field" (`draft-ietf-httpapi-idempotency-key-header`): the header name, `422` for a key reused with a different payload, and `409` for a request with the same key that is still in progress (not needed here, see Scope).
- `ROADMAP.md`, Decisions table: Persistence (repository per service, no unique indexes, compare-and-set updates); Money (integer minor units).
- `AGENTS.md`: validate HTTP input with Zod at the boundary; errors only through the central error model; register every endpoint change and its error responses in OpenAPI; update the README when endpoints change.
- `tasks/BE-03-02-create-payment.md`, Follow-ups: "BE-03-07: add the idempotency key to the create body or header and the service."

## Architecture Summary

```
POST /payments
Authorization: Bearer <token>
Idempotency-Key: 7c1f...            (optional, 1–255 printable ASCII characters)
{ "amount": 150000, "currency": "NGN", "description": "Order #42" }

no key                          → 201, new payment (unchanged)
key not seen for this user      → 201, new payment stored with idempotencyKey
key seen, same body             → 200, the stored payment in its current state (no insert)
key seen, different body        → 422 idempotency-key-reused
invalid key                     → 400 validation-error
```

```
services/payment/src/payment/
  payment.ts              paymentFieldsSchema + idempotencyKey (optional)
  payment.schema.ts       idempotencyKeySchema (header value); paymentResponseSchema omits idempotencyKey too
  payment.service.ts      create({ body, owner, idempotencyKey? }) → { payment, replayed }
                          creates run one at a time; lookup by { userId, idempotencyKey }
  payment.controller.ts   reads req.get("idempotency-key"), parses it, 201 or 200
  payment.openapi.ts      header parameter, 200 response, 422 problem
```

## Code Evidence

| Behavior | Source |
|---|---|
| `create` inserts a new payment with `randomUUID()` on every call and returns `toPaymentResponse(payment)`; there is no dedupe | `services/payment/src/payment/payment.service.ts` |
| `toPaymentResponse` strips only `version` | `services/payment/src/payment/payment.service.ts` |
| `paymentFieldsSchema` has no key field. `paymentSchema` (refined) validates stored records on JSON-file load: `main.ts` passes it to `openRepository`, and `loadRecords` parses every record with it | `services/payment/src/payment/payment.ts`, `services/payment/src/main.ts`, `libs/shared/src/file-repository.ts` (`loadRecords`) |
| `createPaymentBodySchema` is a strict object of `amount`, `currency`, `description`; `paymentResponseSchema` is `paymentFieldsSchema.omit({ version })` with OpenAPI id `Payment` | `services/payment/src/payment/payment.schema.ts` |
| The controller parses the body, reads `getAuth(req)`, logs `"payment created"` with `paymentId`, and responds `201` | `services/payment/src/payment/payment.controller.ts` |
| The repository has no unique index. Auth makes creates run one at a time with a promise queue and does check-then-insert, so concurrent registrations for one email cannot both pass | `services/auth/src/user/user.service.ts` (`createUserService`) |
| `findOneBy(where)` skips `undefined` values in `where` (`matchesWhere`), so a lookup with an undefined key would match any payment of the user | `libs/shared/src/repository.ts` |
| `conflict`, `unprocessable` and the other factories build `AppError`s; passing `{ code }` gives a typed problem (`type` ends with the code) | `libs/shared/src/errors.ts` |
| Zod errors become `400 validation-error` with a JSON pointer built from the issue path | `libs/shared/src/errors.ts` (`validationProblem`) |
| `corsPolicy()` sets only `exposedHeaders`; `cors` reflects `Access-Control-Request-Headers` when `allowedHeaders` is unset, so browsers can send `Idempotency-Key` without a shared-lib change | `libs/shared/src/security.ts` |
| `problemResponses(...statuses)` registers problem responses; `POST /payments` currently registers `201` and `400, 401, 413, 415` | `libs/shared/src/openapi.ts`, `services/payment/src/payment/payment.openapi.ts` |
| `registerPath`'s `request.headers` (zod-to-openapi 9.1.0) accepts a `z.object`; each key becomes an `in: header` parameter with that exact name, and an `.optional()` value gives `required: false` | `@asteasolutions/zod-to-openapi` `dist/openapi-registry.d.ts` |
| An existing test asserts the exact `POST /payments` response list (`201`, `400`, `401`, `413`, `415`) | `services/payment/src/app.test.ts` ("documents POST /payments with bearer auth and its errors") |
| Existing service tests use the value returned by `create` as the payment | `services/payment/src/payment/payment.service.test.ts` |
| The request log written by pino-http includes `req.headers`; only `authorization`, `cookie`, `set-cookie` and the keys `password`, `token`, `accessToken`, `email` are redacted. `req.log` is pino-http's full request logger (no `quietReqLogger`), so it binds `req` too, and an `idempotency-key` header appears in the request-completed line and in every `req.log` line for that request, including `"payment created"` | `libs/shared/src/logger.ts` (`REDACT_PATHS`, `httpLogger`) |
| README "Payment endpoints" has the `POST /payments` row, body notes and a `curl` example | `README.md` |

## Scope

- **Model:** add `idempotencyKey` to `paymentFieldsSchema` as an optional field using the same rule as the header (below). Existing stored payments without it still load.
- **Header schema:** `idempotencyKeySchema` in `payment.schema.ts`: a string of 1 to 255 printable ASCII characters (`0x21`–`0x7E`). An absent header means no key. A present but invalid header (empty, too long, spaces or other characters) is rejected with `400 validation-error`, with a pointer that names the header (for example, parse `{ "idempotency-key": value }` so the pointer is `/idempotency-key`).
- **Response:** `toPaymentResponse` strips `idempotencyKey` as well as `version`, and `paymentResponseSchema` omits it, so the `Payment` schema and response body stay the same.
- **Service:** `create({ body, owner, idempotencyKey? })` returns `{ payment, replayed }`.
  - Without a key: insert as today and return `replayed: false`.
  - With a key: look up the caller's payment with `findOneBy({ userId: owner.userId, idempotencyKey })`. Only look up when a key is present, because `findOneBy` ignores undefined values.
    - Not found: insert with the key and return `replayed: false`.
    - Found and `amount`, `currency` and `description` all match the body (`description` absent on both counts as a match): return the stored payment with `replayed: true`. Nothing is inserted or updated.
    - Found but any of the three differs: throw `unprocessable(..., { code: "idempotency-key-reused" })` with a detail saying the key was already used with a different request.
  - Creates run one at a time through a promise queue, like `createUserService`, so two concurrent requests with the same key produce one payment and the second gets the replay. A failed create must not block the queue.
  - The key is scoped to the user: the same key from another user creates that user's own payment.
- **Controller:** reads the header, parses the body and then the key, calls the service, responds `201` for a new payment and `200` for a replay. It logs `"payment created"` for a new payment and `"payment create replayed"` for a replay, both with `paymentId`. Never log the email, and do not add the key to these log lines. The key still appears under `req.headers` in pino-http's request log and in every `req.log` line, which binds `req` (see Code Evidence), because redacting it would need a `libs/shared` change; it is not a credential, so that is accepted.
- **OpenAPI:** `POST /payments` gains an optional `Idempotency-Key` header parameter (with a description of the scoping and replay rules), registered as `request.headers: z.object({ "Idempotency-Key": idempotencyKeySchema.optional() })` so the parameter is named `Idempotency-Key` (the lowercase key used for parsing would name it `idempotency-key`), a `200` response with `Payment` ("Replayed: payment already created with this key"), and `422` in `problemResponses(400, 401, 413, 415, 422)`. Update the description to mention the header.
- **Tests**, next to each file:
  - Model: a payment with and without `idempotencyKey` parses; an invalid key is rejected.
  - Service (memory repository): update the existing tests to read `payment` from the `{ payment, replayed }` result. Without a key, two creates make two payments; the same key and body return the first payment with `replayed: true` and leave one record; the same key with a different amount, currency or description (including adding or dropping `description`) throws `idempotency-key-reused`; the same key from two users makes two payments; concurrent creates with one key (`Promise.all`) make one record; a replay returns the stored state even after the record was updated (for example, a status change made through `repository.update`); the response has no `idempotencyKey` or `version`.
  - Routes (supertest): `201` then `200` with the same `id` for a repeated request; `422` with type ending `idempotency-key-reused` for a changed body; `400 validation-error` with pointer `/idempotency-key` for an empty key, a 256-character key and a key with a space in the middle (Node trims leading and trailing spaces from header values, so `"a b"`, not `"ab "`); a 255-character key is accepted; two users with the same key get different payments; a request without the header still returns `201` each time; a body containing `idempotencyKey` is still rejected with `400`; the response body never contains `idempotencyKey`.
  - OpenAPI (`app.test.ts`): update the existing response-list assertion to `200`, `201`, `400`, `401`, `413`, `415`, `422`, and assert the operation has an `in: "header"` parameter named `Idempotency-Key` with `required: false`.
- **README:** in "Payment endpoints", add `200` to the success column and `422` to the errors column of the `POST /payments` row; add a note on `Idempotency-Key` (optional, per user, same body replays with `200` and the current payment, different body returns `422`, keys never expire); add the header to the `curl` example.
- **Roadmap:** set the BE-03-07 row to `in-progress` with a link to this doc when starting, `done` when finished.

## Preserve

- `POST /payments` without the header: same status, body and validation as BE-03-02.
- Request body schema (`CreatePaymentRequest`) and response schema (`Payment`) shapes. The key is a header only: `createPaymentBodySchema` picks its three fields, so it stays strict and rejects an `idempotencyKey` body field.
- Authentication before body parsing, the 16 kB limit, and the content-type handling.
- `libs/shared` unchanged, including CORS. The state machine (`payment.status.ts`) unchanged.
- Auth and notification services unchanged. Every existing test, except the two updates named under Tests (service tests reading the new return shape, and the OpenAPI response list in `app.test.ts`).

## Excluded

- Making the key required.
- Key expiry or cleanup: a key lasts as long as its payment.
- An `Idempotent-Replayed` response header (it would need a CORS `exposedHeaders` change in `libs/shared`).
- Storing or replaying error responses; only successful creates are remembered.
- Idempotency on any other endpoint.
- Publishing events (BE-04-02). A replay creates no record, so BE-04-02 will not publish a second `payment.created`.

## Likely Files To Touch

- `services/payment/src/payment/payment.ts`, `payment.test.ts`
- `services/payment/src/payment/payment.schema.ts`
- `services/payment/src/payment/payment.service.ts`, `payment.service.test.ts`
- `services/payment/src/payment/payment.controller.ts`
- `services/payment/src/payment/payment.openapi.ts`
- `services/payment/src/payment/payment.routes.test.ts`
- `services/payment/src/payment/index.ts` (if new exports are added)
- `services/payment/src/app.test.ts` (OpenAPI assertions)
- `README.md`, `ROADMAP.md`

## Prerequisites

BE-03-02 (`POST /payments` and payment storage) is committed on `feat/BE-03-02-create-payment` but not yet merged to `main`. Branch from it, or from `main` after it merges.

## Decisions Required Before Implementation

None. Settled during intake on 2026-10-18: header rather than body field, optional key, per-user scope, key stored on the payment with no expiry, comparison of the stored fields instead of a request hash, `200` for a replay, `422 idempotency-key-reused` for a mismatch, and creates run one at a time instead of returning `409` for requests in progress.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons (the serialized create queue warrants one, as in auth).
- Never log the token, `Authorization` header or email. Do not add the idempotency key to application log lines (it remains in the request log's headers, see Controller).
- Errors only through the central error model.
- No dependency changes. Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or `libs/shared`. If one turns out to be needed, stop and record why in this doc first.

## Deliverables

- Optional `Idempotency-Key` on `POST /payments` with replay, mismatch and per-user behavior as specified.
- Key stored on the payment and hidden from responses.
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
- Manual run (`pnpm infra:up && pnpm dev`): log in as the seeded user, send `POST /payments` twice with the same `Idempotency-Key` and body. The first returns `201`, the second `200` with the same `id`, and `services/payment/data/payments.json` holds one payment with that key. The same key with a different amount returns `422`. Restart the payment service and the replay still returns `200`.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-03-07 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-03-03: `GET /payments/:id` reuses `toPaymentResponse`, which now hides `idempotencyKey` too.
- BE-04-02: publish `payment.created` only for new payments, never on a replay.
