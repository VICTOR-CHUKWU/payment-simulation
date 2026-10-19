# BE-05-05: Email retries with backoff, and a dead-letter queue

**Covers:** BE-05-05, BE-05-06
**Status:** done

## Objective

Give the email channel bounded retries with growing delays, then a dead-letter queue (DLQ) that admins can inspect and replay. A failed send is retried up to 5 attempts in total, waiting 5 s, 30 s, 2 min and 10 min between them. An email that still fails, or that the SMTP server rejects permanently, is published to a JetStream `DLQ` stream and its message is acked, so JetStream stops redelivering it. Admins list and read DLQ entries over HTTP and replay one, which sends the email again and removes the entry on success. The in-app channel keeps its unbounded 5 s retry. Retry counts and delays are configurable, so tests and demos can use short ones. Everything ships with unit and supertest tests, and the endpoints are registered in the notification OpenAPI document.

## Source Context

Roadmap milestones BE-05-05 ("Email retries with backoff (bounded redelivery, short delays configurable for tests)") and BE-05-06 ("Dead-letter stream for exhausted emails, with inspect and replay (admin only)") in `ROADMAP.md`. `AGENTS.md` names one task doc for both (`tasks/BE-05-05-email-retries-dlq.md`), and both are on its list of milestones that need an approved task doc. Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Retries: 5 attempts over about 13 minutes.** Delays of 5 s, 30 s, 2 min and 10 min between attempts, then dead-letter. Both are configurable through env vars.
- **Permanent rejections dead-letter at once.** A 5xx SMTP reply (for example `550` recipient rejected) or an envelope error (`EENVELOPE`) goes straight to the DLQ. Only connection failures, timeouts and 4xx replies are retried.
- **Replay sends now and deletes on success.** `POST /admin/dlq/:seq/replay` sends the email inside the request and returns `200`, or `502` with the safe error code. On success the DLQ entry is deleted; on failure it stays for another try.
- **In-app keeps the 5 s retry.** In-app handling only fails when local storage fails, which readiness already reports, and dropping a notification after N tries is worse than waiting. The DLQ is email-only.

Decided after review on 2026-10-19:

- **No `max_deliver` on the email consumer.** The handler's attempt count is the bound: it dead-letters after `EMAIL_MAX_ATTEMPTS` deliveries. Inbox read failures and failed DLQ publishes keep retrying instead of dropping mail. The email consumer definition stays as it is today.
- **Ack, not term, after dead-lettering, and the Decisions table is reworded to match.** The implementer updates the Email failure handling row in the same change (wording under Scope, Roadmap).

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- **Env vars:** `EMAIL_MAX_ATTEMPTS` (integer 1 to 20, default `5`) and `EMAIL_RETRY_DELAYS_MS` (comma-separated positive integers, default `5000,30000,120000,600000`). Attempt `n` that fails waits `delays[n - 1]`; if the list is shorter than `EMAIL_MAX_ATTEMPTS - 1`, the last delay repeats, and extra entries are ignored.
- **The handler computes each delay** from the message's delivery count and naks with it. The consumer gets no `backoff` list: `backoff` only schedules redeliveries after an `ack_wait` timeout, not after a nak with a delay, and nats-server sets a consumer's `ack_wait` to its first `backoff` value, which would shorten the 30 s window that BE-05-04's 10 s SMTP timeouts rely on.
- **A failed DLQ publish naks with the last configured delay** (10 min by default) and is retried until it succeeds.
- **DLQ stream:** `DLQ`, subjects `dlq.>`, file storage, limits retention, `max_age` 30 days, `discard: old`, 1 replica, 2-minute duplicate window. Entries go to `dlq.email`. It is defined in the shared library next to `PAYMENTS_STREAM`, because services reach JetStream only through it, and `notification` creates it at startup with `ensureStream`.
- **DLQ entry** is an event envelope (`createEvent`), type `notification.email.dead-lettered`, published with `publishEvent` (so its `eventId` is the JetStream `Nats-Msg-Id`) and the original correlation ID. `data` holds the original payment event, `reason` (`"exhausted"` or `"rejected"`), the safe error fields (`code`, `responseCode`, `command`) and `attempts`.
- **Retry logging lives in the email channel.** The channel logs each scheduled retry with its context; the handler naks a `RetryLaterError` without logging it, so each failure gives one log line.
- **Admin endpoints** live under `/admin/dlq` on the notification service, admin role only. Entries are identified by their DLQ stream sequence number (`seq`).
- **Replay returns `data: { seq, eventId }`**, where `eventId` is the original payment event's. `EmailService.send` resolves to nothing, and the email's `Message-ID` is always `<eventId@payment-simulation.local>`, so no change to the email service is needed.
- **The `502` carries the safe error in `detail`** (for example `The SMTP server did not accept the email (ESOCKET).` or `(550)`). The shared problem body has no extra fields, and this task does not change it.
- **Concurrent replays of one entry** are refused with `409 replay-in-progress` through an in-process set of sequences being replayed, so a double click does not send twice.
- **Admins see the recipient address** in DLQ responses, because they need it to judge a rejection. Logs still never contain it.

