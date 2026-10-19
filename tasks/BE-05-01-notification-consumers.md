# BE-05-01: Notification service durable consumers

**Covers:** BE-05-01
**Status:** done

## Objective

Give the notification service two durable JetStream consumers on the `PAYMENTS` stream: one for in-app notifications and one for email. Each reads every payment event, validates it, logs it and acks it. Nothing is stored and no email is sent yet. That arrives with BE-05-02 to BE-05-04. `libs/shared` gets two generic helpers. `ensureConsumer` creates or updates a durable consumer at startup, the way `ensureStream` does for streams. `startConsumer` runs a pull loop that can be stopped cleanly. Readiness fails if a loop has stopped, and shutdown stops both loops before draining NATS. Everything ships with unit tests.

## Source Context

Roadmap milestone BE-05-01 ("Notification service scaffold with separate durable consumers for in-app and email") in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Filters: both consumers on `payment.>`.** Both channels see all five event types for now. BE-05-03 and BE-05-04 narrow the filters once they decide which events produce a notification, and `ensureConsumer` applies the change as an update.
- **Start point: `deliver_policy: all`.** A consumer created for the first time reads the whole stream, so no event is lost if `payment` publishes before `notification` first starts. The cost is that a new consumer replays up to 7 days of stored events. That is harmless while handlers only log, and from BE-05-02 the per-channel dedupe absorbs it.
- **Handler: parse, log, ack.** Each handler validates the message with `paymentEventSchema`, logs it and acks it. A message that fails validation is terminated with a warning log, and a handler error naks the message so it is redelivered.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- Durable names `notification-inapp` and `notification-email`, both pull consumers with `ack_policy: explicit`.
- `ack_wait`, `max_deliver` and `backoff` stay at server defaults (30 s, unlimited, none). BE-05-05 sets bounded retries for email.
- No env vars. Consumer names and settings are constants in the notification service.
- One readiness check, named `consumers`, covering both loops.

## Design Reference

- `ROADMAP.md`, Decisions table: Inter-service messaging ("durable streams, durable consumers, ack/redelivery … consumers are idempotent"); Notifications ("In-app … and email …, each on its own durable consumer"); Email failure handling (bounded `max_deliver` and backoff, which BE-05-05 adds); Validation (Zod for event payloads); Logging (correlation IDs from event headers).
- `AGENTS.md`, Architecture constraints: shared NATS code goes in `libs/shared`; consumers must be idempotent and dedupe per channel (BE-05-02); never log tokens or auth headers. Code style: folders with an `index.ts` barrel, `<module>.<role>.ts` naming, tests next to the file they cover.
- `tasks/BE-04-01-event-catalogue.md`, Follow-ups: "BE-05-01: create the durable consumers on `PAYMENTS` and filter by the type subjects each channel needs." The `ensureStream` design (compare only the fields the config sets, rethrow on refusal) is the model for `ensureConsumer`.
- `tasks/BE-01-05-structured-logging.md`, Follow-ups: "BE-05-01: consumer handlers log through `logger.child({ correlationId, eventId, userId })`, taken from `parseEvent` and the payload. Never log `data.email`."
- `tasks/BE-01-06-error-model.md`, Follow-ups: consumers handle parse failures separately (term, not retry); the HTTP error middleware does not apply.
- `tasks/BE-04-02-payment-event-outbox.md`: delivery is at least once, so a republish later than 2 minutes after the first publish is stored twice.

## Architecture Summary

```
libs/shared/src/
  consumers.ts
    ensureConsumer(jsm, stream, config) → Promise<"created" | "updated" | "unchanged">
      config: Partial<ConsumerConfig> & { durable_name: string }
      consumers.info(stream, durable_name)
        JetStreamApiError code 10014 (JetStreamApiCodes.ConsumerNotFound) → consumers.add(stream, config) → "created"
        differs on any field in config → consumers.update(stream, durable_name, config) → "updated"
        matches → "unchanged"
        any other error → rethrow
    startConsumer({ js, stream, durable, handle, logger }) → Promise<RunningConsumer>
      consumer = await js.consumers.get(stream, durable)
      messages = await consumer.consume()
      loop: for await (msg of messages) await handle(msg)
      RunningConsumer { running(): boolean; stop(): Promise<void> }
        stop(): messages.close(), then wait for the loop, so the message in hand finishes
        running(): false once the loop has ended for any reason
    AckPolicy, DeliverPolicy re-exported by name from @nats-io/jetstream; type JsMsg re-exported

services/notification/src/
  consumer/
    consumer.config.ts     INAPP_CONSUMER, EMAIL_CONSUMER definitions (durable_name, filter_subject "payment.>",
                           ack_policy explicit, deliver_policy all)
    consumer.handler.ts    createEventHandler({ channel, logger }) → (msg: JsMsg) => Promise<void>
    consumer.check.ts      consumersCheck(consumers) → ReadinessCheck named "consumers"
    index.ts
  main.ts
    nc → ensureStream → ensureConsumer × 2 → startConsumer × 2 → listen(createApp({ checks: [natsCheck(nc), consumersCheck(...)] }))
    onShutdown tasks: [stop in-app, stop email, drainNats]
```

