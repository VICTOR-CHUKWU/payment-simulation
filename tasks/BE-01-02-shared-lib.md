# BE-01-02: Shared lib basics

**Covers:** BE-01-02
**Status:** done

## Objective

Give every service three small, tested building blocks in `libs/shared`: an env config loader validated with Zod, a generic event envelope, and a thin NATS JetStream wrapper that publishes and parses those events. Keep each one to a few functions. Nothing here knows about payments, users or notifications yet.

## Source Context

Roadmap milestone BE-01-02 in `ROADMAP.md`. Scope was agreed during task-doc intake, and the user asked to keep it as simple as possible while following standard practice. The library versions and API calls below were checked at intake with a scratch script against the BE-01-03 NATS. A second publish with the same `msgID` returned `duplicate: true`, a custom header round-tripped, and `z.prettifyError` printed `✖ Invalid URL → at NATS_URL` without echoing the bad value.

## Design Reference

- `ROADMAP.md`, the Decisions table rows for inter-service messaging, validation and money
- `AGENTS.md`, the Architecture constraints (event IDs, idempotency, correlation IDs in event headers) and Toolchain notes

## Architecture Summary

`libs/shared/src` gains three flat modules, all re-exported from `index.ts`. Ultracite's `lint/performance/noBarrelFile` flags any re-export in that file (named or `export *`), so `index.ts` carries one `// biome-ignore lint/performance/noBarrelFile: package entry point` line above the re-exports. That is the one essential comment in this task; do not change `biome.json`.

- `config.ts`: `loadConfig(schema, env)` parses an env object with any Zod schema and fails fast. `baseConfigSchema` holds the variables every service shares. Each service extends it with its own port when it wires up in BE-01-04.
- `events.ts`: the envelope every event uses (`eventId`, `type`, `occurredAt`, `data`), a schema factory that wraps a `data` schema, and `createEvent` to build one.
- `nats.ts`: `connectNats`, `publishEvent` and `parseEvent` over the official `@nats-io/*` v3 packages. Publishing sets `Nats-Msg-Id` from `eventId`, so JetStream drops duplicates on the publish side. Correlation IDs travel in a NATS header, not in the envelope.

Services do not call any of this yet. BE-01-04 wires config and the connection into each `main.ts`.

## Code Evidence

| Behavior | Source |
|---|---|
| Shared lib exports only a placeholder constant | `libs/shared/src/index.ts#SHARED_PACKAGE_NAME` |
| Each service imports that placeholder and its test checks it | `services/*/src/main.ts`, `services/*/src/main.test.ts` |
| Shared lib has no dependencies yet | `libs/shared/package.json` |
| Services load `../../.env` through Node's `--env-file-if-exists`, so `process.env` is filled before code runs (no dotenv needed) | `services/*/package.json#scripts` |
| `.env.example` has `NODE_ENV`, `LOG_LEVEL` and three ports; no `NATS_URL` | `.env.example` |
| NATS listens on `127.0.0.1:4222` with JetStream on | `compose.yaml`, `tasks/BE-01-03-local-infra.md` |
| Jest resolves the shared lib from source via the `development` condition | `jest.config.js#testEnvironmentOptions` |
| Jest runs as native ESM, so the `jest` global (`jest.fn`) is not defined in test files; `describe`, `it` and `expect` are | `package.json#scripts.test`, `jest.config.js` |

## Current Behavior To Preserve

- `SHARED_PACKAGE_NAME` stays exported, since the service placeholders and their tests import it. BE-01-04 removes it when it replaces the service mains.
- `pnpm check`, `typecheck`, `test` and `build` pass with Docker stopped. No test in this task needs a running NATS.
- `libs/shared/package.json` keeps only the `development` and `default` export conditions (see the Toolchain notes in `AGENTS.md`).

## Prerequisites

- BE-01-03 is done, so a local NATS is available for the one manual check in Completion Verification.

## Scope

**Dependencies** (in `libs/shared/package.json` `dependencies`, exact versions, added with `pnpm --filter @payment-be/shared add`)
- `zod` 4.x (4.6.7 at intake). Zod 4 is what `@asteasolutions/zod-to-openapi` 9 needs for BE-01-09.
- `@nats-io/transport-node` and `@nats-io/jetstream` 3.x (3.4.0 at intake). These are the current modular NATS clients. Do not use the legacy `nats` 2.x package.

**`config.ts`**
- `baseConfigSchema`, a `z.object` with:
  - `NODE_ENV`: `development | test | production`, default `development`
  - `LOG_LEVEL`: pino levels `fatal | error | warn | info | debug | trace | silent`, default `info`
  - `NATS_URL`: URL, default `nats://localhost:4222`
- `loadConfig(schema, env = process.env)` returns the parsed, typed config (`z.infer` of the schema). On failure it throws an `Error` whose message starts with `Invalid environment configuration` followed by `z.prettifyError` output. The message names the variables and the problems, never the values, since later milestones add secrets such as the JWT secret.
- No caching, no singletons. Each service calls it once at startup.

**`events.ts`**
- `eventEnvelopeSchema(dataSchema)` returns `z.object({ eventId: z.uuid(), type: z.string().min(1), occurredAt: z.iso.datetime(), data: dataSchema })`.
- `EventEnvelope<T>` type for an envelope with `data: T`.
- `createEvent(type, data)` returns an envelope with `eventId` from `node:crypto` `randomUUID()` and `occurredAt` as `new Date().toISOString()`.
- No payment event types, subjects or streams. Those are BE-04-01, after BE-03-01 settles the statuses.

