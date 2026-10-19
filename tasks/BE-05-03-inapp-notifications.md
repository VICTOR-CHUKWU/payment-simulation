# BE-05-03: In-app notifications

**Covers:** BE-05-03
**Status:** done

## Objective

Make the in-app channel store a notification for each payment event that matters to the user, and let users read and dismiss their own notifications over HTTP. The `notification-inapp` consumer's handler stores one record per event (`payment.created`, `payment.succeeded`, `payment.failed`, `payment.cancelled`). The record is keyed by the event ID, so a re-run after a crash never stores a second one. Three authenticated endpoints list the caller's notifications, mark one as read and mark all as read. Users see only their own notifications, admins included. Everything ships with unit and supertest tests, and the endpoints are registered in the notification OpenAPI document.

## Source Context

Roadmap milestone BE-05-03 ("In-app notifications: store, `GET /notifications` (own notifications only), mark as read") in `ROADMAP.md`. It also takes over the notification half of the cancelled BE-05-07 ("Ownership and role checks"). Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Events: every type except `payment.processing`.** `processing` follows `created` within milliseconds, so a notification for it is noise. The handler still runs for `processing` and the inbox marker is still written; it just stores nothing.
- **Listing: paged, with an unread filter.** Newest first, `page` (default 1) and `limit` (default 20, max 100), returned through the shared `sendPage` envelope with `meta`. Optional `unread=true` returns only unread ones, so `meta.total` doubles as the unread count.
- **Mark as read: one and all.** `PATCH /notifications/:id/read` marks one; marking an already-read one returns `200` and keeps its original `readAt`. `PATCH /notifications/read` marks all of the caller's unread notifications and returns how many changed.
- **Content: rendered text plus fields.** A notification holds `id` (the event ID), `userId`, `type`, `paymentId`, `amount`, `currency`, `title`, `message`, `readAt` and `createdAt`. Text is rendered when the event is stored, so a later wording change does not rewrite old notifications. The email address is never stored.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- Wording of `title` and `message` (see Architecture Summary).
- `createdAt` is the event's `occurredAt`, not the time it was stored, so a replayed event sorts where it happened.
- `unread=false` returns only read notifications; leaving `unread` out returns both. Only the exact strings `true` and `false` are accepted.
- Error code `notification-not-found` for an unknown ID or another user's notification, matching `payment-not-found`.
- Unknown query parameters return `400`, matching the strict request bodies elsewhere.
- One combined `storage` readiness check covering both repositories (see Architecture Summary).

## Design Reference

- `AGENTS.md`, Architecture constraints: payment events carry `userId` and email so notification never looks users up; services verify JWTs locally; each service owns its data through a repository; Zod at the boundary; errors through the central error model; status changes through compare-and-set; money as integer minor units. Task docs: every endpoint is registered in its service's OpenAPI spec in the same change, including error responses, and the README is updated with it.
- `ROADMAP.md`, Decisions table: Auth (claims `sub`, `email`, `role`; shared-lib middleware), Notifications ("In-app (stored, readable via API)"), Persistence, API docs, and the response envelope (BE-01-10: `status`, `success`, `data`, `message`, `meta` for pages).
- `tasks/BE-05-02-idempotent-event-handling.md`, Follow-ups: "BE-05-03: plug in-app storage into `onEvent` and make its insert tolerate a re-run, for example with an ID derived from the event ID, so a crash before the marker is written does not create two notifications."
- `tasks/BE-03-03-get-payment.md` and the payment service: another user's resource returns the same `404` as an unknown ID.

## Architecture Summary

```
services/notification/src/
  notification/
    notification.ts              notificationSchema (repository record), Notification, NOTIFIED_TYPES
    notification.render.ts       renderNotification(event) → { title, message } | undefined for unnotified types
    notification.schema.ts       params/query schemas; response schemas with OpenAPI ids Notification,
                                   NotificationPage, NotificationResponse, MarkAllReadResponse
    notification.service.ts      createNotificationService(repository, { now? })
                                   record(event)             insert; DuplicateRecordError → no-op; processing → no-op
                                   list(userId, { page, limit, unread })
                                   markRead(userId, id)      CAS, idempotent, 404 if missing or not owned
                                   markAllRead(userId)       → { updated }
    notification.controller.ts
    notification.routes.ts       authenticate(jwtSecret) per route, as paymentRouter does (not router.use,
                                   which would turn unknown paths into 401 instead of 404)
    notification.openapi.ts      registerNotificationPaths(registry)
    index.ts
  app.ts       createApp gains jwtSecret and notifications; mounts notificationRouter before notFoundHandler
  openapi.ts   registers notification paths
  main.ts      opens a second repository named "notifications"; in-app handler gets onEvent = service.record
```

