# BE-01-04: Express app skeleton per service

**Covers:** BE-01-04
**Status:** done

## Objective

Turn each service into a running Express 5 server that loads its config, connects to the dependencies it really uses, answers liveness and readiness probes, and shuts down cleanly on SIGTERM or SIGINT. Put the reusable parts (health router, NATS readiness check, shutdown handler) in `libs/shared` and keep each to a few functions. No business endpoints yet.

## Source Context

Roadmap milestone BE-01-04 in `ROADMAP.md`. Scope was agreed during task-doc intake. The user asked to keep it as simple as possible while following standard practice. Library versions below were checked at intake (2026-10-18) against the two-week age rule.

## Design Reference

- `ROADMAP.md`, the Decisions table rows for runtime/framework, observability (health and readiness endpoints are core), validation and testing
- `AGENTS.md`, the Architecture constraints, Code style (no `console.*`) and Toolchain notes
- `tasks/BE-01-02-shared-lib.md`, Follow-ups (wire `loadConfig` and `connectNats`, drain on shutdown, remove `SHARED_PACKAGE_NAME`)

## Architecture Summary

`libs/shared/src` gains two flat modules, re-exported from `index.ts`:

- `health.ts`: a readiness-check type, `healthRouter(checks)` and `natsCheck(nc)`.
- `shutdown.ts`: a shutdown routine that closes the HTTP server, runs cleanup tasks in order, and is bound to SIGTERM and SIGINT.

Each service splits into two files:

- `app.ts`: `createApp({ checks })` builds the Express app and mounts the health router. It does no I/O, so supertest tests use it directly.
- `main.ts`: the bootstrap. It loads config, connects to NATS if the service needs it, builds the app, listens on the service's port, and registers shutdown.

Real dependencies per service today:

| Service | Connects to | Readiness checks |
|---|---|---|
| `auth` | nothing (it publishes no events, and services never call it at runtime) | none, so ready whenever it is listening |
| `payment` | NATS | `nats` |
| `notification` | NATS | `nats` (SMTP check arrives with BE-05-04) |

Later milestones add checks (for example storage loaded in BE-01-08, SMTP in BE-05-04) and cleanup tasks (processor timers in BE-03-05) by passing more entries, without changing the shared modules.

## Code Evidence

| Behavior | Source |
|---|---|
| Service mains only export placeholder constants; no server, no NATS | `services/*/src/main.ts`, `services/*/src/main.test.ts` |
| `SHARED_PACKAGE_NAME` exists only for those placeholders and `libs/shared/src/index.test.ts` | `libs/shared/src/index.ts` |
| `loadConfig(schema, env)` and `baseConfigSchema` (`NODE_ENV`, `LOG_LEVEL`, `NATS_URL`) are ready to extend | `libs/shared/src/config.ts` |
| `connectNats({ name, url })` returns a `NatsConnection` with library defaults; `connect` rejects if the server is unreachable at first connect | `libs/shared/src/nats.ts` |
| The default `maxReconnectAttempts` is 10 with a 2 s wait, after which the client closes for good, so a NATS outage longer than about 20 s leaves the service permanently unready | `@nats-io/nats-core` 3.4.0 `lib/options.js`, `lib/protocol.js` (`dodialLoop`) |
| A `flush()` sent while disconnected waits until the next reconnect attempt, then rejects with "connection disconnected" | `@nats-io/nats-core` 3.4.0 `lib/protocol.js` (`flush`, `resetOutbound`) |
| `NatsConnection` exposes `isClosed()`, `isDraining()`, `flush()` and `drain()` | `@nats-io/nats-core` 3.4.0 `lib/core.d.ts` |
| `.env.example` already has `AUTH_PORT=3001`, `PAYMENT_PORT=3002`, `NOTIFICATION_PORT=3003`, read by nothing yet | `.env.example` |
| Services load `../../.env` with `--env-file-if-exists` and run `src/main.ts` (dev) or `dist/main.js` (start) | `services/*/package.json#scripts` |
| Jest runs as native ESM; `jest.fn` is undefined in test files, so stubs are hand-written | `package.json#scripts.test`, `jest.config.js` |
| pnpm does not hoist, so each package must declare what it imports. Biome's `noUndeclaredDependencies` checks the package's own `package.json`, so a root-only `supertest` fails `pnpm check` in package test files | `node_modules/` layout, Ultracite `config/biome/core` |
| Ultracite enables `noAwaitInLoops` and `useConsistentTypeDefinitions` (`interface` style). It does not flag `process.exit`, top-level `await` or magic numbers | Ultracite `config/biome/core/biome.jsonc` |

