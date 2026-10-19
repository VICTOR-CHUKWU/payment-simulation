# BE-03-03: Retrieve a payment by ID

**Covers:** BE-03-03
**Status:** done

## Objective

A signed-in caller can fetch one payment with `GET /payments/:id` and gets back the same `Payment` shape that `POST /payments` returns. A user can only read their own payments, and an admin can read any. To any other caller, someone else's payment looks the same as one that does not exist.

## Source Context

Roadmap milestone BE-03-03 in `ROADMAP.md` ("`GET /payments/:id` — retrieve payment"). Scope was agreed during task-doc intake on 2026-10-19. The user approved:
- **Read ownership is enforced here**, not deferred to BE-03-06. A `user` sees only payments whose `userId` is their token's `sub`. An `admin` sees any payment.
- **Someone else's payment returns `404 payment-not-found`**, the same response as an unknown ID, so the endpoint never reveals whether an ID exists.
- **BE-03-06 shrinks** to "status PATCH is admin-only". Its roadmap title is updated in this change.

Defaults accepted with the inventory: a malformed ID returns `400 validation-error`, and there is no caching or ETag.

## Design Reference

- `ROADMAP.md`, Decisions table: Auth (roles `user` and `admin`, claims `sub`, `email`, `role`, tokens verified locally); Persistence (repository per service).
- `AGENTS.md`: validate HTTP input with Zod at the boundary; return errors only through the central error model; register every endpoint and its error responses in OpenAPI; update the README when endpoints change.
- `tasks/BE-03-02-create-payment.md` and `tasks/BE-03-07-idempotency-keys.md`, Follow-ups: BE-03-03 reuses `paymentResponseSchema` and `toPaymentResponse`.

## Architecture Summary

```
GET /payments/:id
Authorization: Bearer <token>

no / invalid token                         → 401 unauthorized
:id not a UUID                             → 400 validation-error (pointer /id)
no payment with that id                    → 404 payment-not-found
payment owned by someone else, role user   → 404 payment-not-found
payment owned by caller                    → 200 Payment
any payment, role admin                    → 200 Payment
```

```
services/payment/src/payment/
  payment.schema.ts       paymentIdParamsSchema: z.object({ id: z.uuid() })
  payment.service.ts      get(id, caller: { userId, role }) → PaymentResponse, or throws notFound
  payment.controller.ts   get: parse params, getAuth(req), 200 with the payment
  payment.routes.ts       GET /payments/:id behind authenticate(jwtSecret)
  payment.openapi.ts      200 Payment, problems 400, 401, 404
```

## Code Evidence

| Behavior | Source |
|---|---|
| The router has only `POST /payments`, mounted with `authenticate(jwtSecret)` and then `express.json` | `services/payment/src/payment/payment.routes.ts` |
| `toPaymentResponse` strips `version` and `idempotencyKey`. `PaymentService` has only `create` | `services/payment/src/payment/payment.service.ts` |
| `paymentResponseSchema` is registered under the OpenAPI ID `Payment` | `services/payment/src/payment/payment.schema.ts` |
| Payment `id` and `userId` are `z.uuid()` | `services/payment/src/payment/payment.ts` |
| `Repository.get(id)` returns the record or `undefined` | `libs/shared/src/repository.ts` |
| `getAuth(req)` returns the verified claims `{ sub, email, role }`. `role` is `"user" \| "admin"` (`roleSchema`) | `libs/shared/src/auth-middleware.ts`, `libs/shared/src/auth.ts` |
| `notFound(detail, { code })` builds a typed `404` problem. Zod errors become `400 validation-error` with a JSON pointer | `libs/shared/src/errors.ts` |
| `problemResponses(...statuses)` and `bearerSecurity` register problem responses and bearer auth | `libs/shared/src/openapi.ts` |
| `app.test.ts` checks the generated OpenAPI document for `POST /payments` | `services/payment/src/app.test.ts` |
| Request logging is trimmed: the completion line carries only method, URL, status and response time, and `req.log` binds only `correlationId` plus the user | `libs/shared/src/logger.ts` |
| README "Payment endpoints" has a table row and a `curl` example for `POST /payments` | `README.md` |

## Scope

