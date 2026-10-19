# BE-01-10: Standard success response envelope

**Covers:** BE-01-10
**Status:** done

## Objective

Every successful API response uses one shape, so a client always knows where the payload is and what happened:

```json
{ "status": 201, "success": true, "data": { … }, "message": "Payment created" }
```

Paginated responses add `meta`, and `data` is an array. `message` is a short human-readable summary, or `null`. Errors are unchanged: they stay RFC 9457 Problem Details (`application/problem+json`), as decided in BE-01-06.

## Source Context

The user asked on 2026-10-19 after testing `POST /payments` in Swagger UI. An idempotent replay returned `200` with a bare payment and nothing saying it was a replay. Every error example in Swagger also showed `"status": 400`, whatever the response code. The user chose:
- **The envelope applies to success responses only.** Errors keep the Problem Details format from `tasks/BE-01-06-error-model.md`.
- **A new milestone with a task doc**, delivered on its own branch and PR.

Fixed by the request: the members `status`, `success`, `data`, `message` (nullable), and `meta` plus an array `data` for paginated responses.

## Design Reference

- `tasks/BE-01-06-error-model.md`: the error format, which stays unchanged.
- `tasks/BE-01-09-openapi-setup.md`: OpenAPI is generated from Zod schemas, and each endpoint registers its responses.
- `AGENTS.md`: register every endpoint's responses in OpenAPI; update the README when endpoints change; shared code lives in `libs/shared`.

## Architecture Summary

```
libs/shared/src/response.ts
  sendData(res, data, { status?, message? })      → { status, success: true, data, message }
  sendPage(res, items, meta, { status?, message? }) → { status, success: true, data: items, message, meta }
  dataResponseSchema(schema)  / pageResponseSchema(itemSchema)   Zod schemas for OpenAPI
  pageMetaSchema: { page, limit, total, totalPages }

libs/shared/src/openapi.ts
  problemResponses(...)   each status gets an example with its own status and title
```

| Endpoint | Status | `message` |
|---|---|---|
| `POST /auth/register` | 201 | `"Account created"` |
| `POST /auth/login` | 200 | `"Logged in"` |
| `POST /payments` (new) | 201 | `"Payment created"` |
| `POST /payments` (replay) | 200 | `"Payment already exists for this Idempotency-Key"` |
| `GET /payments/:id` | 200 | `null` |

## Code Evidence

