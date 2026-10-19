# BE-04-02: Publish payment lifecycle events through an outbox

**Covers:** BE-04-02
**Status:** done

## Objective

Make the payment service publish one event to the JetStream `PAYMENTS` stream for every status change: `payment.created` when a payment is saved as `pending`, then `payment.processing`, `payment.succeeded`, `payment.failed` and `payment.cancelled`. Each event is built with `createPaymentEvent` and written to an outbox on the payment record, in the same compare-and-set write that changes the payment. An in-process relay publishes outbox entries right after each write, sweeps for leftovers on an interval, and sweeps once at startup, so an event is never lost when NATS is down or the process stops between the write and the publish. Everything ships with unit tests.

## Source Context

Roadmap milestone BE-04-02 ("Payment service publishes lifecycle events (event ID, `userId` + email) through an outbox stored with the payment, republished on startup") in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Relay timing: kick, interval sweep and startup sweep.** A successful write triggers a sweep straight away. A timer sweeps on an interval for anything still waiting, for example after a NATS outage. The first sweep runs at startup and republishes entries left over from the previous run.
- **Correlation ID: the creating request's.** `POST /payments` stores its request ID on the payment as `correlationId`. Events from the background processor (`processing`, `succeeded`, `failed`) reuse it, so one ID traces the whole lifecycle across services. Events from an admin `PATCH /payments/:id/status` carry that PATCH request's own ID.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- The outbox is an optional `outbox` array on the payment record. Absent means empty, so existing data files still load. Each entry is `{ event: PaymentEvent, correlationId?: string }`.
- The event, including its `eventId` and `occurredAt`, is built when the status changes, not when it is published. A republish therefore sends the same `eventId`.
- A new env var `OUTBOX_RELAY_INTERVAL_MS`, default `1000`, minimum `10`.
- Published entries are removed from the outbox, not marked as published. The array stays as `[]` afterwards.
- `outbox` and `correlationId` are internal fields: never in API responses or the OpenAPI spec.

## Design Reference

- `ROADMAP.md`, Decisions table: Inter-service messaging ("Every event has a unique ID, published as `Nats-Msg-Id` for publish-side dedupe; consumers are idempotent"); Persistence ("Updates are compare-and-set on a `version` field. No database or ORM"); Async model ("The processor updates status in-process"); Logging (correlation IDs in event headers).
- `AGENTS.md`, Architecture constraints: payment events carry `userId` and email; pass correlation IDs into event headers and every log line; never log tokens or auth headers; status changes go through the repository's compare-and-set update; shared code such as the NATS client wrapper goes in `libs/shared`. The payment service has no `@nats-io/*` dependency (`services/payment/package.json`), so it reaches JetStream only through `@payment-be/shared` (see the comment above the re-export in `libs/shared/src/streams.ts`).
- `tasks/BE-04-01-event-catalogue.md`, Architecture Summary and Follow-ups: map `pending` to `payment.created` and every other status to `payment.<status>` in the payment service; publish with `publishEvent(js, event.type, event, { correlationId })`; a republish later than 2 minutes after the first gets past publish-side dedupe, so consumers must stay idempotent.
- `README.md`, "Payment flow" and "Events": the target flow already describes these events, and "Events" says publishing arrives with BE-04-02.

## Architecture Summary

