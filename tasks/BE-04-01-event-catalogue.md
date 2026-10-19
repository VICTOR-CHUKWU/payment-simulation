# BE-04-01: JetStream stream, subjects and payment event catalogue

**Covers:** BE-04-01
**Status:** done

## Objective

Define the payment events that the payment service will publish and the notification service will consume, and make sure the JetStream stream that holds them exists. `libs/shared` gets a catalogue of five event types, one per status change, where each type is also its subject. It gets one Zod schema for the event data and a typed builder. It also gets a `PAYMENTS` stream definition with an idempotent `ensureStream` helper, which both services call at startup. No event is published or consumed yet: BE-04-02 publishes through an outbox, and BE-05 consumes. Everything ships with unit tests.

## Source Context

Roadmap milestone BE-04-01 ("JetStream streams, subjects and event catalogue (one subject per status change, e.g. `payment.created`, `payment.succeeded`; final list follows BE-03-01)") in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Events: all five status changes.** `payment.created` (the payment was saved as `pending`), `payment.processing`, `payment.succeeded`, `payment.failed` and `payment.cancelled`. Which of these trigger an in-app notification or an email is decided in BE-05-03 and BE-05-04, not here.
- **Payload: snapshot.** `paymentId`, `userId`, `email`, `amount`, `currency`, an optional `description`, and `failureReason` on `payment.failed` only. The status follows from `type`, so the data has no `status` field.
- **Stream owner: both services.** The payment and notification services both call `ensureStream` after connecting to NATS, so start order never matters.
- **Retention: limits, 7 days, 2-minute dedupe window.** File storage, `limits` retention, `max_age` of 7 days, and the server's default 2-minute `duplicate_window`.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- Stream name `PAYMENTS`, subjects `["payment.>"]`, one replica, `discard: old`.
- No env vars. The stream name, subjects and limits are constants in the shared lib.
- `ensureStream` compares only the fields this doc sets. Any other field the server reports is ignored.

## Design Reference

- `ROADMAP.md`, Decisions table: Inter-service messaging ("NATS JetStream (durable streams, durable consumers, ack/redelivery). Every event has a unique ID, published as `Nats-Msg-Id` for publish-side dedupe; consumers are idempotent"); Money (integer minor units plus an ISO 4217 code); Validation (Zod for event payloads).
- `AGENTS.md`, Architecture constraints: shared code (event contracts, NATS wrapper) goes in `libs/shared`, and services never import each other; payment events carry `userId` and email so the notification service never looks users up; consumers dedupe per channel.
- `tasks/BE-01-02-shared-lib.md`, Follow-ups: "BE-04-01: define payment event `data` schemas and subjects on top of `eventEnvelopeSchema`". Its Verification section also sets the pattern for the throwaway manual NATS check.
- `tasks/BE-03-01-payment-model.md`, Follow-ups: "BE-04-01: decide which transitions publish events".
- `README.md`, "Payment flow" already names `payment.created`, `payment.succeeded` and `payment.failed`.

## Architecture Summary

```
libs/shared/src/
  payment-events.ts
    PAYMENT_EVENT_TYPES = ["payment.created", "payment.processing", "payment.succeeded", "payment.failed", "payment.cancelled"] as const
    PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number]
    paymentEventDataSchema       z.strictObject({ paymentId, userId, email, amount, currency, description?, failureReason? })
    paymentEventSchema           eventEnvelopeSchema(paymentEventDataSchema).extend({ type: z.enum(PAYMENT_EVENT_TYPES) }),
                                 superRefine: failureReason required when type is payment.failed, rejected otherwise
    PaymentEvent                 z.infer<typeof paymentEventSchema>
    createPaymentEvent(type, data) → PaymentEvent    (wraps createEvent; validates with paymentEventSchema)
  streams.ts
    PAYMENTS_STREAM: Partial<StreamConfig> & { name } constant (name, subjects, storage, retention, max_age,
                     duplicate_window, discard, num_replicas), using StorageType.File, RetentionPolicy.Limits, DiscardPolicy.Old
    jetstreamManager             re-exported by name from @nats-io/jetstream (async: returns Promise<JetStreamManager>)
    ensureStream(jsm, config) → Promise<"created" | "updated" | "unchanged">
      info(name)
        JetStreamApiError with code 10059 (JetStreamApiCodes.StreamNotFound) → add(config) → "created"
            add fails with JetStreamApiError code 10058 (stream name already in use) → info(name) again and continue below
        differs on any field in config → update(name, config) → "updated"
        matches → "unchanged"
        any other error → rethrow

services/payment/src/main.ts and services/notification/src/main.ts
  nc = await connectNats(...)
  result = await ensureStream(await jetstreamManager(nc), PAYMENTS_STREAM)   inside the existing try, so a failure logs "startup failed" and exits 1
  logger.info({ stream: "PAYMENTS", result }, "stream ready")
```