## Design Reference

- `ROADMAP.md`, Decisions table, Email failure handling, currently: "Retries with backoff (consumer `backoff` / `nak` delay, bounded by `max_deliver`). On the last attempt the handler publishes to a `DLQ` stream and terminates the message — JetStream has no built-in dead-letter stream." This task uses handler-computed `nak` delays, bounds them by the handler's attempt count instead of `max_deliver`, and acks after a successful DLQ publish instead of terming. Per the user's decision, the row is reworded in the same change (see Scope, Roadmap).
- `AGENTS.md`, Architecture constraints: services reach NATS only through the shared library; every event has a unique ID; consumers are idempotent per channel; Zod at the boundary; errors through the central error model; never log passwords, tokens or auth headers. Task docs: endpoints registered in OpenAPI with error responses; README updated in the same change.
- `tasks/BE-05-02-idempotent-event-handling.md`, Follow-ups: "BE-05-05: on email's last delivery attempt, publish to the DLQ and write the marker (or term), so the DLQ replay is the only way it runs again."
- `tasks/BE-05-04-email-channel.md`, Follow-ups: replace the fixed nak delay on the email consumer; "BE-05-06: on the last attempt, publish to the DLQ instead of nak'ing; `EmailSendError.code` is the reason to record."
- `tasks/BE-05-03-inapp-notifications.md`: route, controller, OpenAPI and test patterns for notification endpoints.

## Architecture Summary

```
libs/shared/src/streams.ts        DLQ_STREAM (exported next to PAYMENTS_STREAM, and from index.ts)

services/notification/src/
  consumer/
    consumer.handler.ts           onEvent(event, logger, { correlationId, deliveryCount }) (EventContext);
                                  ConsumerMessage gains info: { deliveryCount: number }
                                  RetryLaterError(delayMs): the catch naks with err.delayMs and logs nothing;
                                  any other error keeps "event handling failed" and NAK_DELAY_MS
    index.ts                      also exports RetryLaterError and EventContext
                                  (consumer.config.ts is unchanged)
  email/
    email.retry.ts                retryDelay(attempt, delays); isPermanent(err: EmailSendError)
    email.channel.ts              createEmailChannel({ emailService, deadLetter, maxAttempts, delays })
                                    → onEvent(event, log, { correlationId, deliveryCount })
  dlq/
    dlq.ts                        dlqEntrySchema (envelope of { channel, event, reason, code?, responseCode?, command?, attempts })
    dlq.publisher.ts              createDeadLetterPublisher(js: Pick<JetStreamClient, "publish">)
                                    → deadLetter(fields, correlationId?) → Promise<{ seq }> (from the PubAck)
    dlq.service.ts                DlqStreams interface; createDlqService({ jsm: DlqStreams, emailService }) → list, get, replay
    dlq.controller.ts, dlq.routes.ts (authenticate + requireRole("admin") per route), dlq.schema.ts, dlq.openapi.ts
    index.ts
  config/config.ts                EMAIL_MAX_ATTEMPTS, EMAIL_RETRY_DELAYS_MS
  app.ts, openapi.ts              mount and register the DLQ routes
  main.ts                         ensureStream(DLQ_STREAM); email onEvent = channel.onEvent
```