```
services/payment/src/payment/
  payment.ts
    paymentFieldsSchema gains   correlationId: z.string().min(1).max(128).optional()
                                outbox: z.array(outboxEntrySchema).optional()
  payment.outbox.ts (new, imports from payment.ts only with `import type`, so payment.ts can import its schema without a runtime cycle)
    outboxEntrySchema           z.object({ event: paymentEventSchema, correlationId: z.string().min(1).max(128).optional() })
    OutboxEntry                 z.infer<typeof outboxEntrySchema>
    toEventType(status) → PaymentEventType     pending → payment.created, otherwise payment.<status>
    outboxEntry(payment: Pick<Payment, "amount" | "currency" | "description" | "email" | "failureReason" | "id" | "status" | "userId">,
                correlationId?) → OutboxEntry
        createPaymentEvent(toEventType(payment.status), { paymentId: id, userId, email, amount, currency,
                           description? (only when set), failureReason? (failed only) })
        no correlationId key when it is undefined
  payment.transition.ts
    transitionPayment(payments, id, to, { failureReason, now, correlationId? })
      patch = statusChange(...)
      next  = { ...payment, ...patch }
      update(id, payment.version, { ...patch,
              outbox: [...(payment.outbox ?? []), outboxEntry(next, correlationId ?? payment.correlationId)] })
      unchanged retry loop: each attempt re-reads, rebuilds the patch and the entry
  payment.service.ts
    createPaymentService(payments, { now?, onOutbox? })
      CreatePaymentInput gains correlationId?: string
      insert: record gains correlationId (from input, only when set) and outbox: [outboxEntry(record, correlationId)]
      create: calls onOutbox() after a new insert only; an idempotent replay adds nothing
      updateStatus(id, body, { correlationId }?) passes it to transitionPayment, then onOutbox()
    toPaymentResponse strips idempotencyKey, version, correlationId and outbox
  payment.schema.ts
    paymentResponseSchema omits correlationId and outbox as well
  payment.controller.ts
    create passes correlationId: String(req.id); updateStatus passes { correlationId: String(req.id) }
    (pino-http types req.id as ReqId = number | string | object; genReqId in logger.ts always returns a string)

services/payment/src/outbox/ (new)
  outbox.relay.ts
    createOutboxRelay({ js, logger, payments, intervalMs }) → { kick, start, stop, sweep }
      sweep: payments.find(p => (p.outbox?.length ?? 0) > 0), oldest createdAt first
        per payment, in outbox order:
          publishEvent(js, entry.event.type, entry.event, { correlationId: entry.correlationId })
          the first failure stops that payment (keeps per-payment order); other payments continue
        remove the published eventIds:
          re-read → update(id, current.version, { outbox: current.outbox without those eventIds })
          VersionConflictError → re-read and try again (3 attempts), so an entry appended meanwhile is kept
          attempts used up → warn `outbox cleanup failed` and leave the entries; the next sweep republishes them
            with the same eventId, which the stream's 2-minute duplicate window drops
        checks the stopped flag before each publish and returns early once stop() was called
      sweeps never overlap; kick() during a sweep schedules one more sweep after it, not one per call
      kick() before start() or after stop() does nothing; start()'s first sweep picks up anything written before it
      start(): first sweep now, then setTimeout after each sweep (same pattern as the processor)
      stop(): no new sweeps (including one a kick scheduled), clears the timer, awaits the running sweep,
              which finishes at most its current publish
  index.ts

services/payment/src/processor/processor.service.ts
  PaymentProcessorOptions gains onOutbox?: () => void, called after each successful transitionPayment

services/payment/src/main.ts
  js = jetstream(nc) after ensureStream
  relay = createOutboxRelay({ js, logger, payments: repository, intervalMs: config.OUTBOX_RELAY_INTERVAL_MS })
  createApp({ ..., onOutbox: relay.kick }); createPaymentProcessor({ ..., onOutbox: relay.kick })
  relay.start() before processor.start()
  onShutdown tasks: [processor.stop, relay.stop, () => drainNats(nc), close]

libs/shared/src/streams.ts
  by-name re-export of jetstream and type JetStreamClient from @nats-io/jetstream, next to jetstreamManager
```

Why the outbox sits on the payment: the repository only offers a compare-and-set update of one record (`libs/shared/src/repository.ts`), with no transaction across collections. Writing the status change and its event in one `update` is the only way to make them succeed or fail together. A separate outbox collection would bring back the gap between "status saved" and "event saved".

`occurredAt` comes from the system clock inside the shared `createEvent` (`libs/shared/src/events.ts`), not from the injected `now`, so it can differ from the payment's `updatedAt` by a few milliseconds. This task does not change the shared contract. Tests assert that `occurredAt` is a valid ISO datetime and never compare it with the injected `now`.

Order: entries are appended in transition order, and the relay stops a payment at its first failed publish, so for one payment `payment.created` always goes out before `payment.processing`. There is no ordering promise across payments.

Delivery is at least once. A crash after a publish but before the outbox write sends the same `eventId` again on the next sweep. Within 2 minutes the stream's duplicate window drops it. Later than that, it is stored twice and BE-05-02 consumers dedupe it.