**`nats.ts`**
- `connectNats({ url, name })` calls `connect({ servers: url, name })` from `@nats-io/transport-node` and returns the `NatsConnection`. Library defaults for reconnects. `name` is the service name, so connections can be told apart in the NATS monitor.
- `CORRELATION_ID_HEADER = "x-correlation-id"`, exported so BE-01-05 uses the same name for HTTP and events.
- `publishEvent(js, subject, event, { correlationId? })` JSON-encodes the envelope, publishes with `msgID: event.eventId`, adds the correlation header when given, and returns the `PubAck`. Type `js` as `Pick<JetStreamClient, "publish">`, so callers pass `jetstream(nc)` and tests pass a plain object without casts.
- `parseEvent(msg, dataSchema)` takes a message with `data` and optional `headers` (a `JsMsg` fits). It decodes the JSON, validates it with `eventEnvelopeSchema(dataSchema)` and returns `{ event, correlationId }`. Invalid JSON or a schema mismatch throws, and the consumer decides whether to `term()` it (BE-05-02).
- No subscribe loops, consumer setup, stream creation or shutdown helpers. Callers use `nc.drain()` directly (BE-01-04).

**Tests** (next to each module, `*.test.ts`)
- `config.test.ts`: defaults apply to an empty env; a valid env parses; an invalid `NATS_URL` and an invalid `LOG_LEVEL` throw with the variable name in the message; a secret-looking invalid value does not appear in the message; a service schema made with `baseConfigSchema.extend(...)` works.
- `events.test.ts`: `createEvent` gives a UUID and an ISO timestamp, and two calls give different IDs; the envelope schema accepts a created event and rejects a bad `eventId`, a missing `type` and bad `data`.
- `nats.test.ts`: with a hand-written stub `{ publish }` typed `Pick<JetStreamClient, "publish">` that records its arguments and resolves a fixed `PubAck` (not `jest.fn`, which is undefined under ESM; no `@jest/globals` dependency), `publishEvent` sends the JSON envelope with `msgID` equal to `eventId`, sets the correlation header only when given, and returns the ack. `parseEvent` round-trips a published payload and its correlation header, returns `correlationId: undefined` without one, and throws on bad JSON and on a schema mismatch. Build headers with `headers()` from `@nats-io/transport-node`. Jest and ts-jest load `zod` and `@nats-io/*` with no config change (checked at review).

**Docs**
- `.env.example`: add `NATS_URL=nats://localhost:4222`.
- `README.md`: in Getting started, say that `.env.example` lists the variables with working local defaults. Update the status note to mention the shared config, event and NATS helpers. Do not say services validate config at startup yet; BE-01-04 adds that sentence when it wires `loadConfig`.
- `ROADMAP.md`: the BE-01-02 row already links this doc. Set `in-progress` when work starts and `done` at the end.

## Excluded

- Wiring config or NATS into the service mains, readiness checks and shutdown (BE-01-04).
- Logger, request IDs and redaction (BE-01-05). This task only exports the header name.
- Central error model (BE-01-06). Config errors are a plain `Error`, since they stop the process before any request.
- Stream, subject and consumer definitions, and payment event contracts (BE-04-01).
- Consumer helpers, dedupe and retry handling (BE-05-01, BE-05-02, BE-05-05).
- Tests that need a running NATS (BE-06-03).
- `JWT_SECRET`, SMTP and storage env vars. Each arrives with the milestone that reads it.

## Likely Files To Touch

- `libs/shared/package.json`, `pnpm-lock.yaml`
- `libs/shared/src/index.ts`
- `libs/shared/src/config.ts`, `events.ts`, `nats.ts` and their `*.test.ts` (new)
- `.env.example`, `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None. Settled during intake:
- Events use one generic envelope. Correlation IDs go in a NATS header, following `AGENTS.md`.
- The publish-side dedupe key is `eventId` through `msgID`.
- Config is validated with Zod straight from `process.env`. No dotenv, since Node's `--env-file-if-exists` already loads `.env`.
- Unit tests only, using a stub JetStream client. Real-NATS tests wait for BE-06-03.

## Execution Rules

- No `console.*`, no comments that restate the code.
- Pin exact dependency versions. If a newer patch of `zod` or `@nats-io/*` exists and is at least two weeks old, use it and record it here.
- Do not change any service code or TypeScript config.

## Deliverables

- `config.ts`, `events.ts`, `nats.ts` exported from `@payment-be/shared`, each with unit tests.
- Updated `.env.example`, `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- `pnpm test -- libs/shared` runs the three new test files and they pass.
- Manual check against the local NATS (`pnpm infra:up`): a throwaway `libs/shared/nats-check.ts` (outside `src`, so no build, test or typecheck picks it up) imports from `./src/index.ts`, `@nats-io/jetstream` and `zod`, and runs with `pnpm --filter @payment-be/shared exec tsx nats-check.ts`. It creates a temporary stream on `check.>`, publishes the same event twice with `publishEvent`, sees `duplicate: false` then `true`, reads it back with `parseEvent` including the correlation ID, deletes the stream and drains the connection. Report the result in the PR, then delete the script. Do not commit it.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, the docs mention only variables that `baseConfigSchema` or a service reads, and the BE-01-02 row in `ROADMAP.md` is `done` with a link to this file.

## Follow-ups

- BE-01-04: each service extends `baseConfigSchema` with its port, calls `loadConfig` and `connectNats` in `main.ts`, and drains on shutdown. Remove `SHARED_PACKAGE_NAME`. Add the README sentence that services stop at startup with a clear message if a variable is invalid.
- BE-01-05: use `CORRELATION_ID_HEADER` for HTTP and event correlation.
- BE-04-01: define payment event `data` schemas and subjects on top of `eventEnvelopeSchema`.