Email `onEvent` with delivery count `n` (1 on the first delivery) and `max = EMAIL_MAX_ATTEMPTS`:

```
emailService.send(event, log)
  ok ─────────────────────────────────────────────► return (handler writes the marker and acks)
  EmailSendError, permanent (responseCode 5xx or code EENVELOPE)
     ─► deadLetter(reason "rejected") ─► log warn "email dead-lettered" { seq, reason, attempt: n, code, responseCode } ─► return
  EmailSendError, n >= max
     ─► deadLetter(reason "exhausted") ─► same log line ─► return
  EmailSendError, n < max
     ─► log warn "email send failed, retrying" { attempt: n, delayMs, code, responseCode }
     ─► throw RetryLaterError(retryDelay(n, delays))   (handler naks with that delay, no log)
deadLetter throws
     ─► log error "dead-letter publish failed" { attempt: n, err }
     ─► throw RetryLaterError(last delay)   (the next delivery tries the send again, then the publish;
                                              this repeats until one of them succeeds)
```

`EmailSendError` and its safe fields (`code`, `responseCode`, `command`) come from BE-05-04 (`email/email.service.ts`). `isPermanent` reads only those fields. Any error from `send` that is not an `EmailSendError` (none today) is rethrown unchanged, so the handler logs it and naks with `NAK_DELAY_MS`. `payment.processing` has no template: `send` returns without sending, so the channel returns too.

**Why ack, not term, after dead-lettering.** Returning normally from `onEvent` makes the existing handler write the inbox marker and ack, as BE-05-02's follow-up asks. The marker means a later replay of the `PAYMENTS` stream (a recreated consumer, a late outbox republish) skips the event, so the DLQ replay endpoint is the only way it runs again. A `term` would need a new handler path and would leave no marker. JetStream never delivers the message again either way.

**Handler changes stay generic.** The handler passes `{ correlationId, deliveryCount: msg.info.deliveryCount }` to `onEvent`; the email channel needs the correlation ID to publish the DLQ entry. Its existing "event handling failed" catch naks with `err.delayMs` when `err` is a `RetryLaterError`, otherwise logs at `error` and naks with `NAK_DELAY_MS`. The in-app channel never throws `RetryLaterError`, so it keeps BE-05-04's 5 s retry with no limit. `RetryLaterError` lives in `consumer.handler.ts` and is exported from `consumer/index.ts`; `email.channel.ts` imports it from there (consumer does not import email, so there is no cycle).

**JetStream behaviour this relies on** (nats-server 2.15.1, `@nats-io/jetstream` 3.4.0):

- `JsMsg.info.deliveryCount` is parsed from the ack subject and is `1` on the first delivery. Every redelivery increments it, whether it follows a nak, a nak with a delay or an `ack_wait` timeout.
- `msg.nak(ms)` sends `-NAK {"delay": <nanos>}`. The server holds the message for that delay, even when it is longer than `ack_wait`. A nak'd message stays pending, so it counts toward `max_ack_pending` (server default 1000), but it does not block other messages.
- `startConsumer` awaits one handler at a time, and `nak` returns at once, so a 10-minute delay holds only that message. The handler never waits for the delay.
- Both consumers keep the server default `max_deliver` of `-1` (unlimited), so JetStream never gives up on a message by itself. The handler's attempt count is the only bound.

**Known limits, accepted at demo scale:**

- Attempts are delivery counts, so any redelivery spends one, even when no send was tried: an inbox read failure before `onEvent` (each one naks after 5 s), or an `ack_wait` timeout while a slow send runs (BE-05-04 Risks). Mail is not dropped, but such an email gets fewer real send attempts. If the count has already reached `EMAIL_MAX_ATTEMPTS` when a send is first tried, a retryable failure on that send dead-letters it at once with `reason: "exhausted"`, and `attempts` records the delivery count, not the number of sends.
- While the DLQ publish keeps failing (for example while NATS is down), the message stays pending and is redelivered every last delay (10 min by default) with no limit. Each redelivery tries the send first, so a recovered SMTP server delivers the email with no DLQ entry. Each publish failure is logged at `error`.
- A DLQ publish whose ack is lost but which the server stored, followed by a retry more than 2 minutes later, stores two entries with different `eventId`s. Replaying both sends the email twice.