`createApp` builds its own notification service from the repository it is given; `main.ts` builds another for the handler. The service holds no state, so two instances over one repository are fine.

Event to notification:

| Event type | Stored | `title` | `message` |
|---|---|---|---|
| `payment.created` | yes | Payment received | Your payment of NGN 1,500.00{ for <description>} was received and is being processed. |
| `payment.processing` | no | — | — |
| `payment.succeeded` | yes | Payment succeeded | Your payment of NGN 1,500.00{ for <description>} succeeded. |
| `payment.failed` | yes | Payment failed | Your payment of NGN 1,500.00{ for <description>} failed: <failureReason>. |
| `payment.cancelled` | yes | Payment cancelled | Your payment of NGN 1,500.00{ for <description>} was cancelled. |

The amount is formatted with `Intl.NumberFormat("en", { currency, currencyDisplay: "code", style: "currency" })`, dividing the minor-unit integer by `10 ** maximumFractionDigits` from that formatter's `resolvedOptions()`, so a zero-decimal currency would still render correctly. The float is used only for display; the stored `amount` stays an integer. On Node 24 the output separates the code and the number with a no-break space (U+00A0), not a plain space: `150000 NGN` renders as `"NGN\u00a01,500.00"`, and tests must assert that exact string. The table above writes it with a plain space for readability.

`notificationSchema` (strict, validated on load by the file adapter):

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | the event's `eventId` |
| `userId` | UUID | from `event.data.userId`; the owner |
| `type` | non-empty string | event type. Deliberately not the event-type enum, for the same reason as the inbox's `type`: a type removed from the catalogue must still load |
| `paymentId` | UUID | |
| `amount` | positive integer | minor units |
| `currency` | 3 uppercase letters | |
| `title` | non-empty string | |
| `message` | non-empty string | |
| `readAt` | ISO datetime or `null` | `null` until read |
| `createdAt` | ISO datetime | the event's `occurredAt` |
| `version` | positive integer | repository-managed; never in responses |

Re-run safety: `record` inserts with `id = eventId`. If the service crashed after the insert but before the inbox marker, the redelivery's insert throws `DuplicateRecordError`, which `record` treats as already done, so the handler writes the marker and acks. Any other insert error propagates, so the handler naks (BE-05-02 behavior).

HTTP:

| Method | Path | Query/body | Success | Errors |
|---|---|---|---|---|
| `GET` | `/notifications` | `page`, `limit`, `unread` (`true`/`false`), all optional | `200`, `data`: notifications newest first (by `createdAt`, then `id`), `meta`: `PageMeta` | `400`, `401` |
| `PATCH` | `/notifications/:id/read` | — | `200`, `data`: the notification, message `Notification marked as read` | `400` (non-UUID id), `401`, `404` |
| `PATCH` | `/notifications/read` | — | `200`, `data: { updated }`, message `Notifications marked as read` | `401` |

- The owner is the token's `sub`. Every role sees only its own notifications; there is no admin view.
- Query schema (`z.strictObject`): `page` and `limit` are `z.coerce.number().int()` with the bounds and defaults above; `unread` is `z.enum(["true", "false"]).optional()`, compared to `"true"` in the controller. Do not use `z.stringbool()`: its defaults also accept `yes`, `1`, `on` and others, and it shows as a plain string in OpenAPI. A repeated parameter (`?page=1&page=2`) arrives as an array and fails with `400`.
- `meta` is `{ page, limit, total, totalPages }` with `totalPages = Math.ceil(total / limit)` (`0` when there are none). A page past the end returns an empty `data` with correct `meta`.
- Sort by `Date.parse(createdAt)` descending, then `id` descending. Do not compare the ISO strings: `z.iso.datetime()` accepts any number of fraction digits, and `…00Z` sorts after `…00.500Z` as text.
- The response shape omits `version`.
- Neither PATCH takes a body, so no JSON parser is mounted on them.