Handler behaviour for each message:

| Case | Action | Log |
|---|---|---|
| Valid event | `msg.ack()` | `info` "event received" with `channel`, `type`, `paymentId` on `logger.child({ correlationId, eventId, userId })` |
| Invalid JSON or schema mismatch | `msg.term()` | `warn` "invalid event terminated" with `channel`, `subject`, `seq` and the Zod issue paths, not the payload |
| Handler throws after parsing | `msg.nak()` | `error` "event handling failed" with `err` on the child logger |

`createEventHandler` also takes an optional `onEvent(event, logger)` callback, a no-op by default, which runs after logging and before the ack. BE-05-02 to BE-05-04 plug storage and email into it, and the nak test uses it to throw.

Parse with `paymentEventSchema` (not `eventEnvelopeSchema(paymentEventDataSchema)`), because only the full schema checks `type` against the catalogue and enforces the `failureReason` rule. `parseEvent(msg, dataSchema)` validates only the envelope plus data, so either extend it to accept a full event schema or decode the message and read `CORRELATION_ID_HEADER` in the handler. Pick whichever keeps `parseEvent`'s existing callers and tests unchanged. Implemented as `decodeEvent(msg, schema)` in `nats.ts`, exported from the shared lib; `parseEvent` now delegates to it with the envelope schema. The log never includes `data.email`, `data.description` or the raw payload.

`ensureConsumer` equality works the same as `ensureStream`'s: for each key the config sets, compare it with `info.config[key]`, scalars with `===` and arrays element by element. `AckPolicy.Explicit` and `DeliverPolicy.All` are the strings `"explicit"` and `"all"`, so they compare directly. NATS refuses some consumer updates, such as changing `deliver_policy` or `durable_name` on an existing consumer. `ensureConsumer` does not work around that: the error propagates and startup fails with the server's message, as with streams. `pnpm infra:reset` clears it locally.

Generalise `ensureStream`'s private `sameValue` and `matches` helpers so both functions share them, rather than copying them. `ensureStream`'s behaviour and tests must stay the same.

`consume()` in `@nats-io/jetstream` 3.4.0 keeps pulling across reconnects and reports problems through `messages.status()` rather than ending the iterator. The loop ends when `close()` is called, or when the iterator ends or throws, for example when the connection closes for good. A deleted or missing consumer does not end it: the client reports `consumer_deleted` or `consumer_not_found` and keeps retrying, so readiness stays `ok` and the warning log is the signal. Log `status()` notifications of type `heartbeats_missed`, `consumer_not_found` and `consumer_deleted` at `warn` so a broken consumer shows up in the logs. `running()` covers the case where the loop has ended. If a handler throws past the handler's own catch, `startConsumer` logs it and keeps the loop going; it must not end the loop on one bad message.

## Code Evidence