Because each type is also its subject, BE-04-02 publishes with `publishEvent(js, event.type, event)`, and consumers can filter on the type subject. The shared lib does not know payment statuses. BE-04-02 maps a status to a type in the payment service (`pending` → `payment.created`, otherwise `payment.<status>`).

`amount` reuses the payment service's rule: a positive integer up to `Number.MAX_SAFE_INTEGER`. `currency` is `^[A-Z]{3}$` rather than the payment service's allowlist, because the allowlist stays in the payment service. The notification service can format any ISO code with `Intl.NumberFormat`. `email` is `z.email()`. `paymentId` and `userId` are `z.uuid()`. `description` is 1 to 140 characters and `failureReason` 1 to 200, matching `payment.ts`. The data schema is strict, so unknown keys are rejected and a field added later is a deliberate contract change.

`max_age` and `duplicate_window` are nanoseconds in the NATS API. Use `nanos()` from `@nats-io/transport-node` (re-exported from `@nats-io/nats-core`; `@nats-io/jetstream` does not export it), not hand-written multiplication. Set `duplicate_window` explicitly to 2 minutes in `PAYMENTS_STREAM` rather than relying on the server default, so every field `ensureStream` compares is one it set.

"Unchanged" means: for every key in `config`, the server's `info.config[key]` is equal. Scalars compare with `===`; arrays (only `subjects` here) compare element by element in order. Keys the config does not set, which the server fills with defaults (`max_msgs`, `max_consumers`, `sealed` and so on), are ignored.

`@nats-io/jetstream` 3.4.0 does not export `StreamNotFoundError` from its root entry (only through `@nats-io/jetstream/internal`), so detect both API errors by `err instanceof JetStreamApiError` and `err.code`, using `JetStreamApiCodes.StreamNotFound` (10059) and a local constant for 10058, which `JetStreamApiCodes` lacks. NATS answers an `add` whose config matches the existing stream with success, so in the common start-together race both services log `created`. 10058 only comes back when the configs differ, for example while one service runs an older build. `streams.update(name, cfg)` takes a partial config and merges it into the server's current config before sending, so passing `PAYMENTS_STREAM` is fine.

NATS rejects some updates, such as changing `storage`, or `retention` to or from `workqueue`, on an existing stream. `ensureStream` does not work around that: the error propagates and startup fails with the server's message. `pnpm infra:reset` clears it locally. Add a README note.

## Code Evidence

| Behavior | Source |
|---|---|
| `eventEnvelopeSchema(dataSchema)` returns `z.object({ data, eventId: z.uuid(), occurredAt: z.iso.datetime(), type: z.string().min(1) })`; `createEvent(type, data)` sets a UUID and the current time | `libs/shared/src/events.ts` |
| `publishEvent(js, subject, event, { correlationId? })` publishes with `msgID: event.eventId`; `parseEvent(msg, dataSchema)` validates the envelope and returns `{ event, correlationId }` | `libs/shared/src/nats.ts` |
| Nothing creates a stream or consumer today | `libs/shared/src/nats.ts`, `services/*/src/main.ts` |
| `@nats-io/jetstream` 3.4.0 is a `libs/shared` dependency only; the services depend on `@payment-be/shared`, `express` and `zod`, so they cannot import it | `libs/shared/package.json`, `services/payment/package.json`, `services/notification/package.json` |
| The root entry exports `jetstreamManager` (async), `JetStreamApiError` (with `code`), `JetStreamApiCodes` (`StreamNotFound: 10059`, no 10058), `StorageType`, `RetentionPolicy`, `DiscardPolicy` and the `StreamAPI`, `StreamConfig` types; `StreamNotFoundError` is a `JetStreamApiError` subclass not exported from the root. `streams.add(cfg: WithRequired<Partial<StreamConfig>, "name">)`, `streams.update(name, cfg: Partial<StreamUpdateConfig>)`; `name`, `storage`, `retention` are on `StreamConfig` only | `node_modules/.pnpm/@nats-io+jetstream@3.4.0/.../lib/mod.d.ts`, `jserrors.d.ts`, `jsapi_types.d.ts`, `types.d.ts`, `jsbaseclient_api.js` |
| `nanos(millis)` is exported by `@nats-io/transport-node` (from `@nats-io/nats-core`), not by `@nats-io/jetstream` | `@nats-io+nats-core@3.4.0/.../lib/internal_mod.d.ts`, `util.d.ts` |
| Statuses are `pending`, `processing`, `succeeded`, `failed`, `cancelled`; `failureReason` exists only on `failed` | `services/payment/src/payment/payment.ts`, `payment.status.ts` |
| `amountSchema` is a positive int up to `MAX_SAFE_INTEGER`; `description` is 1–140 chars; `failureReasonSchema` is 1–200 chars; currencies are an allowlist (`EUR`, `GBP`, `NGN`, `USD`) | `services/payment/src/payment/payment.ts` |
| Both `main.ts` files call `connectNats` inside a `try` whose `catch` logs `startup failed` and exits 1 | `services/payment/src/main.ts`, `services/notification/src/main.ts` |
| NATS runs `nats:2.15.1-alpine` with `-js -sd /data` on a persistent volume; `pnpm infra:reset` deletes it | `compose.yaml`, `README.md` |
| README startup paragraph lists what stops a service at startup | `README.md`, "Install and run" |