Writes and concurrency: the consumer only inserts, and only the HTTP routes update. `markRead` re-reads, returns the notification unchanged if `readAt` is already set, and otherwise updates with the read version; on `VersionConflictError` it retries (up to 3 attempts, as `transitionPayment` does), so two concurrent mark-reads both return `200` with the same `readAt`. `markAllRead` finds the caller's unread notifications, applies the same per-notification step to each (in parallel is fine; the file adapter queues writes) and returns how many this call changed. One marked by a concurrent request in the meantime is not counted, so two concurrent mark-alls split the count between them and their sum equals the number that were unread. A `VersionConflictError` cannot exhaust the 3 attempts in practice, because the only update ever made is setting `readAt`, so the re-read finds it set. A storage error part way through returns `500` and leaves the earlier ones marked; a retry marks the rest. Each update rewrites the notifications file, which is acceptable at this scale.

Readiness: `openRepository` names every check `storage`, and `healthRouter` builds its response with `Object.fromEntries`, so two checks with the same name would show as one key. `main.ts` therefore passes a single `{ name: "storage", check }` whose `check` awaits both opened checks and passes only when both pass. `main.ts` opens `notifications` right after `inbox`, before the consumers start, because the in-app handler needs the service. Shutdown closes both repositories after `drainNats` (the HTTP server is already closed by then, so no route is still writing).

## Code Evidence

| Behavior | Source |
|---|---|
| `createEventHandler({ channel, inbox, logger, onEvent })`: skips duplicates by inbox marker, awaits `onEvent(event, log)`, writes the marker, acks; a throw from `onEvent` naks | `services/notification/src/consumer/consumer.handler.ts` |
| Both handlers are created with no `onEvent` (no-op default) | `services/notification/src/main.ts` |
| `main.ts` opens one repository (`inbox`) with `openRepository`, passes `[natsCheck, consumersCheck, check]` to readiness and closes the inbox last | `services/notification/src/main.ts` |
| `createApp({ checks, docs, logger })` mounts health and docs only; `buildDocument()` registers no paths | `services/notification/src/app.ts`, `services/notification/src/openapi.ts` |
| `notificationConfigSchema` already includes storage and JWT config (`JWT_SECRET` resolved) | `services/notification/src/config/config.ts` |
| Payment app pattern: `createApp` takes `jwtSecret` and a repository; router uses `authenticate(jwtSecret)`; controller uses `getAuth(req)` and `sendData`; OpenAPI paths use `bearerSecurity` and `problemResponses` | `services/payment/src/app.ts`, `services/payment/src/payment/payment.routes.ts`, `payment.controller.ts`, `payment.openapi.ts` |
| `paymentNotFound = () => notFound("Payment not found.", { code: "payment-not-found" })` | `services/payment/src/payment/payment.transition.ts` |
| CAS retry loop with `TRANSITION_ATTEMPTS` re-reading on `VersionConflictError` | `services/payment/src/payment/payment.transition.ts` |
| `sendPage`, `pageResponseSchema`, `pageMetaSchema` exist but no service uses them yet | `libs/shared/src/response.ts` |
| Every `openRepository` check is named `storage`; `healthRouter` keys results by name | `libs/shared/src/storage.ts`, `libs/shared/src/health.ts` |
| `Repository.find(predicate)` returns copies; `update` patches skip `undefined` but keep `null` | `libs/shared/src/repository.ts`, `libs/shared/src/memory-repository.ts` |
| Event `data` carries `paymentId`, `userId`, `email`, `amount`, `currency`, optional `description`, and `failureReason` only on `payment.failed` | `libs/shared/src/payment-events.ts` |
| Route tests sign tokens locally with `jose`'s `SignJWT`; `jose` is a payment devDependency, but `services/notification/package.json` does not list it, and pnpm does not hoist it, so the notification tests cannot import it today | `services/payment/src/payment/payment.routes.test.ts`, `services/payment/package.json`, `services/notification/package.json` |
| `notFound(detail, { code })` builds a typed `404`; `problemResponses(...statuses)` takes any status list; `pageResponseSchema(item)` has no OpenAPI id until one is added with `.meta` | `libs/shared/src/errors.ts`, `libs/shared/src/openapi.ts`, `libs/shared/src/response.ts` |
| Zod is 4.6.7; `z.stringbool()` accepts `yes`/`1`/`on` by default | `services/notification/package.json` |
| `app.test.ts` calls `createApp({ checks, docs, logger })` in every test | `services/notification/src/app.test.ts` |
| README "Events" still says "For now the handlers only log events. Storing in-app notifications and sending email arrive with BE-05-03 and BE-05-04."; the status note says the notification service is not implemented yet | `README.md` |