| Behavior | Source |
|---|---|
| Notification `main.ts` connects to NATS, runs `ensureStream(…, PAYMENTS_STREAM)`, serves health and docs, and on shutdown only drains NATS. No consumers exist | `services/notification/src/main.ts` |
| `createApp({ checks, docs, logger })` takes readiness checks as a list | `services/notification/src/app.ts` |
| `ensureStream(jsm, config)` uses a narrow `StreamManager` type, detects `StreamNotFound` by `JetStreamApiError.code`, and compares only the fields it sets with private `sameValue` and `matches` helpers | `libs/shared/src/streams.ts` |
| `PAYMENTS_STREAM` captures `payment.>`, keeps file storage with limits retention for 7 days, and has a 2-minute `duplicate_window` | `libs/shared/src/streams.ts` |
| `parseEvent(msg, dataSchema)` validates with `eventEnvelopeSchema(dataSchema)` and reads `x-correlation-id`; it throws `SyntaxError` or `ZodError` on bad input | `libs/shared/src/nats.ts` |
| `paymentEventSchema` is the envelope plus `type: z.enum(PAYMENT_EVENT_TYPES)` and the `failureReason` refinement; `data` carries `paymentId`, `userId`, `email`, `amount`, `currency` | `libs/shared/src/payment-events.ts` |
| `ConsumerAPI`: `info(stream, consumer)`, `add(stream, cfg: Partial<ConsumerConfig>)`, `update(stream, durable, cfg: Partial<ConsumerUpdateConfig>)`; `Consumer.consume()` returns `ConsumerMessages` (async iterator with `close()`, `closed()`, `status()`); `JsMsg` has `ack()`, `nak(millis?)`, `term(reason?)`, `working()`; `JetStreamApiCodes.ConsumerNotFound` is `10014`; `AckPolicy`, `DeliverPolicy`, `JsMsg` are exported from the root entry | `node_modules/.pnpm/@nats-io+jetstream@3.4.0/.../lib/types.d.ts`, `jsmsg.d.ts`, `jserrors.d.ts`, `mod.d.ts` |
| `ReadinessCheck` is `{ name, check }`; `natsCheck(nc)` is the existing NATS check | `libs/shared/src/health.ts` |
| `onShutdown` closes the HTTP server, then runs `tasks` in order | `libs/shared/src/shutdown.ts` |
| Only `libs/shared` depends on `@nats-io/jetstream`; services get JetStream only through the shared lib | `libs/shared/package.json`, `services/notification/package.json`, `streams.ts` re-export comment |
| README "Events" describes the stream and publishing; "Install and run" describes startup and shutdown; "Health checks" lists readiness checks per service | `README.md` |

## Scope

- **`libs/shared/src/consumers.ts`**: `ensureConsumer`, `startConsumer`, the `RunningConsumer` type, and by-name re-exports of `AckPolicy`, `DeliverPolicy` and `type JsMsg`. Type `jsm` and `js` with narrow local types that the real clients satisfy, so tests pass hand-written stubs without casts, as `StreamManager` does. Export each by name from `libs/shared/src/index.ts`.
- **`libs/shared/src/streams.ts`**: move the comparison helpers somewhere both files can use them. No behaviour change.
- **Event parsing**: validate with `paymentEventSchema` as described above, without changing `parseEvent`'s current signature or behaviour for existing callers.
- **`services/notification/src/consumer/`**: the two consumer definitions, the handler factory (one per channel, labelled with `channel: "inapp" | "email"`), and the `consumers` readiness check, with an `index.ts` barrel.
- **`services/notification/src/main.ts`**:
  - After `ensureStream`, run `ensureConsumer` for both definitions and log each result once ("consumer ready" with `consumer` and `result`).
  - Start both loops before `listen`, add the readiness check, and pass both `stop` functions to `onShutdown` ahead of `drainNats`.
  - A failure in any of these steps falls into the existing `catch`, which logs "startup failed" and exits 1.
- **Tests** (stubs written by hand, not `jest.fn`, as in `nats.test.ts` and `streams.test.ts`; stub errors are `new JetStreamApiError({ code, description, err_code })`):
  - `consumers.test.ts`:
    - A missing consumer is created.
    - A matching consumer returns `unchanged` without calling `update`, including when the server reports extra fields.
    - A consumer that differs (e.g. in `filter_subject`) is updated.
    - Any other `info`, `add` or `update` error is rethrown.
    - `startConsumer` passes each message to `handle` in order.
    - `stop()` closes the messages and resolves only after the message in hand finishes.
    - `running()` turns false when the iterator ends or throws.
    - A `handle` that throws is logged and the loop continues.
  - `streams.test.ts` still passes unchanged.
  - `consumer.handler.test.ts`:
    - A valid event of each type is acked.
    - Invalid JSON, an unknown `type`, a bad `data` field and a `payment.failed` without `failureReason` are each terminated, not acked or nak'd.
    - A thrown error after parsing is nak'd.
    - Log output (captured through a pino destination stream) carries `correlationId`, `eventId` and `userId` and never contains the email address.
  - `consumer.config.test.ts`: both definitions have distinct durable names, `filter_subject: "payment.>"`, explicit ack and `deliver_policy: all`.
  - `consumer.check.test.ts`: the check passes when both loops run and fails when either has stopped.
- **README**:
  - Under "Events", add a short "How the notification service consumes" list. Name both durable consumers and their filter, explain that a new consumer reads from the start of the stream, and describe the ack, term and nak rules. Note that storing notifications and sending email arrive with BE-05-03 and BE-05-04.
  - Extend the startup and shutdown paragraph in "Install and run": `notification` creates or updates its two consumers on start and stops their loops before draining NATS.
  - In "Health checks", add that `notification` reports `nats` and `consumers`.
- **Roadmap**: link this doc from the BE-05-01 row. Set it to `in-progress` when starting and `done` when finished.