## Current Behavior To Preserve

- `pnpm check`, `typecheck`, `test` and `build` pass with Docker stopped. No test in this task needs a running NATS.
- `libs/shared/package.json` keeps only the `development` and `default` export conditions.
- `main.ts` stays the entry point named in each service's `dev` and `start` scripts.
- `loadConfig` error messages still name variables, never values.

## Prerequisites

- BE-01-02 is done (config loader and NATS helpers).
- BE-01-03 is done, so a local NATS is available for the manual checks in Completion Verification.

## Scope

**Dependencies** (exact versions)
- `libs/shared` `dependencies`: `express` 5.2.1 and `@types/express` 5.0.6. Use 5.2.1 because 5.3.0 was released on 2026-10-09 and is under two weeks old at intake. If 5.3.x is at least two weeks old when work starts, use it and record that here. `@types/express` goes in `dependencies`, not `devDependencies`, because shared's emitted `.d.ts` exposes Express types to the services.
- Each service `dependencies`: `express` (same version), so `app.ts` can import it directly. Each service `devDependencies`: `@types/express` 5.0.6. Without it `tsc` fails with TS7016 on `import express from "express"`, because pnpm does not expose shared's copy to the services.
- `devDependencies` of `libs/shared` and each service: `supertest` 7.3.1 and `@types/supertest` 7.2.1. Declare them per package, not at the root, or Biome's `noUndeclaredDependencies` fails `pnpm check` on every test that imports `supertest`.