Removing entries also bumps `version`. That can make a concurrent admin PATCH, processor claim or processor result retry, which `transitionPayment` already does up to 3 times, re-reading each time and rebuilding the entry from the re-read record, so a retried attempt never carries a stale outbox. The processor's in-flight `Payment` snapshot is safe: `charge` reads only `id`, `amount` and `currency`, and `record` writes through `transitionPayment`, which re-reads. The relay's removal does not touch `updatedAt`, because it is not a change to the payment.

While NATS is reconnecting, `js.publish` waits for its own timeout and then rejects. The relay logs a warning and leaves the entry for the next sweep. It never stops the service. Because payments are published one after another, a sweep during an outage can take one publish timeout per waiting payment; that is why the sweep checks the stopped flag before each publish, so shutdown stays inside `onShutdown`'s 10-second timeout.

`correlationId` is bounded to 128 characters, matching `REQUEST_ID_PATTERN` in `libs/shared/src/logger.ts`, which caps the incoming `x-request-id` there. An invalid or missing header gets a UUID instead.

## Code Evidence

| Behavior | Source |
|---|---|
| `Repository.update(id, expectedVersion, patch)` is the only write after insert, compare-and-set on one record; `VersionConflictError` on a stale version | `libs/shared/src/repository.ts` |
| Both adapters drop `undefined` values from a patch, so a key cannot be deleted; set `outbox: []` instead. Both return `structuredClone` copies from `find` and `get`, so the relay's snapshot never changes under it and the removal must re-read | `libs/shared/src/memory-repository.ts:22-30,54-76`, `libs/shared/src/file-repository.ts:384-399` |
| The JSON-file adapter validates every stored record with `z.array(schema)` on load only, not on write, so new fields must be optional to keep existing data files valid, and an invalid stored entry would stop the next startup | `libs/shared/src/file-repository.ts:195-203` |
| `transitionPayment` re-reads, builds the patch with `statusChange`, and retries `VersionConflictError` up to 3 attempts; the payment service and the processor both use it | `services/payment/src/payment/payment.transition.ts`, `payment.service.ts`, `processor/processor.service.ts` |
| `createPaymentService` builds the record in `insert`, runs creates one at a time through `queue`, and returns `replayed: true` without writing for a repeated `Idempotency-Key` | `services/payment/src/payment/payment.service.ts` |
| `toPaymentResponse` strips `idempotencyKey` and `version`; `paymentResponseSchema` is `paymentFieldsSchema.omit({ idempotencyKey, version })` with `.meta({ id: "Payment" })`, and `paymentSchema`'s `failureReason` rule is a `superRefine` on top of `paymentFieldsSchema`, so `.omit` and `.pick` still work on the fields schema | `payment.service.ts:46-52`, `payment.schema.ts:55-57`, `payment.ts:40-71` |
| `statusChange` returns only `status`, `updatedAt` and, for `failed`, `failureReason` | `services/payment/src/payment/payment.status.ts:34-56` |
| The processor claims with `transitionPayment(..., "processing", { now })` and records `succeeded`/`failed` with a `failureReason`; it has no request context. Its tests seed payments with `payments.insert` through an `add` helper, without `correlationId` | `services/payment/src/processor/processor.service.ts:67-153`, `processor.service.test.ts:93-106` |
| `httpLogger`'s `genReqId` returns a valid `x-request-id` header (`^[A-Za-z0-9._-]{1,128}$`) or a new UUID, logged as `correlationId`; pino-http types `req.id` as `ReqId` (`number \| string \| object`) | `libs/shared/src/logger.ts:21,53-61,81,85`, `node_modules/.pnpm/pino-http@11.0.0/node_modules/pino-http/index.d.ts:23,82` |
| `publishEvent(js, subject, event, { correlationId })` publishes with `msgID: event.eventId` and the `x-correlation-id` header; `js` is `Pick<JetStreamClient, "publish">` | `libs/shared/src/nats.ts` |
| `createPaymentEvent(type, data)` validates against `paymentEventSchema` and throws on bad data; `failureReason` only on `payment.failed`; it calls `createEvent`, which sets `eventId` with `randomUUID()` and `occurredAt` with `new Date()` | `libs/shared/src/payment-events.ts:48-53`, `libs/shared/src/events.ts:20-27` |
| `@payment-be/shared` exports `jetstreamManager` but not `jetstream` or `JetStreamClient`; `@nats-io/jetstream` 3.4.0's root entry exports `jetstream(nc, opts?)` (synchronous, returns `JetStreamClient`) and the `JetStreamClient` type; it is a `libs/shared` dependency only | `libs/shared/src/index.ts:114-121`, `libs/shared/src/streams.ts:11-12`, `node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/mod.d.ts`, `jsclient.d.ts:21`, `services/payment/package.json` |
| `main.ts` connects to NATS, runs `ensureStream`, opens the repository, starts the server, then creates and starts the processor, and shuts down with `[processor.stop, () => drainNats(nc), close]` | `services/payment/src/main.ts:32-77` |
| `onShutdown` closes the HTTP server first, then runs the tasks in order, with a 10-second overall timeout | `libs/shared/src/shutdown.ts` |
| ESM tests get Jest's API with `const { jest } = import.meta;`, which provides `jest.fn` and fake timers | `services/payment/src/processor/processor.service.test.ts:19,112,372` |
| `app.test.ts` reads `/docs/openapi.json` from `createApp({ docs: true })` | `services/payment/src/app.test.ts:75` |
| Processor env vars are listed in `.env.example` and in a README table introduced by "The payment processor and simulated gateway ... read these" | `README.md`, "Install and run"; `.env.example` |
| The README startup and shutdown paragraph ("A service stops at startup ...") lists the shutdown steps | `README.md`, "Install and run" |
| README "Events" says the payment service starts publishing in BE-04-02 | `README.md`, "Events" |