**DLQ entry** (`dlqEntrySchema`, `eventEnvelopeSchema(...)` extended with `type: z.literal("notification.email.dead-lettered")`):

| Field | Notes |
|---|---|
| `eventId`, `occurredAt`, `type` | from `createEvent`; `occurredAt` is when it was dead-lettered |
| `data.channel` | `"email"` |
| `data.event` | the original payment event, parsed with `paymentEventSchema`, so replay can render the email again |
| `data.reason` | `"exhausted"` or `"rejected"` |
| `data.code`, `data.responseCode`, `data.command` | from `EmailSendError`, each optional |
| `data.attempts` | the delivery count when it was dead-lettered; above `EMAIL_MAX_ATTEMPTS` when an earlier DLQ publish failed |

The entry contains the recipient address (inside `data.event.data.email`). That is required for replay. It is never logged.

**Admin API** (all three need a valid token with role `admin`: `401` without a token, `403` for a `user`):

| Method | Path | Success | Errors |
|---|---|---|---|
| `GET` | `/admin/dlq` | `200`, page envelope: entries newest first (highest `seq` first), `meta` as in `GET /notifications`; query `page` (default 1), `limit` (default 20, max 100), strict | `400`, `401`, `403` |
| `GET` | `/admin/dlq/:seq` | `200`, one entry | `400` (not a positive integer), `401`, `403`, `404 dlq-entry-not-found` |
| `POST` | `/admin/dlq/:seq/replay` | `200`, `data: { seq, eventId }`, message `Email sent`; the entry is deleted | `400`, `401`, `403`, `404`, `409 replay-in-progress`, `500`, `502 email-send-failed` |