**Shared `health.ts`**
- `interface ReadinessCheck { name: string; check: () => boolean | Promise<boolean> }` (an interface, because Ultracite's `useConsistentTypeDefinitions` rejects a type alias here).
- `healthRouter(checks: ReadinessCheck[]): Router` returns an Express `Router`. Annotate the return type with `Router` from `express`: without it `tsc -b` fails with TS2883, because the inferred type points into `@types/express-serve-static-core`, which shared does not declare.
  - `GET /health/live`: always `200 {"status":"ok"}`. Liveness never checks dependencies, so a NATS outage does not get the process restarted.
  - `GET /health/ready`: runs every check concurrently. A check that throws or rejects counts as failed. If all pass, `200 {"status":"ok","checks":{...}}`. Otherwise, `503 {"status":"fail","checks":{...}}`, where each check maps to `"ok"` or `"fail"`. With no checks, it returns `200` with `"checks":{}`.
  - Responses never include error messages or connection details.
- `natsCheck(nc, timeoutMs = 1000)` returns a `ReadinessCheck` named `nats`. Its `check` resolves `false` (it never rejects) when `nc.isClosed()` or `nc.isDraining()` is true, when `nc.flush()` (a PING/PONG round-trip) rejects, or when it does not resolve within `timeoutMs`. The timeout is needed because a flush sent while the client is reconnecting waits for the next reconnect attempt (up to 2 s) before it rejects. Clear the timer once the race settles. Type `nc` as `Pick<NatsConnection, "isClosed" | "isDraining" | "flush">`, so tests pass a plain stub.

**Shared `shutdown.ts`**
- A testable core, `createShutdown({ server, tasks })`, returns an async `shutdown()` function. Both functions take the same `ShutdownOptions`; `timeoutMs` (default `10_000`) is only read by `onShutdown`, the one place it is used:
  1. Calls `server.close()` and waits for its callback. On Node 24 this stops new connections and closes keep-alive sockets that are idle at that moment. In-flight requests finish, but their keep-alive sockets then stay open until `keepAliveTimeout` (5 s by default), so the callback can take up to about 5 s. That is inside the 10 s safety timeout, so no extra handling is needed.
  2. Runs `tasks` (`Array<() => Promise<void> | void>`) one after another, in the given order. A failing task does not stop later tasks. A `for...of` with `await` trips Ultracite's `noAwaitInLoops`, so put `// biome-ignore lint/performance/noAwaitInLoops: tasks must run in order` on that line rather than switching to `Promise.all`.
  3. Resolves `0` when everything succeeded, or `1` if closing or any task failed.
  - Calling `shutdown()` again returns the same promise, so a second signal does not repeat the work.
- `onShutdown(options)` calls `createShutdown`, then binds SIGTERM and SIGINT with `process.once`. On a signal it:
  - starts a safety timer with `setTimeout(..., timeoutMs).unref()` that calls `process.exit(1)` if shutdown hangs,
  - awaits `shutdown()`,
  - sets `process.exitCode` to the result, without calling `process.exit()` on the normal path. The process then exits once the event loop empties, which proves no timer or socket was left open.
- Type `server` as `{ close(callback: (err?: Error) => void): unknown }`. A real `http.Server` fits it. Do not use `Pick<Server, "close">`: its `close` returns `Server`, so a test stub cannot satisfy it without a cast.
- No shutdown library (`@godaddy/terminus`, `http-terminator`). Node's built-ins cover this.

**Services (`auth`, `payment`, `notification`)**
- `app.ts`: `createApp({ checks }: { checks: ReadinessCheck[] }): Express` returns `express()` with `healthRouter(checks)` mounted. Annotate the return type with `Express` from `express`, for the same TS2883 reason as `healthRouter`. Nothing else: no JSON body parser, 404 or error handler yet.
- `main.ts`:
  - Load config with `loadConfig(baseConfigSchema.extend({ <SERVICE>_PORT: z.coerce.number().int().min(1).max(65_535).default(<port>) }))`. Use `AUTH_PORT` 3001, `PAYMENT_PORT` 3002 and `NOTIFICATION_PORT` 3003, matching `.env.example`. Each service imports `zod` for this, so add `zod` (the version shared uses) to each service's `dependencies`.
  - `payment` and `notification`: `await connectNats({ name: "<service>", url: config.NATS_URL })`, then pass `[natsCheck(nc)]` as checks and `() => nc.drain()` as the shutdown task.
  - `auth`: no NATS, no checks, no tasks.
  - Start with `app.listen(port)`, then call `onShutdown({ server, tasks })`.
- Fail fast: invalid config or unreachable NATS at startup throws from top-level `await`, so the process exits non-zero with the error. No retry loop and no `waitOnFirstConnect`. If NATS drops after startup, the client reconnects on its own and readiness reports `fail` until it is back.
- `connectNats` in `libs/shared/src/nats.ts` passes `maxReconnectAttempts: -1`, so the client keeps reconnecting however long NATS is down. With the default of 10 attempts it closes for good after about 20 s, and the service stays live but never ready again. This setting only applies after the first connect, so startup still fails fast.
- Remove `SHARED_PACKAGE_NAME` from shared and delete `libs/shared/src/index.test.ts`, which only tests it. Remove the placeholder exports and `main.test.ts` in each service.

**Logging gap until BE-01-05**
- There is no logger yet and `console.*` is banned. So this task prints no "listening" line and no shutdown messages. Startup failures still surface as an uncaught error with a non-zero exit code. Do not use `process.stdout.write` or `process.stderr.write` as a stand-in. BE-01-05 adds the log lines.

**Tests** (next to each module, `*.test.ts`)
- `libs/shared/src/health.test.ts`, using supertest on a bare `express()` with the router mounted:
  - live returns 200
  - ready returns 200 with no checks, and with all checks passing
  - ready returns 503 when one check returns false, throws, or rejects, and the body marks only that check `"fail"`
  - `natsCheck` with a hand-written stub: resolves `true` when open and flush resolves; resolves `false` when closed, when draining, when flush rejects, and when flush never resolves (use a short `timeoutMs`, such as 20 ms)
- `libs/shared/src/shutdown.test.ts`, calling `createShutdown` directly with a stub `{ close(cb) { cb(); return this; } }` (or `cb(new Error(...))`) and recording tasks. No real signals and no `process.exit`.
  - `close` runs before the tasks, and the tasks run in order
  - the result is `0` on success
  - the result is `1` when `close` errors or a task throws, and later tasks still run
  - a second `shutdown()` call returns the same promise and runs nothing twice
- `services/*/src/app.test.ts`, one per service:
  - supertest `GET /health/live` returns 200
  - `GET /health/ready` returns 200 with passing stub checks, and 503 with a failing one
  - an unknown path returns 404. This only shows the app has no catch-all yet; BE-01-06 replaces it.
- `main.ts` stays untested by unit tests, since it only wires real I/O. The manual checks below cover it.

**Docs**
- `README.md`:
  - In Getting started, add a short "Health checks" table: each service, its port, and the `/health/live` and `/health/ready` paths, with a note that readiness returns 503 when a dependency (NATS) is down.
  - Add the sentence that services stop at startup with a clear message if a variable is invalid or NATS is unreachable. This is the follow-up from BE-01-02.
  - Update the status note to say services now start an HTTP server with health endpoints.
- `ROADMAP.md`: the BE-01-04 row already links this doc. Set `in-progress` when work starts and `done` at the end.
- OpenAPI: none. No spec exists until BE-01-09, which registers the health routes along with its setup.

## Excluded

- pino logging, request and correlation IDs, and redaction (BE-01-05)
- the error model, the JSON 404 handler and error middleware (BE-01-06)
- helmet, CORS and rate limits (BE-02-04)
- OpenAPI and Swagger UI (BE-01-09)
- the JSON body parser and every business route (BE-02-02, BE-03-02 onward)
- NATS streams, consumers and subscriptions (BE-04-01, BE-05-01)
- storage and SMTP readiness checks (BE-01-08, BE-05-04)
- processor timers (BE-03-05)
- Dockerfiles and container health checks (BE-07-03)
- waiting or retrying when NATS is unavailable at startup

## Likely Files To Touch

- `libs/shared/package.json`, `pnpm-lock.yaml`
- `libs/shared/src/index.ts`, `nats.ts`; delete `libs/shared/src/index.test.ts`
- `libs/shared/src/health.ts`, `shutdown.ts` and their `*.test.ts` (new)
- `services/*/package.json`
- `services/*/src/main.ts`, `app.ts`, `app.test.ts` (new); delete `services/*/src/main.test.ts`
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None. Settled during intake:
- The probe paths are `/health/live` and `/health/ready`.
- Shutdown is hand-written with Node built-ins, not a library.
- NATS unreachable at startup means fail fast and exit.
- `auth` connects to nothing and has no readiness checks.
- NATS readiness uses a flush with a timeout, not the status iterator.
- Express 5, with the version chosen by the two-week rule.

## Execution Rules

- No `console.*` and no `process.stdout`/`process.stderr` writes. No comments that restate the code.
- Pin exact dependency versions: add them with `pnpm --filter <package> add -E` (`-E -D` for devDependencies). Nothing is added at the root.
- Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. A review spike found none is needed: with the per-package dependencies and return-type annotations above, `pnpm typecheck`, `pnpm build`, ts-jest and top-level `await` all work as configured. If one still turns out to be needed, stop and record why in this doc first.

## Deliverables

- `health.ts` and `shutdown.ts` exported from `@payment-be/shared`, with unit tests.
- `app.ts` plus a rewritten `main.ts` in each of the three services, with supertest tests.
- `SHARED_PACKAGE_NAME` and the placeholder tests removed.
- Updated `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual check, reported in the PR. Run from the repo root unless noted. Without a `.env`, the ports fall back to the schema defaults (3001 to 3003).
  1. With `pnpm infra:up` and `pnpm dev`, `curl -i localhost:3001/health/ready`, `:3002` and `:3003` each return 200, and `/health/live` returns 200 on all three.
  2. `docker compose stop nats`: within a few seconds payment and notification `/health/ready` return 503 with `"nats":"fail"`, while `/health/live` stays 200 and auth stays ready. Wait at least 30 s (longer than the old 10-attempt limit), then `docker compose start nats`: readiness returns to 200 within a few seconds, with no restart.
  3. Stop `pnpm dev`, keep NATS up, run `pnpm build`, then from `services/payment`:
     ```sh
     node --env-file-if-exists=../../.env dist/main.js & pid=$!
     sleep 2; kill -TERM $pid; wait $pid; echo "exit $?"
     ```
     It prints `exit 0` within 10 s, which shows the drain finished and nothing kept the event loop alive.
  4. With `pnpm infra:down`, `pnpm --filter @payment-be/payment start` exits non-zero. `PAYMENT_PORT=abc pnpm --filter @payment-be/payment start` exits non-zero and the error names `PAYMENT_PORT`. A shell variable wins over `.env`, because `--env-file` never overrides one that is already set.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, the README describes only endpoints and behavior that exist, and the BE-01-04 row in `ROADMAP.md` is `done` with a link to this file.

## Follow-ups

- BE-01-05: log startup (port), shutdown steps and startup failures through pino.
- BE-01-06: add the JSON 404 and error middleware to each `createApp`.
- BE-01-08: add a storage readiness check where a service uses the JSON-file adapter.
- BE-01-09: register `/health/live` and `/health/ready` in each OpenAPI spec.
- BE-03-05: register the processor timer stop as a shutdown task before the NATS drain.
- BE-05-04: add an SMTP readiness check to notification.