## Scope

- **Model**: add optional `correlationId` and `outbox` to `paymentFieldsSchema`. `paymentSchema`'s `failureReason` rule stays as it is. `CreatePaymentInput` gains an optional `correlationId`, and `PaymentService.updateStatus` an optional third argument `{ correlationId?: string }`.
- **`payment.outbox.ts`**: `outboxEntrySchema`, `OutboxEntry`, `toEventType` and `outboxEntry` as above. Export each by name from `payment/index.ts`.
- **Writes**: `create` inserts the `payment.created` entry with the payment. `transitionPayment` appends the entry for the new status in the same `update`. An explicit `correlationId` option wins over the stored one. Idempotent replays write nothing and add no event.
- **Responses**: `toPaymentResponse` and `paymentResponseSchema` leave out `correlationId` and `outbox`. The generated OpenAPI `Payment` schema does not change.
- **Relay**: `services/payment/src/outbox/` with `createOutboxRelay` as above, plus `index.ts` following the barrel rule. `js` is typed `Pick<JetStreamClient, "publish">`, the same as `publishEvent`, so tests pass a stub. Log `event published` at info with `eventId`, `type`, `paymentId` and `correlationId`. Log `event publish failed` at warn with `err`, `eventId` and `paymentId`. Log `outbox cleanup failed` at warn with `paymentId` when the removal runs out of attempts. Log `outbox sweep failed` at error when the sweep itself throws, for example when a repository read fails. Never log `email` or the event data.
- **Kick wiring**: `createPaymentService` and `createPaymentProcessor` take an optional `onOutbox` callback and call it after a write that added an entry. `createApp` takes `onOutbox` and passes it to the service. Tests that leave it out keep working.
- **Config**: `OUTBOX_RELAY_INTERVAL_MS` in `paymentConfigSchema` (integer, minimum `10`, default `1000`) and in `.env.example`.
- **Shared lib**: re-export `jetstream` and `type JetStreamClient` by name from `streams.ts` and `index.ts`.
- **Startup and shutdown**: as in Architecture Summary. The relay is created after `openRepository` and before `createApp`, because both `createApp` and the processor take `relay.kick`. The relay stops after the processor, so no processor write lands after the relay's last sweep, and before `drainNats`, so no publish is in flight while NATS drains. Entries still waiting at shutdown stay in the outbox and the next startup sweep publishes them.
- **Tests** (memory repository; Jest through `const { jest } = import.meta;` as in `processor.service.test.ts`; a hand-written JetStream stub records `publish` calls and can be told to reject; never compare `occurredAt` or `eventId` with fixed values):
  - `payment.test.ts`: a payment without `outbox` or `correlationId` still parses (existing data files); one with a valid outbox entry parses; an entry with an invalid event is rejected.
  - `payment.outbox.test.ts`: `toEventType` for all five statuses; `outboxEntry` builds a valid event with `failureReason` only for `failed` and no `description` key when the payment has none.
  - `payment.transition.test.ts`: each transition appends exactly one entry of the right type to the existing outbox; the entry carries the explicit `correlationId`, else the stored one; a version-conflict retry does not leave a duplicate entry.
  - `payment.service.test.ts`: create stores `correlationId` and one `payment.created` entry and calls `onOutbox`; a replay adds nothing and does not call it; `updateStatus` passes the request's `correlationId`.
  - `payment.routes.test.ts`: create, get and PATCH responses contain neither `outbox` nor `correlationId`; an `x-request-id` sent on create is stored on the payment as `correlationId`; a PATCH with a different `x-request-id` appends an entry carrying the PATCH's ID while the stored `correlationId` stays the creating one.
  - `processor.service.test.ts`: extend the `add` helper so a seeded payment carries `correlationId: "req-1"` (or seed it through `createPaymentService(...).create` with that `correlationId`). A processed payment then gains `payment.processing` and `payment.succeeded` (or `payment.failed` with its reason) entries after the seeded ones, each with `correlationId` `"req-1"`. `onOutbox` is called after each successful transition and not after a skipped claim.
  - `app.test.ts`: the `Payment` schema in `/docs/openapi.json` has no `outbox` or `correlationId` property.
  - `outbox.relay.test.ts`:
    - A sweep publishes each entry in order, with its type as the subject and its `correlationId`, then leaves the outbox empty.
    - A failed publish stops that payment at that entry, keeps it and the entries after it, still publishes other payments, and the next sweep sends it.
    - An entry appended between the publish and the removal (simulated with a concurrent `transitionPayment`) is kept.
    - `start()` publishes entries already in the repository, the startup republish.
    - Several `kick()` calls during a sweep lead to one extra sweep.
    - `stop()` waits for the running sweep, a sweep scheduled by a kick does not run, and no sweep starts afterwards.
    - `stop()` during a sweep with several payments waiting returns after the current publish, without publishing the rest.
    - Removal that keeps hitting `VersionConflictError` gives up after its attempts, logs `outbox cleanup failed`, and the entries are published again on the next sweep.
    - `kick()` before `start()` publishes nothing.
    - A sweep that throws is logged and the timer keeps running.
  - `config.test.ts`: `OUTBOX_RELAY_INTERVAL_MS` default, coercion, and rejection below 10.