| Behavior | Source |
|---|---|
| Handlers send bare payloads: `res.status(200).json(token)`, `res.status(201).json(user)` | `services/auth/src/auth/auth.controller.ts` |
| `res.status(replayed ? 200 : 201).json(payment)` and `res.json(await service.get(...))` | `services/payment/src/payment/payment.controller.ts` (`GET` from BE-03-03, PR #16) |
| Response schemas are registered as `User`, `AccessToken` and `Payment` | `services/auth/src/auth/auth.schema.ts`, `services/payment/src/payment/payment.schema.ts` |
| `problemResponses` gives every status the same `ProblemDetails` schema with no example, so Swagger UI generates `"status": 400` from the schema's minimum | `libs/shared/src/openapi.ts` |
| Health endpoints return `{ status: "ok" }` and `{ checks, status }`. `/docs/openapi.json` returns the OpenAPI document | `libs/shared/src/health.ts`, `libs/shared/src/openapi.ts` |
| Route tests read the payload straight from `res.body` | `services/auth/src/auth/auth.routes.test.ts`, `services/payment/src/payment/payment.routes.test.ts` |

## Scope

- **Shared helpers** in a new `libs/shared/src/response.ts`, exported by name from `index.ts`:
  - `sendData(res, data, { status = 200, message = null })` sets the status and sends `{ status, success: true, data, message }`. The body's `status` always equals the HTTP status.
  - `sendPage(res, items, meta, options)` sends the same shape plus `meta`, with `data: items`.
  - `pageMetaSchema = { page, limit, total, totalPages }`, all non-negative integers (`page` and `limit` at least 1).
  - `dataResponseSchema(schema)` and `pageResponseSchema(itemSchema)` build the matching Zod schemas: `status` an integer, `success: z.literal(true)`, `message: z.string().nullable()`.
  - Unit tests for both senders and both schemas.
- **Endpoints:** the four handlers above send through `sendData` with the statuses and messages in the table. Payloads inside `data` are unchanged.
- **OpenAPI:** each success response uses `dataResponseSchema(<payload schema>)`, registered with a component ID named after the payload: `UserResponse`, `AccessTokenResponse`, `PaymentResponse`. The inner `User`, `AccessToken` and `Payment` components stay. The `POST /payments` `200` description says it is a replay.
- **Problem examples:** `problemResponses` adds a per-status `example` (`type`, `title` from `STATUS_CODES`, the real `status`, `detail`, `code`, `instance`, `requestId`), so Swagger shows `401` for the 401 response, and so on. The schema stays `ProblemDetails`.
- **Tests:** update the route tests to read the payload from `res.body.data`, and assert `status`, `success` and `message` on each success response (including the replay message). Update the OpenAPI tests for the new schema references and assert a problem example's `status` matches its response code.
- **README:** describe the envelope once at the top of "API" (with a paginated example), update the success column of the auth and payment tables to say the payload is in `data`, and note that errors keep the Problem Details format. Update the `jq` in the login `curl` example to `.data.accessToken`.
- **Roadmap:** add BE-01-10 to Phase 1, set it to `in-progress` with this doc's link, then `done`.

## Preserve

- Error responses: format, content type, status codes and codes, from both `errorHandler` and `notFoundHandler`.
- Health endpoints (`/health/live`, `/health/ready`) and `/docs/openapi.json` stay unwrapped. They serve orchestrators and tooling, not API clients.
- Payload shapes inside `data`, request validation, auth, idempotency, ownership and rate limiting.
- The `x-request-id` header and logging.

## Excluded

- Changing the error format (an envelope for errors was considered and declined).
- A list endpoint. `sendPage` and `pageResponseSchema` ship with unit tests and are first used by BE-07-02.
- Response headers such as `Idempotent-Replayed`.
- The notification service, which has no endpoints yet. BE-05-03 uses these helpers.

## Likely Files To Touch

- `libs/shared/src/response.ts`, `response.test.ts`, `index.ts`
- `libs/shared/src/openapi.ts`, `openapi.test.ts`
- `services/auth/src/auth/auth.controller.ts`, `auth.openapi.ts`, `auth.schema.ts`, `auth.routes.test.ts`
- `services/auth/src/app.test.ts`
- `services/payment/src/payment/payment.controller.ts`, `payment.openapi.ts`, `payment.schema.ts`, `payment.routes.test.ts`
- `services/payment/src/app.test.ts`
- `README.md`, `ROADMAP.md`

## Prerequisites

BE-03-03 (PR #16), which adds `GET /payments/:id`. This branch stacks on `feat/BE-03-03-get-payment`. Its PR targets that branch until #16 merges.

## Decisions Required Before Implementation

None. Settled on 2026-10-19: success-only envelope, errors unchanged, health and docs unwrapped, messages as in the table, `message: null` for plain reads.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons.
- Errors only through the central error model.
- No dependency changes, and no changes to `tsconfig*.json`, `jest.config.js` or `biome.jsonc`.

## Deliverables

- Shared response helpers and schemas, with tests.
- All four endpoints send the envelope, documented in OpenAPI.
- Per-status problem examples in Swagger.
- `README.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0.
- In the generated OpenAPI document, `POST /payments` `201` references `PaymentResponse`, and the `401` problem example has `"status": 401`.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-01-10 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-03-04, BE-05-03, BE-07-02: send through `sendData` / `sendPage` and register `dataResponseSchema` / `pageResponseSchema`.