## Scope

- **`payment-events.ts`**: the catalogue, data schema, envelope schema, type and builder above. `createPaymentEvent` throws a `ZodError` on invalid data, so a bad publisher fails loudly. Export each by name from `libs/shared/src/index.ts`. The data schema is a `z.strictObject`.
- **`streams.ts`**: `PAYMENTS_STREAM`, `ensureStream`, and a by-name re-export of `jetstreamManager` so the services get a manager without a new dependency. Type `jsm` with a narrow local type, such as `{ streams: { add(cfg): Promise<unknown>; info(name: string): Promise<{ config: Partial<StreamConfig> }>; update(name: string, cfg): Promise<unknown> } }`, that a real `JetStreamManager` satisfies, so tests can pass a hand-written stub without building a full `StreamInfo` or casting. `Pick<JetStreamManager, "streams">` is too wide: it needs the whole `StreamAPI`. Handle the race where both services start together: when `add` fails because the stream already exists, re-read it and continue with the compare step instead of failing.
- **Startup wiring**: both `main.ts` files import `ensureStream`, `jetstreamManager` and `PAYMENTS_STREAM` from `@payment-be/shared` and call `ensureStream` right after `connectNats`, before the repository and server, and log the result once. The readiness checks stay as they are.
- **Tests** (stubs written by hand, not `jest.fn`, which is undefined under ESM, as in `nats.test.ts`; stub errors are `new JetStreamApiError({ code, description, err_code })`):
  - `payment-events.test.ts`:
    - Every type round-trips through `createPaymentEvent` and `paymentEventSchema`.
    - `failureReason` is required on `payment.failed` and rejected on the other four types.
    - An unknown type is rejected, and so are a float or zero `amount`, a lowercase or 4-letter `currency`, a bad email or UUID, and an unknown data key.
    - A `PAYMENT_EVENT_TYPES` entry outside `payment.>` would fail. Assert that every type matches the stream's subject filter.
  - `streams.test.ts`:
    - A missing stream is created.
    - A matching stream returns `unchanged` without calling `update`.
    - A stream that differs (e.g. in `max_age` or `subjects`) is updated.
    - A matching stream that reports extra server-filled fields still returns `unchanged`, and a reordered `subjects` array counts as a difference.
    - An `add` that fails with 10058 reads the stream again and continues.
    - Any other `info`, `add` or `update` error is rethrown.
    - `PAYMENTS_STREAM` has the agreed values (7-day `max_age`, 2-minute `duplicate_window`, file storage, limits retention).
- **README**:
  - Add an "Events" subsection under Architecture. It needs a table of the five types with when each is emitted, the data fields, the stream (`PAYMENTS`, `payment.>`, file storage, 7 days, 2-minute publish dedupe on `eventId`), and a note that correlation IDs travel in the `x-correlation-id` header.
  - Say in the new subsection that publishing arrives with BE-04-02. Leave the "Payment flow" steps and the component table as they are: they describe the target flow.
  - Extend the startup paragraph: payment and notification create or update the `PAYMENTS` stream on start, and stop with an error if NATS refuses the change. Mention `pnpm infra:reset`.
