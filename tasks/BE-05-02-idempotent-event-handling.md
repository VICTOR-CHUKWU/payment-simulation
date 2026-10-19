# BE-05-02: Idempotent event handling, deduped per channel

**Covers:** BE-05-02
**Status:** done

## Objective

Make each notification channel process a payment event at most once per successful run, however often JetStream delivers it. The notification service gets an `inbox` store of processed markers keyed by channel and event ID. A handler skips an event its channel has already processed, and records a marker only after the channel's work succeeds. The in-app and email channels dedupe independently, so one channel's marker never hides the event from the other. Markers survive restarts. Everything ships with unit tests.

## Source Context

Roadmap milestone BE-05-02 ("Idempotent event handling, deduped per channel (`eventId` + channel)") in `ROADMAP.md`. It is on the AGENTS.md list of milestones that need an approved task doc. Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Marker timing: after success (at least once).** The handler runs the channel's work (`onEvent`) first and writes the marker afterwards. A crash between the two makes a redelivery run the work again, so the channel's own side effect must tolerate that: BE-05-03 can make its insert idempotent, and BE-05-04 accepts a rare duplicate email. Nothing is ever lost. Rejected: claiming first (a crash loses the notification for good) and a two-phase `processing`/`done` claim (extra states and a staleness timeout for little gain).
- **Store: a repository file.** Opened with `openRepository`, so `STORAGE_DRIVER=file` (the default) keeps it in `services/notification/data/inbox.json` and `memory` keeps it in memory. It must survive restarts, because a newly created consumer replays up to 7 days of the stream and the outbox can republish after the 2-minute publish dedupe window. Rejected: in-memory only (every restart forgets what was processed).
- **No pruning now.** The stream keeps events for 7 days, so older markers can never match a redelivery, but the file only grows by about two small records per event. `Repository` has no `delete`, and adding one widens the shared contract for a scale problem the demo does not have. Recorded as a follow-up.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- Module name `inbox` (the counterpart of the payment service's outbox) and file `inbox.json`.
- A duplicate is logged at `info` as "duplicate skipped", so a replay is visible in the logs.
- No new env vars beyond the shared `STORAGE_DRIVER` and `DATA_DIR`.

## Design Reference

- `AGENTS.md`, Architecture constraints: "Every event carries a unique ID, and consumers must be idempotent: JetStream can deliver the same message more than once. Dedupe per channel (`eventId` + channel), never by event ID alone, so an email retry is not dropped once the in-app notification exists." Also: each service owns its data through a repository interface; Zod at the boundary.
- `ROADMAP.md`, Decisions table: Inter-service messaging ("consumers are idempotent"); Persistence ("Generic repository interface … in-memory and JSON-file adapters, selected by env var (each service owns its data)").
- `tasks/BE-05-01-notification-consumers.md`, Follow-ups: "BE-05-02: dedupe per `eventId` + channel inside each handler, before any side effect. Replays from `deliver_policy: all` and outbox republishes after the 2-minute window both reach this point."
- `tasks/BE-04-02-payment-event-outbox.md`: delivery is at least once; a republish later than 2 minutes after the first publish is stored twice.
- `tasks/BE-01-08-json-file-adapter.md`: the file adapter takes a lock per file (single writer per file) and writes atomically.

## Architecture Summary

```
services/notification/src/
  inbox/
    inbox.ts          CHANNELS = ["inapp", "email"] as const, Channel   (moved here from consumer/consumer.config.ts)
                      inboxRecordSchema = z.strictObject({ id, channel, eventId, type, processedAt, version })
                      InboxRecord = z.infer<...>
                      inboxId(channel, eventId) → `${channel}:${eventId}`
    index.ts
  consumer/
    consumer.handler.ts
      createEventHandler({ channel, inbox, logger, onEvent })
        decode with paymentEventSchema ── invalid ──► term                                 (unchanged)
        inbox.get(inboxId(channel, eventId)) ── found ──► ack, info "duplicate skipped"
        log "event received" → await onEvent(event, log)
        inbox.insert({ id, channel, eventId, type, processedAt })
            DuplicateRecordError ──► ack, info "duplicate skipped"
            any other insert error ──► ack, error "marker write failed"
        ack
        error from get or onEvent ──► nak, error "event handling failed"                   (unchanged)
  config/config.ts    notificationConfigSchema gains storageConfigSchema.shape
  main.ts
    openRepository({ config, logger, name: "inbox", schema: inboxRecordSchema }) before the consumers start
    createEventHandler({ channel, inbox: repository, logger })
    checks: [natsCheck(nc), consumersCheck(consumers), check]
    onShutdown tasks: [stop in-app, stop email, drainNats, close]
```

`inboxRecordSchema` fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | `<channel>:<eventId>` |
| `channel` | `"inapp"` \| `"email"` | `z.enum(CHANNELS)` |
| `eventId` | UUID | from the event |
| `type` | non-empty string | for inspection only. Deliberately not `z.enum(PAYMENT_EVENT_TYPES)`: the file adapter validates every record on load, so removing a type from the catalogue would stop `notification` from starting |
| `processedAt` | ISO datetime | when the marker was written |
| `version` | positive integer | set by the repository |

The marker holds no `userId`, email or payload. It records only that a channel finished an event.

Each consumer handles one message at a time (`startConsumer` awaits each handler), and the two channels write different IDs. So the only way two handlers race on one ID is a second notification process on the same durable consumer, and the file adapter's lock already stops a second process from opening `inbox.json`. `insert`'s `DuplicateRecordError` still covers the race as a safety net. `get` reads from memory in both adapters, so the extra lookup per message costs nothing.

A failed `insert` (other than `DuplicateRecordError`) after a successful `onEvent` acks the message and logs "marker write failed" at `error`. The work is already done, so acking keeps handling at least once. A nak would redeliver immediately, with no delay and no `max_deliver` limit until BE-05-05, re-running `onEvent` in a tight loop for as long as the disk is unwritable. Once BE-05-04 lands, that loop would send an email each time. The `storage` readiness check already reports the unwritable disk. The only cost of acking is that a later replay of that event (a recreated consumer, or an outbox republish) runs `onEvent` again.

A redelivery that arrives while an earlier delivery is still in flight, for example after the 30 s `ack_wait` expires during a slow `onEvent`, waits in the client buffer behind the running handler. When it runs, `get` finds the marker and the handler acks it as a duplicate.

Imports run one way, from `consumer/` to `inbox/`, as in the payment service, where `outbox/` and `processor/` import from `payment/index.js`. The schema needs `CHANNELS` as a runtime value for `z.enum`, and the handler needs `inboxId` and `InboxRecord`, so importing in both directions would make the two barrels a runtime cycle. Biome's `noImportCycles` is off in the preset, so nothing would flag it. Therefore:

- `CHANNELS` and `Channel` move from `consumer/consumer.config.ts` to `inbox/inbox.ts` and are exported from `inbox/index.ts`.
- `consumer.config.ts` and `consumer.handler.ts` import them from `../inbox/index.js`.
- `consumer/index.ts` keeps re-exporting `CHANNELS` and `Channel`, so `main.ts` and existing tests import them unchanged.
- `inbox/` imports nothing from `consumer/`.

## Code Evidence

| Behavior | Source |
|---|---|
| `createEventHandler({ channel, logger, onEvent })` decodes, terms on invalid input, logs "event received", awaits `onEvent` (no-op default), acks, and naks on any later error | `services/notification/src/consumer/consumer.handler.ts` |
| `CHANNELS = ["inapp", "email"]`, `Channel`, `CHANNEL_CONSUMERS`; no `ack_wait` is set, so the server default of 30 s applies | `services/notification/src/consumer/consumer.config.ts` |
| `startConsumer` awaits `handle(msg)` for each message in turn | `libs/shared/src/consumers.ts` |
| `notificationConfigSchema` extends base and JWT config only, with no storage settings | `services/notification/src/config/config.ts` |
| `paymentConfigSchema` extends `storageConfigSchema.shape`; payment's `main.ts` opens its repository with `openRepository` and closes it as the last shutdown task, after `drainNats` | `services/payment/src/config/config.ts`, `services/payment/src/main.ts` |
| `Repository<T>` has `find`, `findOne`, `findOneBy`, `get`, `insert`, `update`, and no `delete` | `libs/shared/src/repository.ts` |
| `insert` throws `DuplicateRecordError` for an existing ID and stores `version: 1`, in both adapters | `libs/shared/src/memory-repository.ts`, `libs/shared/src/file-repository.ts` |
| `openRepository({ config, logger, name, schema })` returns `{ check, close, repository }`, with a memory adapter for `STORAGE_DRIVER=memory` and the file adapter otherwise; both checks are named `storage`; names must match `^[a-z][a-z0-9-]*$` | `libs/shared/src/storage.ts` |
| The file adapter validates every record against the schema on load, takes a per-file lock holding the process ID (taking over a lock left by a dead process with a "taking over a stale lock" warning), reads `get` from memory, and `close` waits for queued writes before removing the lock | `libs/shared/src/file-repository.ts` |
| `storage.test.ts` opens a file repository in an `mkdtemp` directory | `libs/shared/src/storage.test.ts` |
| Under `pnpm dev`, pnpm 11.21.0 delivers one Ctrl+C twice and the second SIGINT force-exits, skipping shutdown tasks, so a lock file can be left behind | `tasks/BE-01-08-json-file-adapter.md` (Code Evidence) |
| `services/*/data/` is git-ignored | `.gitignore` |
| README "Storage and demo accounts" lists each service's data file; "Health checks" lists readiness checks; "Events" describes how notification consumes | `README.md` |

## Scope

- **`inbox/` module**: `CHANNELS`, `Channel`, the schema, type and `inboxId` helper above, with an `index.ts` barrel.
- **`consumer/`**: import `CHANNELS` and `Channel` from `../inbox/index.js` and keep re-exporting them from `consumer/index.ts`.
- **Handler**: takes `inbox: Pick<Repository<InboxRecord>, "get" | "insert">` (so failing stubs need no casts) and follows the flow above. A duplicate never calls `onEvent`. The "duplicate skipped" line goes on the existing child logger with `channel` and `type`. The term path and the existing log fields stay as they are.
- **Config**: `notificationConfigSchema` extends `storageConfigSchema.shape`, keeping the JWT transform.
- **`main.ts`**: open the inbox before starting the consumers and pass it to both handlers. Add its `check` to readiness, and close it as the last shutdown task, after `drainNats`. A failure to open it (an invalid or locked file) falls into the existing `catch`, which logs "startup failed" and exits 1.
- **Tests** (hand-written stubs, `createMemoryRepository` for the inbox, logs captured through a pino destination stream as in `consumer.handler.test.ts`):
  - `inbox.test.ts`:
    - `inboxId` format.
    - The schema accepts a valid record and rejects an unknown channel, a non-UUID `eventId`, an empty `type` and an unknown key.
    - Restart persistence: through `openRepository` with `STORAGE_DRIVER=file` in an `mkdtemp` directory (as in `libs/shared/src/storage.test.ts`), a record written by `insert` is returned by `get` after closing and reopening.
  - `consumer.handler.test.ts`:
    - The first delivery runs `onEvent`, writes one marker with the expected fields, and acks.
    - A second delivery of the same event on the same channel acks without calling `onEvent` and logs "duplicate skipped".
    - The same event handled by the other channel's handler (sharing one inbox) still runs `onEvent`, leaving two markers.
    - A failing `onEvent` naks and writes no marker, so the next delivery runs `onEvent` again.
    - A failing `insert` after `onEvent` acks, logs "marker write failed" at `error`, and does not nak.
    - An `insert` that throws `DuplicateRecordError` acks, logs "duplicate skipped", and does not nak.
    - A failing `get` naks without calling `onEvent`.
    - An invalid message is still terminated and writes no marker.
    - Existing tests keep passing, updated only to pass an inbox.
  - `config.test.ts`: the storage defaults (`STORAGE_DRIVER=file`, `DATA_DIR=data`) apply.
- **README**:
  - "Storage and demo accounts": `notification` stores processed markers in `services/notification/data/inbox.json`.
  - "Events", "How the notification service consumes":
    - Change the bullet "A valid event is logged and acked" so that a duplicate is acked without running the handler.
    - Add that each channel records an event as processed only after its work succeeds and skips it on any later delivery, that the two channels track this separately, and that handling is at least once: a crash before the marker is written processes the event again.
  - "Health checks": change "`notification` reports `nats` and `consumers`" to "`nats`, `consumers` and `storage`".
  - "Install and run", startup and shutdown paragraph: change "(for `auth` and `payment`) its data file" to "(for `auth`, `payment` and `notification`)", and "closes its storage (auth and payment)" to "(auth, payment and notification)".
- **Roadmap**: link this doc from the BE-05-02 row. Set it to `in-progress` when starting and `done` when finished.

## Preserve

- The consumer definitions, `startConsumer`, `ensureConsumer`, the term rule for invalid messages and the log fields from BE-05-01.
- `createEventHandler`'s `onEvent` contract: it runs once per non-duplicate delivery, and a throw naks.
- The exported names `CHANNELS` and `Channel` from `consumer/index.ts`, even though they now live in `inbox/`.
- The shared repository contract and both adapters stay unchanged.
- The payment and auth services, and the notification HTTP surface and OpenAPI document, stay unchanged.

## Excluded

- Pruning markers, or adding `delete` to `Repository` (follow-up).
- In-app notification storage and its API (BE-05-03), and email sending (BE-05-04).
- Nak delays, `max_deliver` and backoff (BE-05-05), and the DLQ (BE-05-06).
- Exactly-once side effects. Each channel makes its own side effect tolerate a re-run.

## Likely Files To Touch

- `services/notification/src/inbox/` (new: `inbox.ts`, `inbox.test.ts`, `index.ts`)
- `services/notification/src/consumer/consumer.handler.ts`, `consumer.handler.test.ts`, `consumer.config.ts`, `index.ts`
- `services/notification/src/config/config.ts`, `config.test.ts`
- `services/notification/src/main.ts`
- `README.md`, `ROADMAP.md`

## Prerequisites

BE-05-01 (consumers and handler) and BE-01-08 (file adapter, `openRepository`) are merged to `main`, as of commit `2c957b6`.

## Decisions Required Before Implementation

None. The three decisions were settled during intake on 2026-10-19 (see Source Context).

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why the marker is written after `onEvent`.
- No dependency changes. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- The marker never stores the email, `userId` or payload.
- Named exports only in each `index.ts`.

## Deliverables

- The `inbox` store and per-channel dedupe in the event handler.
- Storage config, readiness and shutdown wiring in the notification service.
- Unit tests, plus updates to `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual check against local NATS. Only one notification process can run, because the inbox file lock allows one:
  - **Start clean**, so the stream holds no events from earlier testing that lack a marker: stop any running `pnpm dev`, then `pnpm infra:reset`, `rm -rf services/notification/data` and `pnpm infra:up`.
  - **Run `notification` on its own** so it can be restarted alone. In one terminal run `pnpm --filter ./services/auth --filter ./services/payment --parallel dev`; in another run `pnpm --filter @payment-be/notification dev`.
  - **Create events.** `POST /payments` a few times as the demo user, and wait until each payment is `succeeded` or `failed` (`GET /payments/:id`). `services/notification/data/inbox.json` gains one `inapp:<eventId>` and one `email:<eventId>` record per event, with no email or `userId` in them.
  - `curl -s localhost:3003/health/ready` returns `200` with `nats`, `consumers` and `storage` as `ok`.
  - **Replay.** Stop `notification` with Ctrl+C. Delete both durable consumers. No `nats` CLI is installed and the monitoring port is read-only, so use nats-box on the compose network, pinning a current tag:

    ```sh
    docker run --rm --network payment-be_default natsio/nats-box:0.18.0 nats -s nats://nats:4222 consumer rm PAYMENTS notification-inapp -f
    docker run --rm --network payment-be_default natsio/nats-box:0.18.0 nats -s nats://nats:4222 consumer rm PAYMENTS notification-email -f
    ```

    `curl -s 'localhost:8222/jsz?accounts=true&streams=true&consumers=true'` then lists no consumers on `PAYMENTS`.
  - Start `notification` again. It logs "consumer ready" with `created` for both. Every replayed event logs "duplicate skipped" on both channels, and no "event received" appears after the restart.
  - A "taking over a stale lock" warning on that restart is expected: pnpm delivers Ctrl+C twice and the second SIGINT skips `close` (see Code Evidence).
  - Record the results in the PR.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-05-02 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-05-03: plug in-app storage into `onEvent` and make its insert tolerate a re-run, for example with an ID derived from the event ID, so a crash before the marker is written does not create two notifications.
- BE-05-04: plug email sending into `onEvent`. A crash between sending and the marker sends the email again, which the at-least-once choice accepts.
- BE-05-05: on email's last delivery attempt, publish to the DLQ and write the marker (or term), so the DLQ replay is the only way it runs again.
- Pruning: add `delete` to `Repository` and drop markers older than the stream's 7-day `max_age`, if the file ever grows enough to matter.