## Scope

- **`notification/` module** as in the Architecture Summary, with an `index.ts` barrel.
- **Handler wiring**: the `inapp` handler gets `onEvent: (event) => service.record(event)`. The `email` handler stays a no-op. `consumer/` does not change.
- **App and docs**: `createApp` takes `jwtSecret` and the notifications repository and mounts the router; the existing `app.test.ts` calls pass a secret and a memory repository; `buildDocument` registers the three paths with their error responses, the `Notification` schema and the page envelope.
- **`main.ts`**: open `notifications` alongside `inbox`, combined `storage` check, close both on shutdown. A failure to open either falls into the existing "startup failed" path.
- **Test dependency**: add `jose` `6.2.12` (the version payment pins) to the notification devDependencies with `pnpm --filter @payment-be/notification add -D jose@6.2.12`, so route tests can sign tokens. This is the one allowed dependency change.
- **Tests** (memory repository, hand-written stubs, tokens signed as in the payment route tests):
  - `notification.render.test.ts`: each stored type's title and message, with and without `description`; `failureReason` in the failed message; formatting of `150000 NGN` as `"NGN\u00a01,500.00"` (no-break space) and of a zero-decimal currency (`1500 JPY` as `"JPY\u00a01,500"`); `payment.processing` returns `undefined`.
  - `notification.test.ts`: the schema accepts a valid record (with `readAt` `null` and set) and rejects an unknown key, a non-integer amount and a non-UUID `userId`.
  - `notification.service.test.ts`:
    - `record` stores a notification with `id = eventId`, `createdAt = occurredAt`, `readAt: null` and no email.
    - `record` of the same event twice leaves one notification and does not throw.
    - `record` of `payment.processing` stores nothing.
    - `record` rethrows an insert error other than `DuplicateRecordError`.
    - `list` returns only the user's notifications, newest first (with a tie on `createdAt` broken by `id`), paged, with correct `meta` including `totalPages`; a page past the end is empty with correct `meta`; `unread: true` returns only unread and `unread: false` only read.
    - `markRead` sets `readAt`, is idempotent (keeps the first `readAt`), returns `404` for an unknown ID and for another user's notification, and survives a `VersionConflictError` from a stub repository.
    - `markAllRead` marks only the caller's unread notifications, leaves already-read ones' `readAt` unchanged and returns the count; a second call returns `0`.
  - `notification.routes.test.ts` (supertest through `createApp`): `401` without a token on all three routes; list happy path with envelope and `meta`; defaults `page` 1 and `limit` 20 in `meta`; `unread=true` and `unread=false` filter; `400` for `limit=0`, `limit=101`, `page=0`, `page=1.5`, `unread=yes` and an unknown parameter; another user's notifications never appear; an admin sees only their own; mark one `200` and `404` (unknown and another user's) and `400` (non-UUID); mark all returns `{ updated }`; `version` and `email` never appear in a response.
  - `consumer.handler.test.ts`: one test passing `service.record` as `onEvent` shows that a redelivery after a crash between insert and marker (simulated by pre-inserting the notification) acks, writes the marker and leaves one notification.
  - `app.test.ts`: the OpenAPI document lists `/notifications`, `/notifications/{id}/read` and `/notifications/read`.
