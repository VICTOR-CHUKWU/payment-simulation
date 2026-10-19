# BE-03-04: Update a payment's status (admin only)

**Covers:** BE-03-04, BE-03-06
**Status:** done

## Objective

An admin can change a payment's status with `PATCH /payments/:id/status`. The change goes through the BE-03-01 state machine and the repository's compare-and-set update, so an invalid transition is rejected and a concurrent change by another request (later, the BE-03-05 processor) is never overwritten. Only admins may call it. The endpoint returns the updated payment in the standard success envelope.

## Source Context

Roadmap milestones BE-03-04 ("`PATCH /payments/:id/status` — update status, enforcing transitions atomically") and BE-03-06 ("Payment status PATCH is admin-only (read ownership shipped in BE-03-03)") in `ROADMAP.md`. The brief (`~/Downloads/Node js assessment.xlsx`) asks for an update-status endpoint (PUT/PATCH). Scope was agreed during task-doc intake on 2026-10-19. The user chose:
- **Allowed targets:** an admin may set `cancelled`, `succeeded` or `failed`. `processing` is not accepted: it is the processor's claim step (BE-03-05). Leaving it out of the body schema means a request for it returns `400 validation-error`. Which source status each target is allowed from is still decided by the state machine.
- **Concurrent changes:** on `VersionConflictError`, re-read the payment and re-run the transition check, up to 3 attempts in total. If every attempt conflicts, return the repository's `409 version-conflict`.
- **One doc** covers BE-03-04 and BE-03-06, since a status PATCH without its role rule is not a useful intermediate state.

Defaults accepted with the inventory:
- The body is a strict object `{ status, failureReason? }`.
- The token is checked first, then the admin role (`403`), then the body.
- Unknown ID: `404 payment-not-found`.
- Same-status change (for example cancelling a cancelled payment): `409 invalid-status-transition`.
- Success: `200` with the message "Payment status updated".
- No `If-Match`/version header, because `version` is not exposed in responses.
- No events (BE-04-02 adds the outbox).

## Design Reference

- `ROADMAP.md`, Decisions table: Auth (roles `user` and `admin`, tokens verified locally); Persistence (updates are compare-and-set on `version`); Async model (the processor updates status in-process).
- `AGENTS.md`, Architecture constraints: status changes go through the repository's compare-and-set update so an admin PATCH and the processor cannot overwrite each other; validate HTTP input with Zod; errors only through the central error model.
- `AGENTS.md`, Task docs: register the endpoint and its errors in OpenAPI and update the README in the same change.
- `tasks/BE-03-01-payment-model.md`: status graph and follow-up "change status only through `statusChange` plus `repository.update(id, version, patch)`; decide retry or 409 on `VersionConflictError`" (decided above).
- `tasks/BE-03-03-get-payment.md`, Follow-ups: reuse `paymentIdParamsSchema` and the not-found behavior.

## Architecture Summary

```
PATCH /payments/:id/status
Authorization: Bearer <token>
{ "status": "cancelled" | "succeeded" | "failed", "failureReason"?: string }

no / invalid token                              → 401
role is not admin                               → 403 forbidden (before the body is read)
:id not a UUID                                  → 400 validation-error (pointer /id)
body invalid (unknown field, status
  "processing"/"pending"/unknown, failureReason
  missing on failed or present otherwise)       → 400 validation-error
no payment with that id                         → 404 payment-not-found
transition not allowed by the state machine     → 409 invalid-status-transition
every one of 3 attempts hit a version conflict  → 409 version-conflict
otherwise                                       → 200 Payment, message "Payment status updated"
```

Update loop in the service (up to 3 attempts):

```
payment = payments.get(id)          → missing: 404 payment-not-found
patch   = statusChange(payment, to, { failureReason, now })   → 409 invalid-status-transition
payments.update(id, payment.version, patch)
  VersionConflictError → next attempt (re-read, re-check); after the 3rd, rethrow
```

A re-read that finds the payment already moved (for example the processor marked it `succeeded`) ends in `409 invalid-status-transition` with a detail naming the real current status, not a vague version conflict.

```
services/payment/src/payment/
  payment.schema.ts       updatePaymentStatusBodySchema (OpenAPI id UpdatePaymentStatusRequest)
  payment.service.ts      updateStatus(id, { status, failureReason }) → PaymentResponse
  payment.controller.ts   updateStatus: parse params + body, call service, log, 200
  payment.routes.ts       PATCH /payments/:id/status: authenticate, requireRole("admin"), express.json, controller
  payment.openapi.ts      200 PaymentResponse; problems 400, 401, 403, 404, 409, 413, 415
```