- **README**:
  - "Events": replace the "starts publishing in BE-04-02" sentence with how publishing works: outbox on the payment, at-least-once delivery, the correlation-ID rule, and that leftovers are republished at startup and on each interval.
  - Add `OUTBOX_RELAY_INTERVAL_MS` to the env var table in "Install and run", and widen the sentence above it, which today says only the processor and simulated gateway read these.
  - The startup and shutdown paragraph in "Install and run" ("A service stops at startup ..."): add that `payment` publishes waiting events at startup, and that on shutdown it stops the outbox relay after the processor and before draining NATS.
- **Roadmap**: set BE-04-02 to `in-progress` when starting and `done` when finished. Its row links this doc.

## Preserve

- Every HTTP endpoint's request and response shape, status codes, and the OpenAPI spec.
- The transition table, `statusChange`, the `failureReason` rules, and the processor's claim, charge, timeout and resume behavior.
- `transitionPayment`'s 3-attempt retry and its errors.
- Shared event contracts (`paymentEventSchema`, `createPaymentEvent`, `publishEvent`, `PAYMENTS_STREAM`, `ensureStream`) and their tests.
- The auth and notification services.
- Existing payment data files load without migration.

## Excluded

- Consumers, durable consumer config and per-channel dedupe (BE-05-01, BE-05-02).
- The `DLQ` stream (BE-05-06).
- Metrics on outbox size or publish failures (BE-07-05), and a readiness check on the outbox backlog.
- A separate outbox collection, exactly-once publishing, and ordering across payments.
- Backfilling events for payments created before this change. Their next status change publishes normally; earlier changes are not replayed.