- **README**:
  - Status note at the top: replace "Payment events and the notification service are not implemented yet." (already stale after BE-04 and BE-05-01/02) with a sentence saying payment events are published and the notification service consumes them, stores in-app notifications and serves them; email is still to come.
  - "Events": replace "For now the handlers only log events…" with what the in-app handler stores (every type except `payment.processing`) and that email arrives with BE-05-04.
  - "Storage and demo accounts": `notification` also stores in-app notifications in `services/notification/data/notifications.json`.
  - "Health checks": for `notification`, `storage` covers both data files and fails if either can no longer be written.
  - "API": a "Notification endpoints" section after "Payment endpoints" and in its style: table, rules (own only, admins included; another user's ID returns `404 notification-not-found` like an unknown one; paging and its bounds; `unread=true`/`false`; unknown query parameters return `400`; idempotent mark-read; mark-all returns how many this call changed) and `curl` examples.
- **Roadmap**: link this doc from the BE-05-03 row. Set it to `in-progress` when starting and `done` when finished.

## Preserve

- The consumer definitions, the handler's decode/term/dedupe/marker/ack flow and its log lines from BE-05-01 and BE-05-02.
- The email channel's behavior (no-op handler) and its inbox markers.
- The shared library: repository contract, adapters, `openRepository`, `healthRouter`, auth middleware and response helpers stay unchanged.
- The payment and auth services.
- Health endpoints, docs routes and the `storage` check name in readiness.

## Excluded

- Email sending and templates (BE-05-04), retries and the DLQ (BE-05-05, BE-05-06).
- An admin view of other users' notifications, deleting notifications, push or live updates (SSE/WebSocket).
- Pruning old notifications or inbox markers.
- Changing the event catalogue or the payment service.

## Likely Files To Touch

- `services/notification/src/notification/` (new)
- `services/notification/src/app.ts`, `app.test.ts`, `openapi.ts`, `main.ts`
- `services/notification/src/consumer/consumer.handler.test.ts`
- `services/notification/package.json`, `pnpm-lock.yaml` (the `jose` devDependency only)
- `README.md`, `ROADMAP.md`

## Prerequisites

BE-05-02 (inbox and per-channel dedupe) is merged to `main` as of commit `9034e5c`.

## Decisions Required Before Implementation

None. The four product decisions were settled during intake on 2026-10-19 (see Source Context). The listed defaults stand unless changed in this doc.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why a duplicate insert counts as done.
- No dependency changes other than the `jose` devDependency above. Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or the shared library. If one turns out to be needed, stop and record why in this doc first.
- Never store or return the email. Never log notification titles or messages (they can contain the payment description).
- Named exports only in each `index.ts`; outside code imports from `notification/index.js`.

## Deliverables

- In-app notification storage fed by the `notification-inapp` consumer, re-run safe.
- `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read`, registered in OpenAPI.
- Unit and supertest tests, plus updates to `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual check against local NATS. Start clean so earlier runs add no notifications: with the services stopped, run `pnpm infra:reset` and `rm -rf services/payment/data services/notification/data` (payments left `processing` or with unsent outbox events would otherwise publish during the check), then `pnpm infra:up` and `pnpm dev`. `auth` data can stay.
  - Log in as the demo user (`user@example.com` / `User123!`), `POST localhost:3002/payments` twice and wait until both are `succeeded` or `failed` (`GET /payments/:id`; with the `.env.example` gateway settings this takes up to about 11 seconds).
  - `GET localhost:3003/notifications` returns 4 notifications newest first (a `created` and an outcome per payment, no `processing`), with `meta.total` 4. `services/notification/data/notifications.json` holds no email.
  - `?unread=true` returns 4; `PATCH /notifications/<id>/read` returns it with `readAt`; repeating it returns the same `readAt`; `?unread=true` now returns 3. `PATCH /notifications/read` returns `{ updated: 3 }`, then `{ updated: 0 }`.
  - As the demo admin (`admin@example.com` / `Admin123!`), `GET /notifications` does not include the user's notifications, and `PATCH /notifications/<user's id>/read` returns `404`.
  - `curl -s localhost:3003/health/ready` returns `200` with `nats`, `consumers` and `storage` as `ok`.
  - `GET /notifications?unread=yes` and `?foo=1` return `400`; `GET /nope` still returns `404`, not `401`.
  - Swagger UI at `localhost:3003/docs` shows the three endpoints with their error responses.
  - Record the results in the PR.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-05-03 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-05-04 can reuse `renderNotification` for email subjects and bodies, or keep its own templates.
- BE-07-02 (`GET /payments` list) can follow this endpoint's paging and query validation.