## Code Evidence

| Behavior | Source |
|---|---|
| `statusChange(payment, to, { failureReason?, now? })` asserts the transition (`409 invalid-status-transition`) and returns the patch; it throws a plain `Error` (a 500) if `failureReason` is missing for `failed` or given for another status, so the body schema must reject those first | `services/payment/src/payment/payment.status.ts` |
| `PAYMENT_TRANSITIONS`: `pending → processing \| cancelled`, `processing → succeeded \| failed`; final statuses map to `[]` | `services/payment/src/payment/payment.status.ts` |
| `failureReasonSchema` is `z.string().min(1).max(200)` | `services/payment/src/payment/payment.ts` |
| `Repository.update(id, expectedVersion, patch)` is compare-and-set and throws `VersionConflictError` (`409 version-conflict`) | `libs/shared/src/repository.ts`, `memory-repository.ts`, `file-repository.ts` |
| `requireRole(...roles)` throws `forbidden(...)` (`403`, code `forbidden`); it is not used anywhere yet | `libs/shared/src/auth-middleware.ts`, `libs/shared/src/errors.ts` |
| `PaymentService` has `create` and `get`; `get` throws `notFound("Payment not found.", { code: "payment-not-found" })`; `createPaymentService` takes an injectable `now` | `services/payment/src/payment/payment.service.ts` |
| `toPaymentResponse` strips `version` and `idempotencyKey`; `paymentEnvelopeSchema` wraps the response | `services/payment/src/payment/payment.service.ts`, `payment.schema.ts` |
| Routes: `POST /payments` uses `authenticate`, then `express.json({ limit: "16kb" })`; `GET /payments/:id` uses `authenticate` only | `services/payment/src/payment/payment.routes.ts` |
| The controller responds with `sendData(res, data, { message, status })` and logs `{ paymentId }` via `req.log` | `services/payment/src/payment/payment.controller.ts` |
| `problemResponses(...statuses)` and `bearerSecurity` register problem responses and bearer auth | `libs/shared/src/openapi.ts` |
| `app.test.ts` checks the generated OpenAPI document per path and method | `services/payment/src/app.test.ts` |
| README "Payment endpoints" table lists `POST /payments` and `GET /payments/:id`; the status line near the top says other payment endpoints are not implemented yet | `README.md` |

## Scope

- **Body schema** in `payment.schema.ts`: `updatePaymentStatusBodySchema`, a strict object with `status` limited to `cancelled`, `succeeded`, `failed` (derived from `paymentStatusSchema`, for example with `.extract`) and optional `failureReason` (`failureReasonSchema`). It rejects `failureReason` missing when `status` is `failed` and present otherwise, with the error pointer `/failureReason`. Register it under the OpenAPI ID `UpdatePaymentStatusRequest`. Export its inferred type.
- **Service:** `updateStatus(id, { status, failureReason })` with the 3-attempt loop above. It uses the service's `now` for `updatedAt` and returns `toPaymentResponse(updated)`. Only `VersionConflictError` triggers another attempt; every other error propagates unchanged. The loop is not serialized through the create queue.
- **Controller:** `updateStatus` parses `req.params` with `paymentIdParamsSchema` and `req.body` with the new schema, calls the service, logs `{ paymentId, from, to }` at info with the message "payment status updated" (the service may return the previous status for this, or the controller logs only `paymentId` and `to`; either is fine as long as no email is logged), and responds `200` with the message "Payment status updated".
- **Route:** `router.patch("/payments/:id/status", authenticate(jwtSecret), requireRole("admin"), express.json({ limit: "16kb" }), controller.updateStatus)`. The role check runs before the body is read, so a non-admin gets `403` whatever its body.
- **OpenAPI:** register `PATCH /payments/{id}/status` with the params schema, a required JSON body, `200` with `paymentEnvelopeSchema`, `problemResponses(400, 401, 403, 404, 409, 413, 415)`, `security: bearerSecurity`, the `payments` tag, the summary "Update payment status" and a description of: admin only; allowed targets and from which statuses (`pending → cancelled`, `processing → succeeded | failed`); `failureReason` required exactly for `failed`; both `409` codes.
- **Exports:** add new public symbols to `payment/index.ts` by name.
- **Tests**, next to each file:
  - Schema/service (memory repository, injected `now`): each allowed admin edge succeeds and bumps `updatedAt`; `failed` stores `failureReason`; a disallowed edge (for example `pending → succeeded`, `succeeded → cancelled`, `cancelled → cancelled`) throws `invalid-status-transition` and leaves the record unchanged; unknown ID throws `payment-not-found`; a repository whose `update` throws `VersionConflictError` once and then succeeds yields success after a re-read; one that always conflicts throws `VersionConflictError` after exactly 3 attempts; a conflict where the re-read shows the payment already final throws `invalid-status-transition`; the result has no `version` or `idempotencyKey`. A wrapped or stubbed repository is fine for the conflict cases.
  - Routes (supertest): an admin cancels a pending payment (`200`, envelope with message "Payment status updated", status `cancelled`, then `GET` returns the same); an admin marks a `processing` payment (seeded directly in the repository) `failed` with a `failureReason` and `succeeded` without one; `403 forbidden` for a `user` token, including the payment owner, with the record unchanged; `403` for a user token with a malformed body (role checked before body); `401` without a token; `400` with pointer `/id` for a non-UUID ID; `400 validation-error` for `status: "processing"`, `status: "pending"`, an unknown status, an unknown field, `failed` without `failureReason`, `cancelled` with `failureReason`, and an empty or 201-character `failureReason`; `404 payment-not-found` for an unknown UUID; `409 invalid-status-transition` for a disallowed edge and for a repeated cancel; the response never contains `version` or `idempotencyKey`; the log line carries the payment ID and no email.
  - OpenAPI (`app.test.ts`): `paths["/payments/{id}/status"].patch` exists with bearer security, an `id` path parameter, a request body, and responses `200`, `400`, `401`, `403`, `404`, `409`, `413`, `415`.