- **Params schema:** `paymentIdParamsSchema = z.object({ id: z.uuid() })` in `payment.schema.ts`. Parsing `req.params` with it gives the pointer `/id` on failure.
- **Service:** `get(id, caller)`, where `caller` is `{ userId: string; role: Role }`.
  - Load the payment with `payments.get(id)`.
  - If it is missing, or `caller.role` is not `admin` and `payment.userId !== caller.userId`, throw `notFound("Payment not found.", { code: "payment-not-found" })`. Use the same detail in both cases.
  - Otherwise return `toPaymentResponse(payment)`.
  - Reads do not go through the create queue.
- **Controller:** `get` parses `req.params`, reads `getAuth(req)`, calls `service.get(id, { role, userId: sub })` and responds `200`. It writes no log line of its own: the request-completed line already carries the URL, status and user.
- **Route:** `router.get("/payments/:id", authenticate(jwtSecret), controller.get)`. No body parser.
- **OpenAPI:** register `GET /payments/{id}` with `request.params: paymentIdParamsSchema`, `200` with `paymentResponseSchema`, `problemResponses(400, 401, 404)`, `security: bearerSecurity`, the `payments` tag, the summary "Get payment", and a description of the ownership rule (users get their own payments, admins any, otherwise `404`).
- **Exports:** add any new public symbols (`paymentIdParamsSchema`, the caller type) to `payment/index.ts` by name.
- **Tests**, next to each file:
  - Service (memory repository): the owner gets their payment; an admin gets another user's payment; another `user` gets `payment-not-found`; an unknown ID gets `payment-not-found`; the result has no `version` or `idempotencyKey`.
  - Routes (supertest): `200` for the owner, with the same body `POST` returned; `200` for an admin token on another user's payment; `404` with a type ending in `payment-not-found` for another user's payment and for an unknown UUID, with identical `detail`; `400 validation-error` with pointer `/id` for `not-a-uuid`; `401` without a token; the body never contains `version` or `idempotencyKey`.
  - OpenAPI (`app.test.ts`): `paths["/payments/{id}"].get` exists with bearer security, an `id` path parameter, and responses `200`, `400`, `401`, `404`.
- **README:** add a `GET /payments/:id` row to "Payment endpoints" (`200` with the payment, errors `400`, `401`, `404`), a note on the ownership rule, and a `curl` example. Update the status line near the top so it lists `GET /payments/:id`.
- **Roadmap:** set the BE-03-03 row to `in-progress` with a link to this doc when starting and `done` when finished. Retitle BE-03-06 to "Payment status PATCH is admin-only (read ownership shipped in BE-03-03)".

## Preserve

- `POST /payments` behavior, validation, idempotency and its OpenAPI entry.
- The `Payment` response schema shape.
- `libs/shared` unchanged, including the logger. The state machine (`payment.status.ts`) unchanged.
- Auth and notification services unchanged. Every existing test passes unchanged.

## Excluded

- Listing payments (BE-07-02).
- `PATCH /payments/:id/status` and its admin-only rule (BE-03-04, BE-03-06).
- Caching, ETags or conditional requests.
- Returning `403` for another user's payment.

## Likely Files To Touch

- `services/payment/src/payment/payment.schema.ts`
- `services/payment/src/payment/payment.service.ts`, `payment.service.test.ts`
- `services/payment/src/payment/payment.controller.ts`
- `services/payment/src/payment/payment.routes.ts`, `payment.routes.test.ts`
- `services/payment/src/payment/payment.openapi.ts`
- `services/payment/src/payment/index.ts`
- `services/payment/src/app.test.ts`
- `README.md`, `ROADMAP.md`

## Prerequisites

BE-03-02 and BE-03-07 are merged to `main`.

## Decisions Required Before Implementation

None. Settled during intake on 2026-10-19 (see Source Context).

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons.
- Never log the token, the `Authorization` header or email.
- Errors only through the central error model.
- No dependency changes. Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or `libs/shared`. If one turns out to be needed, stop and record why in this doc first.

## Deliverables

- `GET /payments/:id` with the ownership and error behavior specified above.
- OpenAPI registration, unit tests and supertest tests.
- `README.md` and `ROADMAP.md` updated, including the BE-03-06 retitle.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
```

- All three exit 0 with Docker stopped.
- Manual run (`pnpm dev`): log in as the seeded user and create a payment. `GET /payments/<id>` returns `200` with it. With the seeded admin's token it also returns `200`. With a newly registered user's token it returns `404 payment-not-found`.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-03-03 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-03-04: reuse `paymentIdParamsSchema` and the not-found behavior for `PATCH /payments/:id/status`.
- BE-03-06: admin-only status PATCH only.