- Each response item is `{ seq, deadLetteredAt, reason, attempts, code?, responseCode?, command?, event }`, where `deadLetteredAt` is the entry's `occurredAt` and `event` is the original payment event.
- `seq` is parsed with `z.coerce.number().int().min(1)`, so `0`, `abc` and `1.5` return `400`. `GET /admin/dlq/:seq` and `POST /admin/dlq/:seq/replay` differ in method and segment count, so route order does not matter.
- Errors use the shared factories: `notFound(detail, { code: "dlq-entry-not-found" })` and `conflict(detail, { code: "replay-in-progress" })`. The shared library has no `502` factory, so the `502` is `new AppError({ status: 502, code: "email-send-failed", detail })`, without a `cause`. OpenAPI uses `problemResponses(...)`, which accepts `502`.
- `GET /admin/dlq` reads the stream's `state` (`first_seq`, `last_seq`, `messages`) with `jsm.streams.info(DLQ)`, walks sequences from `last_seq` down to `first_seq` with `jsm.streams.getMessage(DLQ, { seq })`, skips sequences that return `null` (deleted), and stops once it has the page. `total` is `state.messages`. A stored message that fails `dlqEntrySchema` is skipped and logged at `warn` with its `seq` only; `GET /admin/dlq/:seq` returns `404` for it, with the same log line. The walk is linear in the number of deleted sequences, which is fine at demo scale.
- `getMessage` uses the JetStream API (`$JS.API.STREAM.MSG.GET`), so the stream needs no `allow_direct`. It returns `null` only for "no message found" (`10037`), which covers deleted sequences and sequences outside the stream, and throws on other errors.
- Replay calls `emailService.send(entry.data.event, log)` directly, bypassing the consumer and inbox, so the marker written at dead-letter time does not block it. On success it deletes the entry with `jsm.streams.deleteMessage(DLQ, seq)` (the client's default `erase: true` overwrites the stored bytes, which suits an entry holding an address) and logs "dlq entry replayed" with `seq` and `eventId`. On `EmailSendError` it throws the `502` and the entry stays. `deleteMessage` throws when the sequence is already gone and returns `false` on an unsuccessful reply; either after a successful send returns `500` and leaves whatever is stored, so a second replay would send again. That case is logged as "dlq entry delete failed" at `error` with `seq`.
- The DLQ service depends on a local `DlqStreams` interface (`streams.info`, `streams.getMessage`, `streams.deleteMessage`, typed with only the fields it reads: `state.first_seq`, `state.last_seq`, `state.messages`, and a stored message's `seq` and `data`), following shared's `StreamManager` and `ConsumerManager`. The `JetStreamManager` from `jetstreamManager(nc)` satisfies it structurally, so `notification` needs no `@nats-io` dependency and the shared library exports no new types. Tests fake it with an in-memory map.

**Startup.** `main.ts` calls `ensureStream(jsm, DLQ_STREAM)` after `PAYMENTS_STREAM` and logs "stream ready" for it. The consumer definitions do not change, so an existing setup logs "consumer ready" with `unchanged` for both. `createApp` gets the DLQ service built from the same `jsm` and the email service.

## Code Evidence

| Behavior | Source |
|---|---|
| `createEventHandler` calls `onEvent(event, log)`, and its catch logs "event handling failed" and calls `msg.nak(NAK_DELAY_MS)` (5000) for any error from `inbox.get` or `onEvent`; a normal return writes the marker and acks. `correlationId` is decoded from the headers before `onEvent` runs | `services/notification/src/consumer/consumer.handler.ts` |
| `ConsumerMessage` has `ack`, `nak(delayMs?)`, `term`, `seq`, `subject`, `data`, `headers`; no delivery info | `services/notification/src/consumer/consumer.handler.ts` |
| `JsMsg.info.deliveryCount: number` (`DeliveryInfo`), parsed from the `$JS.ACK` reply subject; `nak(millis)` sends `-NAK {"delay": nanos(millis)}` | `@nats-io/jetstream` `lib/jsapi_types.d.ts`, `lib/jsmsg.js` |
| `startConsumer` awaits `handle(msg)` before taking the next message | `libs/shared/src/consumers.ts` |
| `EMAIL_CONSUMER` and `INAPP_CONSUMER` are `as const` with no `max_deliver`, `ack_wait` or `backoff` (server defaults: unlimited, 30 s, none) | `services/notification/src/consumer/consumer.config.ts`, `tasks/BE-05-04-email-channel.md` |
| `PAYMENTS_STREAM` and `ensureStream` live in the shared library, which imports `DiscardPolicy`, `RetentionPolicy`, `StorageType` and `nanos` and does not re-export them. `streams.test.ts` exercises `ensureStream` with `PAYMENTS_STREAM` | `libs/shared/src/streams.ts`, `streams.test.ts`, `index.ts` |
| Shared exports `jetstreamManager`, `jetstream` and the `JetStreamClient` type, not `JetStreamManager` or `StoredMsg`; `notification` has no `@nats-io` dependency | `libs/shared/src/index.ts`, `services/notification/package.json` |
| `jsm.streams.getMessage(stream, { seq })` requests `$JS.API.STREAM.MSG.GET` and returns `StoredMsg \| null` (`null` only for API error `10037`); `StoredMsg` has `seq`, `data`, `time`, `header`, `json()`. `deleteMessage(stream, seq, erase = true)` returns the reply's `success` and throws on an API error. Stream info `state` has `first_seq`, `last_seq`, `messages`, `num_deleted` | `@nats-io/jetstream` `lib/jsmstream_api.js`, `lib/types.d.ts`, `lib/jsapi_types.d.ts` |
| `createEvent(type, data)` and `publishEvent(js, subject, event, { correlationId })` (sets `Nats-Msg-Id` to `eventId`, returns the `PubAck`); `eventEnvelopeSchema(dataSchema)` | `libs/shared/src/events.ts`, `libs/shared/src/nats.ts` |
| `EmailSendError` carries only `code`, `command`, `responseCode` and a fixed message; `createEmailService({ from, mailer }).send(event, logger)` resolves to `void` and sets `Message-ID` to `<eventId@payment-simulation.local>`; a refused connection fails with `code: "ESOCKET"` | `services/notification/src/email/email.service.ts`, `tasks/BE-05-04-email-channel.md` |
| `main.ts` builds the email handler with `onEvent: (event, log) => emailService.send(event, log)` and ensures only `PAYMENTS_STREAM` | `services/notification/src/main.ts` |
| `createApp({ checks, docs, jwtSecret, logger, notifications })` is called by `main.ts`, `app.test.ts` and `notification.routes.test.ts` | `services/notification/src/app.ts` and those files |
| `authenticate(secret)` and `requireRole(...roles)` are shared; payment's admin PATCH uses `authenticate` then `requireRole("admin")` per route | `libs/shared/src/auth-middleware.ts`, `services/payment/src/payment/payment.routes.ts` |
| Factories exist for 400, 401, 403, 404, 409, 422, 429 and 503, not 502; `AppError` takes any status. The problem body has only `type`, `title`, `status`, `detail`, `code`, `instance`, `requestId` and `errors`. `problemResponses(...statuses)` takes any status | `libs/shared/src/errors.ts`, `libs/shared/src/openapi.ts` |
| `loadConfig` throws with `z.prettifyError`, which prints each issue's path, so the variable is named | `libs/shared/src/config.ts` |
| Notification routes, paging (`listNotificationsQuerySchema`, `sendPage`) and OpenAPI registration patterns | `services/notification/src/notification/` |
| NATS server in compose is `2.15.1`, monitoring on port 8222; `jsz` needs `accounts=true` to list streams | `compose.yaml`, `tasks/BE-04-01-event-catalogue.md` |
| `pnpm dev` runs each service with `tsx watch --env-file-if-exists=../../.env`; Node does not let an env file override a variable already set, so inline variables win | `package.json`, `services/notification/package.json` |
| README "Events" says a failed send "is redelivered every 5 seconds until it succeeds; bounded retries and a dead-letter queue arrive with BE-05-05 and BE-05-06"; "Install and run" says "emails wait until it is reachable again" | `README.md` |

## Scope

- **Shared library**: `DLQ_STREAM` in `streams.ts`, exported from `index.ts`, with a test in `streams.test.ts` that it has the settings listed above and that `ensureStream` creates it. No other shared change.
- **Config**: `EMAIL_MAX_ATTEMPTS` (`z.coerce.number().int().min(1).max(20).default(5)`) and `EMAIL_RETRY_DELAYS_MS` (a string with the default list, split on `,` and piped into a non-empty array of coerced positive integers, so an issue's path names the variable). Add both to `.env.example`.
- **Consumer**: the `EventContext` third argument, `info.deliveryCount` on `ConsumerMessage`, and `RetryLaterError`. The consumer definitions in `consumer.config.ts` are unchanged.
- **Email**: `email.retry.ts` and `email.channel.ts` as above, exported from `email/index.ts`.
- **DLQ module**: schema, publisher, service, controller, routes, OpenAPI registration, barrel.
- **`app.ts` / `openapi.ts` / `main.ts`**: `createApp` takes the DLQ service (update its callers in `app.test.ts` and `notification.routes.test.ts`); the DLQ routes mount before `notFoundHandler`; startup ensures `DLQ_STREAM`.
- **Tests** (stubs and memory repositories, no NATS; tokens signed with `jose` as in `notification.routes.test.ts`):
  - `email.retry.test.ts`: `retryDelay` for attempts 1 to 4 with the default list, the last delay repeating for a short list; `isPermanent` true for `responseCode` 550 and 554 and for `EENVELOPE`, false for 421, 451, `ESOCKET`, `ETIMEDOUT` and no code.
  - `email.channel.test.ts`:
    - A successful send returns and dead-letters nothing.
    - A retryable failure on attempt 1 throws `RetryLaterError` with 5000; on attempt 4 with 600000.
    - A retryable failure on attempt 5 dead-letters with `reason: "exhausted"`, `attempts: 5` and the correlation ID, and returns; on attempt 7 (after a failed publish, or after deliveries spent on inbox failures) with `attempts: 7`.
    - A permanent failure on attempt 1 dead-letters with `reason: "rejected"` and returns.
    - A failing dead-letter publish logs "dead-letter publish failed" and throws `RetryLaterError` with the last delay, on attempt 5 and again on attempt 12 (no upper limit).
    - An error that is not an `EmailSendError` is rethrown unchanged.
    - `payment.processing` neither sends nor dead-letters.
    - Log lines carry `attempt`, `delayMs` and `code`, never the address.
  - `consumer.handler.test.ts`: `onEvent` receives `{ correlationId, deliveryCount }`; a `RetryLaterError` naks with its delay and logs nothing; another error still naks with `NAK_DELAY_MS` and logs "event handling failed" at `error`; existing tests keep passing with `info: { deliveryCount: 1 }` added to `stubMessage`.
  - `consumer.config.test.ts`: unchanged, and still passes.
  - `dlq.test.ts`: the schema accepts a published entry and rejects a bad `reason` or a non-payment `event`.
  - `dlq.publisher.test.ts`: publishes to `dlq.email` with `Nats-Msg-Id` equal to the entry's `eventId` and the correlation ID header, and returns the ack's `seq`.
  - `dlq.service.test.ts` (a fake `DlqStreams` over an in-memory map): list newest first with paging and `meta`, skipping deleted and malformed sequences; get by `seq`, `404` for unknown and malformed; replay sends, deletes and returns `{ seq, eventId }`; replay `502` keeps the entry and puts the code in `detail`; replay `409` while another replay of that `seq` is pending; replay `500` when delete throws or returns `false`, keeping the entry.
  - `dlq.routes.test.ts` (supertest through `createApp`): `401` without a token and `403` for a user on all three routes; admin list, get and replay happy paths; `400` for `seq=0`, `seq=abc` and an unknown query parameter; `404` for an unknown `seq`; `502` maps to `email-send-failed`.
  - `config.test.ts`: defaults (`5` and `[5000, 30000, 120000, 600000]`); `EMAIL_RETRY_DELAYS_MS=5000,abc`, `EMAIL_RETRY_DELAYS_MS=` and `EMAIL_MAX_ATTEMPTS=0` fail with the variable named.
  - `app.test.ts`: the OpenAPI document lists `/admin/dlq`, `/admin/dlq/{seq}` and `/admin/dlq/{seq}/replay`.
- **README**:
  - "Events", "How the notification service consumes": replace the "redelivered every 5 seconds" sentence with the retry schedule, permanent rejections, the DLQ, and that in-app keeps retrying every 5 s.
  - "Install and run": add `EMAIL_MAX_ATTEMPTS` and `EMAIL_RETRY_DELAYS_MS` to the notification table; change "emails wait until it is reachable again" to the bounded retry; add the `DLQ` stream to the startup paragraph.
  - "API": an "Admin DLQ endpoints" section after "Notification endpoints", with the table, rules (admin only; `seq`; replay sends now and deletes on success; `502` keeps the entry) and `curl` examples using the demo admin.
  - "Errors" table: `409 replay-in-progress` and `502 email-send-failed`.
  - Status note: mention retries and the DLQ.
- **Roadmap**: both the BE-05-05 and BE-05-06 rows link this doc. Set both to `in-progress` when starting and `done` when finished. In the same change as the code, replace the Decisions table's Email failure handling row with:

  ```
  | Email failure handling | Retries use `nak` delays computed by the handler, bounded by the handler's attempt count (no consumer `max_deliver`). On the last attempt or a permanent rejection the handler publishes to a `DLQ` stream, records the event as processed and acks, so JetStream never redelivers it — JetStream has no built-in dead-letter stream |
  ```

## Preserve

- The handler's decode, term, dedupe, marker and ack flow from BE-05-01 to BE-05-04, including ack after a marker write failure.
- The in-app channel: its consumer, 5 s unbounded retry, storage and HTTP API.
- Both consumer definitions in `consumer.config.ts`.
- `EmailSendError`'s allowlist and the rule that the address, subject, bodies, `description` and `failureReason` never reach logs.
- `PAYMENTS_STREAM`, the payment and auth services, and readiness checks (`nats`, `consumers`, `storage`).

## Excluded

- Dead-lettering in-app notifications.
- A consumer `backoff` list or `max_deliver`, or changing `ack_wait`.
- Editing a DLQ entry before replay, bulk replay, purging the DLQ, or a UI.
- Changing `EmailService.send` or the shared problem body.
- Cross-service integration tests against a real NATS (BE-06-03) and DLQ metrics (BE-07-05).
- A readiness check for the `DLQ` stream.

## Likely Files To Touch

- `libs/shared/src/streams.ts`, `streams.test.ts`, `index.ts`
- `services/notification/src/consumer/` (`consumer.handler.ts`, `consumer.handler.test.ts`, `index.ts`)
- `services/notification/src/email/` (new `email.retry.ts`, `email.channel.ts` and tests; `index.ts`)
- `services/notification/src/dlq/` (new)
- `services/notification/src/config/config.ts`, `config.test.ts`
- `services/notification/src/app.ts`, `app.test.ts`, `openapi.ts`, `main.ts`
- `services/notification/src/notification/notification.routes.test.ts` (new `createApp` argument)
- `.env.example`, `README.md`, `ROADMAP.md`

## Prerequisites

BE-05-04 (email channel, `EmailSendError`, delayed nak) is merged to `main` as of commit `9f52798`.

## Decisions Required Before Implementation

None. The four intake decisions and the two review decisions were settled on 2026-10-19 (see Source Context). The listed defaults stand unless changed in this doc.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why dead-lettering acks instead of terms, or why the consumer has no `backoff` or `max_deliver`.
- Never log the recipient address, subject, bodies, `description` or `failureReason`, including from DLQ entries. DLQ list and get never log entries, only `seq`.
- No dependency changes. Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or `compose.yaml`. The only shared-library change is `DLQ_STREAM`.
- Named exports only in each `index.ts`.

## Deliverables

- Bounded, configurable email retries with growing delays, and dead-lettering of exhausted and permanently rejected emails.
- The `DLQ` stream and the admin list, get and replay endpoints, registered in OpenAPI.
- Unit and supertest tests, plus updates to `.env.example`, `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual check against local NATS and Mailpit, with short retries. Make sure no other `pnpm dev` is running (ports 3001 to 3003 free). With the services stopped, run `pnpm infra:reset` and `rm -rf services/payment/data services/notification/data`, then `pnpm infra:up` and start the services with `EMAIL_MAX_ATTEMPTS=3 EMAIL_RETRY_DELAYS_MS=1000,2000 pnpm dev`.
  - `notification` logs "stream ready" for `PAYMENTS` and `DLQ`. `curl -s 'localhost:8222/jsz?accounts=true&streams=true&consumers=true&config=true'` shows the `DLQ` stream, and both `notification-email` and `notification-inapp` with `max_deliver` -1.
  - Log in as the demo user, then `docker compose stop mailpit` and create a payment. The log shows "email send failed, retrying" with `code` `ESOCKET` for attempts 1 and 2 (about 1 s, then 2 s apart), then "email dead-lettered" with `reason: "exhausted"` and `attempt: 3`, for each of the payment's two emails (`payment.created` and its outcome). No "event handling failed" line appears for them. In-app notifications still arrive.
  - Log in as the demo admin. `GET localhost:3003/admin/dlq` lists two entries newest first; `GET /admin/dlq/<seq>` returns one. The same calls with the user's token return `403`.
  - Replay one with Mailpit still stopped: `502 email-send-failed` whose `detail` names `ESOCKET`, and the entry is still listed.
  - `docker compose start mailpit`, then replay both: each returns `200`, the emails appear in Mailpit, and `GET /admin/dlq` is empty with `meta.total` 0.
  - No `notification` log line contains `user@example.com`.
  - Record the results in the PR.
- The permanent-rejection path is covered by unit tests only: Mailpit accepts every recipient by default, and this task does not change `compose.yaml`.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, the BE-05-05 and BE-05-06 rows in `ROADMAP.md` are `done` and link to this file, and the Decisions table's Email failure handling row has the wording under Scope, Roadmap.

## Follow-ups

- BE-06-03: a cross-service integration test that dead-letters and replays against a real NATS.
- BE-07-05: a DLQ size metric (`DLQ` stream `state.messages`).
- If the DLQ ever grows large, keep an index of live sequences instead of walking deleted ones.