## Likely Files To Touch

- `services/payment/src/payment/payment.ts`, `payment.test.ts`, `payment.outbox.ts` and `payment.outbox.test.ts` (new), `payment.transition.ts`, `payment.transition.test.ts`, `payment.service.ts`, `payment.service.test.ts`, `payment.schema.ts`, `payment.controller.ts`, `payment.routes.test.ts`, `index.ts`
- `services/payment/src/outbox/outbox.relay.ts`, `outbox.relay.test.ts`, `index.ts` (new)
- `services/payment/src/processor/processor.service.ts`, `processor.service.test.ts`
- `services/payment/src/app.ts`, `app.test.ts`, `main.ts`, `config/config.ts`, `config/config.test.ts`
- `libs/shared/src/streams.ts`, `libs/shared/src/index.ts`
- `.env.example`, `README.md`, `ROADMAP.md`

## Prerequisites

BE-04-01 (event catalogue, `PAYMENTS` stream) and BE-03-05 (processor) are merged to `main`, at commit `1c60c32`.

## Decisions Required Before Implementation

None. The two decisions were settled during intake on 2026-10-19 (see Source Context). Rejected options:

- Relay timing: kick and startup only (an event that failed during a NATS outage would wait until the next restart); interval and startup only (every event would wait up to one interval).
- Correlation ID: none for processor events (the lifecycle could only be joined up by `paymentId`); a new ID per processor run (would not link back to the creating request).

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why the removal re-reads before writing.
- No dependency changes. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Every status change goes through `transitionPayment`; do not add a second write path that skips the outbox.
- Named exports only in `index.ts` files, keeping the existing alphabetical order.

## Deliverables

- Payment records that carry their pending events, written atomically with each status change.
- An outbox relay that publishes on write, on an interval and at startup, wired into `main.ts` and shutdown.
- Unit and supertest coverage as listed, plus updates to `.env.example`, `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual check against local NATS (`pnpm infra:reset`, then `pnpm infra:up`), recorded in the PR:
  - Run `pnpm dev`, log in as the demo user and `POST /payments` with an `x-request-id` header. Within `GATEWAY_TIMEOUT_MS` (10 seconds by default) the payment log shows `event published` for `payment.created`, `payment.processing` and then `payment.succeeded` or `payment.failed`, each with that ID as `correlationId`. `curl -s 'localhost:8222/jsz?accounts=true&streams=true'` shows `PAYMENTS` with 3 messages per payment.
  - `docker compose stop nats`, create a payment, and see `event publish failed` warnings (each after the client's publish timeout) while the payment still gets `201`. `docker compose start nats`, and within one interval after the reconnect plus any publish still timing out, the waiting events are published. Keep the outage under 2 minutes: `jsz` then still shows 3 messages for that payment, because a timed-out publish that the client sends after reconnecting and its republish share an `eventId` inside the duplicate window.
  - Stop the payment service while NATS is stopped and a payment has entries waiting (visible in `services/payment/data/payments.json` with the default `STORAGE_DRIVER=file` and `DATA_DIR=data`). Shutdown finishes without `shutdown timed out`. Start NATS, then the service (it does not start while NATS is unreachable): the startup sweep publishes them.
  - `GET /payments/:id` shows no `outbox` or `correlationId`.
  - Finish with `pnpm infra:reset` so these test events do not reach BE-05 consumers.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-04-02 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- Known limitation (recorded 2026-10-19 for the README): because the relay stops at a payment's first failed publish, an event NATS rejected for good (an error that repeats on every try, not an outage) would block that payment's later events, retried and logged as `event publish failed` on every sweep. No such error is known, since events are validated before they are stored. A real system would cap attempts per event and dead-letter it.

- BE-05-02: consumers must dedupe by `eventId` per channel, because a republish after the 2-minute window is stored twice.
- BE-06-03: the integration tests should cover a duplicate publish and a NATS outage during publishing.
- BE-06-06: describe the outbox and its at-least-once delivery in the failure-handling section.
- BE-07-05: an outbox-size gauge and a publish-failure counter fit the planned metrics.