- **README:** add a `PATCH /payments/:id/status` row to "Payment endpoints" and notes on the admin-only rule, allowed targets, `failureReason`, and both `409` codes, with a `curl` example using the seeded admin. Update the status line near the top to list the endpoint.
- **Roadmap:** set BE-03-04 and BE-03-06 to `in-progress` with a link to this doc when starting, and `done` when finished.

## Preserve

- `POST /payments` and `GET /payments/:id` behavior, validation, idempotency and their OpenAPI entries.
- The `Payment` response schema and `PaymentResponse` envelope shapes.
- `payment.status.ts` transition table and `statusChange` behavior.
- `libs/shared` unchanged. Auth and notification services unchanged. Every existing test passes unchanged.

## Excluded

- The background processor and the `pending → processing` claim (BE-03-05).
- Publishing events or an outbox for status changes (BE-04-01, BE-04-02).
- A client-supplied version or `If-Match`/ETag precondition.
- Status changes by the payment owner (for example a user cancelling their own payment).
- Listing payments (BE-07-02), refunds, or new statuses.
- An audit trail of who changed a status beyond the log line.

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

BE-03-03 and BE-01-10 are merged to `main` (BE-01-10 is on `feat/BE-01-10-response-envelope` at intake time; branch from `main` once it lands, or from that branch if it has not).

## Decisions Required Before Implementation

None. Settled during intake on 2026-10-19 (see Source Context). Rejected options:
- Allowing an admin to set `processing` (it would create `processing` payments the processor never claimed) and limiting admins to `cancelled` only (the brief's update endpoint would then cover just one edge).
- Returning `409 version-conflict` on the first conflict (vaguer for the admin when the real cause is that the processor already moved the payment).
- Separate task docs for BE-03-04 and BE-03-06.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons (the retry loop's reason may merit one line).
- Never log the token, the `Authorization` header or email.
- Errors only through the central error model.
- No dependency changes. Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or `libs/shared`. If one turns out to be needed, stop and record why in this doc first.

## Deliverables

- `PATCH /payments/:id/status`, admin only, with the transition, retry and error behavior specified above.
- OpenAPI registration, unit tests and supertest tests.
- `README.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
```

- All three exit 0 with Docker stopped.
- Manual run (`pnpm dev`): as the seeded user, create a payment. With the seeded user's token, `PATCH /payments/<id>/status` with `{ "status": "cancelled" }` returns `403`. With the seeded admin's token it returns `200` with status `cancelled`. Repeating it returns `409 invalid-status-transition`. Swagger UI at `/docs` shows the endpoint.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-03-04 and BE-03-06 rows in `ROADMAP.md` are `done` and link to this file.

## Follow-ups

- BE-03-05: the processor uses the same get → `statusChange` → `update` pattern for `pending → processing` and its results; consider extracting the retry loop into a shared service helper then rather than now.
- BE-04-02: publish `payment.cancelled` / `payment.succeeded` / `payment.failed` from admin changes through the outbox, written in the same update as the status.