## Preserve

- `ensureStream`, `PAYMENTS_STREAM`, `publishEvent`, `parseEvent`, `CORRELATION_ID_HEADER`, the event catalogue and their tests stay unchanged in behaviour.
- The payment and auth services stay unchanged.
- The notification HTTP surface (health and docs) and its OpenAPI document stay unchanged. There are no new endpoints.
- `createApp`'s signature stays as it is: the new check is just another entry in `checks`.

## Excluded

- Dedupe by `eventId` + channel and any notification storage (BE-05-02, BE-05-03).
- `GET /notifications`, marking notifications as read, and which events become in-app notifications (BE-05-03).
- SMTP, templates, the SMTP readiness check, and which events send email (BE-05-04).
- `max_deliver`, `backoff`, `ack_wait` tuning and retry env vars (BE-05-05).
- The `DLQ` stream and replay (BE-05-06).
- Env vars for consumer names or settings, and metrics.

## Likely Files To Touch

- `libs/shared/src/consumers.ts`, `consumers.test.ts` (new)
- `libs/shared/src/jetstream-helpers.ts` (new: `isApiError` and `matchesConfig`, shared by streams and consumers)
- `libs/shared/src/streams.ts`, `libs/shared/src/nats.ts`, `nats.test.ts`, `libs/shared/src/index.ts`
- `services/notification/src/consumer/` (new: `consumer.config.ts`, `consumer.handler.ts`, `consumer.check.ts`, `index.ts` and their tests)
- `services/notification/src/main.ts`
- `README.md`, `ROADMAP.md`

## Prerequisites

BE-04-01 (catalogue, `PAYMENTS` stream) and BE-04-02 (outbox publishing) are merged to `main`, as of commit `5b9f11b`.

## Decisions Required Before Implementation

None. The three decisions were settled during intake on 2026-10-19 (see Source Context). Rejected options:

- Filters: choosing per-channel subjects now (for example, email only on succeeded, failed and cancelled). That would pull a BE-05-03/04 decision into the scaffold.
- Start point: `deliver_policy: new`. Events published before the consumer first existed would be skipped for good.
- Handler: ack without parsing. The term and nak rules would then have no proof until BE-05-02.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why `stop()` waits for the loop or why status notifications are logged.
- No dependency changes. `@nats-io/jetstream` is already a `libs/shared` dependency, and the notification service must not import it directly. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Named exports only in each `index.ts`, keeping the existing alphabetical grouping.
- Never log `data.email`, the raw message body, tokens or headers other than the correlation ID.

## Deliverables

- `ensureConsumer` and `startConsumer` in `@payment-be/shared`.
- Two durable consumers in the notification service that validate, log and ack every payment event, with a readiness check and a clean shutdown.
- Unit tests, plus updates to `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual check against local NATS (`pnpm infra:reset`, then `pnpm infra:up`):
  - Run `pnpm dev`. `notification` logs "consumer ready" twice with `created`. `curl -s 'localhost:8222/jsz?accounts=true&streams=true&consumers=true&config=true'` lists `notification-inapp` and `notification-email` on `PAYMENTS` with `filter_subject` `payment.>`, `deliver_policy` `all` and `ack_policy` `explicit`.
  - Log in as the demo user and `POST /payments`. Within a few seconds, `notification` logs "event received" for `payment.created`, `payment.processing` and then `payment.succeeded` or `payment.failed`, once per channel. Each line carries the request's correlation ID, and no line contains the email.
  - `curl -s localhost:3003/health/ready` returns `200` with `nats` and `consumers` as `ok`.
  - Restart `notification`: both consumers log `unchanged` and no event is received again, because all were acked.
  - Stop `notification` with Ctrl+C. The log shows the consumers stopping before NATS drains, and the process exits 0.
  - Finish with `pnpm infra:reset`. Record the results in the PR.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-05-01 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-05-02: dedupe per `eventId` + channel inside each handler, before any side effect. Replays from `deliver_policy: all` and outbox republishes after the 2-minute window both reach this point.
- BE-05-03: narrow `notification-inapp`'s filter if not every event becomes a notification. Use `filter_subjects` for a list, and note that NATS may refuse changing between `filter_subject` and `filter_subjects` on an existing consumer.
- BE-05-04: narrow `notification-email`'s filter to the events that send email, and add the SMTP readiness check.
- BE-05-05: set `max_deliver` and `backoff` on `EMAIL_CONSUMER`, and use `msg.info.deliveryCount` in the handler to spot the last attempt.
- BE-05-06: create the `DLQ` stream with `ensureStream`.