- **Roadmap**: set BE-04-01 to `in-progress` when starting and `done` when finished. Its row already links this doc.

## Preserve

- `EventEnvelope`, `eventEnvelopeSchema`, `createEvent`, `publishEvent`, `parseEvent`, `CORRELATION_ID_HEADER` and their tests stay unchanged.
- All HTTP endpoints, OpenAPI specs, readiness checks and the shutdown order stay unchanged.
- The payment model, the transition table, the processor and `transitionPayment` stay unchanged.
- The auth service stays unchanged.

## Excluded

- Publishing any event, the outbox, and mapping a status to an event type (BE-04-02).
- Consumers, durable consumer config, and per-channel dedupe (BE-05-01, BE-05-02).
- Deciding which events become in-app notifications or emails (BE-05-03, BE-05-04).
- The `DLQ` stream (BE-05-06).
- A readiness check on the stream, metrics, or env vars for stream settings.
- Moving the currency allowlist into the shared lib.

## Likely Files To Touch

- `libs/shared/src/payment-events.ts`, `payment-events.test.ts` (new)
- `libs/shared/src/streams.ts`, `streams.test.ts` (new)
- `libs/shared/src/index.ts`
- `services/payment/src/main.ts`, `services/notification/src/main.ts`
- `README.md`, `ROADMAP.md`

## Prerequisites

BE-03-01 (statuses) and BE-01-02 (envelope, NATS wrapper) are merged to `main`. Both were merged by commit `997c537`.

## Decisions Required Before Implementation

None. The four decisions were settled during intake on 2026-10-19 (see Source Context). Rejected options:

- Events: skipping `processing` (the catalogue would no longer cover every status change); only the README's three (admin cancellations would send nothing).
- Payload: adding `previousStatus` (`transitionPayment` would have to carry it into the outbox, for no current consumer); minimal IDs only (email templates could not show the amount).
- Stream owner: payment only (notification would fail or retry when it starts first).
- Retention: a 1-hour dedupe window (more server state; consumers dedupe anyway); interest retention (events could not be inspected or replayed after both consumers ack).

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why a failed `add` reads the stream again.
- No dependency changes. `@nats-io/jetstream` is already a `libs/shared` dependency. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- No floats for money anywhere in the event contract.
- Named exports only in `index.ts`, keeping the existing alphabetical grouping.

## Deliverables

- The payment event catalogue, schemas and builder, exported from `@payment-be/shared`.
- The `PAYMENTS` stream definition and `ensureStream`, called at startup by both the payment and notification services.
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
  - Run `pnpm dev`. Both services log `stream ready`: one with `created` and the other with `created` or `unchanged`. `curl -s 'localhost:8222/jsz?accounts=true&streams=true&config=true'` shows `PAYMENTS` with subjects `payment.>`, file storage and `max_age` `604800000000000` (7 days in nanoseconds). Without `accounts=true` the endpoint returns only totals, and without `config=true` it omits the stream config.
  - Restart: both log `unchanged`.
  - Use a throwaway `libs/shared/stream-check.ts` (outside `src`, not committed) that imports from `./src/index.ts` and `@nats-io/jetstream`, logs through `createLogger` (no `console`), and runs with `pnpm --filter @payment-be/shared exec tsx stream-check.ts`. It publishes the same `createPaymentEvent("payment.created", …)` twice with `publishEvent(jetstream(nc), event.type, event)` and sees `duplicate: false` then `true`. It reads the message back with `jsm.streams.getMessage("PAYMENTS", { seq: ack.seq })`, parses `JSON.parse(new TextDecoder().decode(msg.data))` with `paymentEventSchema`, and drains the connection. Then delete the script, run `pnpm infra:reset` so the test event does not reach BE-05 consumers, and record the result in the PR.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-04-01 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-04-02: map each status change to its type in the payment service, build the event with `createPaymentEvent`, and publish with `publishEvent(js, event.type, event, { correlationId })`. An outbox republish later than 2 minutes after the first publish gets past publish-side dedupe, so consumers must stay idempotent.
- BE-05-01: create the durable consumers on `PAYMENTS` and filter by the type subjects each channel needs.
- BE-05-06: define the `DLQ` stream with the same `ensureStream` helper.
- BE-06-06: the README "Events" table is the starting point for the architecture doc's event catalogue.
