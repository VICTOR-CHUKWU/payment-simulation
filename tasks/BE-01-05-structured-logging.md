# BE-01-05: Structured logging with redaction and request/correlation IDs

**Covers:** BE-01-05
**Status:** done

## Objective

Give every service one structured JSON logger from `libs/shared`. Each HTTP request gets a request ID that appears on every log line for that request and travels into event headers as the correlation ID. Secrets and personal data are kept out of the logs. Once BE-02-03 verifies a JWT, the user is identified on log lines by `userId` and `role`. Services log startup, startup failures and shutdown steps.

## Source Context

Roadmap milestone BE-01-05 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18.

The user asked for user details on log lines when a user is known, following industry standard practice. Intake settled on `userId` + `role` only, with no email in any form, full or masked. This follows OWASP data minimisation and GDPR guidance: logs are copied to more places and kept longer than the user store, and erasure requests cannot reach them. The user chose this over "userId + masked email" and "userId + full email".

Library versions were checked at intake against the two-week age rule.

## Design Reference

- `ROADMAP.md`, Decisions table: the Logging row (pino + pino-http, pino-pretty in dev, request IDs propagated as correlation IDs, redaction of passwords, tokens and auth headers) and the Auth row (JWT claims `sub`, `email`, `role`)
- `AGENTS.md`, Architecture constraints: "Pass request/correlation IDs into event headers and include them in every log line. Never log passwords, tokens or auth headers." Code style: no `console.*`
- `tasks/BE-01-04-service-skeleton.md`, Follow-ups: "log startup (port), shutdown steps and startup failures through pino"

## Architecture Summary

`libs/shared/src` gains one flat module, `logger.ts`, re-exported from `index.ts`:

- `createLogger(options)` builds the pino root logger for a service.
- `httpLogger(logger)` returns the pino-http middleware. It assigns the request ID, echoes it in the response, binds it to `req.log`, and writes one completion line per request.
- `bindLogUser(req, res, user)` attaches `userId` and `role` to the rest of the request's log lines. BE-02-03's auth middleware calls it after verifying the token. Nothing calls it in this task except tests.

**Field naming.** HTTP requests use the `x-request-id` header, the de facto standard name. Every log line, HTTP or event-driven, carries the ID as one top-level field, `correlationId`. A single search on that field then follows a flow from the HTTP request through the events it causes. The event header stays `x-correlation-id` (`CORRELATION_ID_HEADER` in `nats.ts`) and carries the same value.

**Explicit propagation, no AsyncLocalStorage.** Handlers pass `req.id` to `publishEvent(..., { correlationId })` by hand. The BE-03-05 processor resolves payments outside any request, so implicit async context would not reach it anyway.

## Code Evidence

| Behavior | Source |
|---|---|
| `baseConfigSchema` already has `LOG_LEVEL` (pino's levels plus `silent`, default `info`) and `NODE_ENV`; nothing reads them yet | `libs/shared/src/config.ts` |
| `publishEvent` sets `x-correlation-id` only when `options.correlationId` is passed; `parseEvent` returns it as `correlationId` | `libs/shared/src/nats.ts` |
| `createShutdown` catches task errors with an empty `catch` and only flips the exit code, so the cause is lost | `libs/shared/src/shutdown.ts` (`run`) |
| Each `main.ts` loads config, connects NATS (payment, notification), listens and registers shutdown, logging nothing | `services/*/src/main.ts` |
| `createApp({ checks })` mounts only `healthRouter`; the only routes are `GET /health/live` and `GET /health/ready` | `services/*/src/app.ts`, `libs/shared/src/health.ts` |
| pino-http's default `genReqId` is an incrementing integer per process and never reads a request header, so a custom `genReqId` is required. The middleware calls `genReqId(req, res)` only when `req.id` is unset, and it receives `res`, so it can set the response header | `pino-http` 11.0.0 `logger.js` (`reqIdGenFactory`, `loggingMiddleware`) |
| The completion line is written with the logger captured when the middleware ran (`responseLogger`), so reassigning `req.log` later does not reach it | `pino-http` 11.0.0 `logger.js` (`loggingMiddleware`, `onResFinished`) |
| `customProps(req, res)` runs at middleware time and again in `onResFinished`. At completion it adds a child only if the new bindings, stringified, are not a substring of the existing ones. If `customProps` returned `{ correlationId, userId, role }` at completion, the line would carry `correlationId` twice (reproduced). `customSuccessObject(req, res, val)` and `customErrorObject(req, res, err, val)` build the completion object, so they can add fields without duplicates | `pino-http` 11.0.0 `logger.js` (`onResFinished`) |
| For a 5xx without `res.err`, the completion line's `err` is a generic `failed with status code 500`, not the real error | `pino-http` 11.0.0 `logger.js` (`onResFinished`) |
| `autoLogging: { ignore(req) }` skips the completion line for matching requests; `req.log` still works for them | `pino-http` 11.0.0 `logger.js` |
| The default `req` serializer includes all request headers, so `authorization` and `cookie` leak unless redacted. The default `res` serializer includes response headers (`getHeaders()`), so `set-cookie` would too. Handler `req.log` lines carry the full `req` object as well | `pino-std-serializers` 7.1.0 (`req`, `res` serializers) |
| pino 10 redaction accepts `*.password`, `*.*.password`, top-level keys and bracket paths such as `res.headers["set-cookie"]`; all were checked with censor `"[Redacted]"` | `pino` 10.4.0 (`@pinojs/redact` 0.4.0) |
| `base: { service }` drops `pid` and `hostname`. A `fatal` line followed by `process.exit(1)` is flushed, both with the `pino-pretty` transport and with the default stdout destination. pino rejects a `transport` and a destination stream together | `pino` 10.4.0 `lib/transport.js` (exit hooks), checked locally |
| Express 5.2.1 `app.listen(port, cb)` calls `cb(err)` on a server `error` (such as `EADDRINUSE`) and `cb()` once listening. Without a callback a listen error is an uncaught `error` event, which a `try` around `listen` does not catch | `express` 5.2.1 `lib/application.js` (`listen`) |
| A route that throws reaches Express's default handler, which prints the stack with `console.error` unless `NODE_ENV=test`. An unmatched path gets Express's default 404 (no catch-all until BE-01-06) | `express` 5.2.1, `finalhandler` |
| Under `pnpm`, one Ctrl-C delivers SIGINT to the service twice (terminal plus pnpm's relay, reproduced with pnpm 11.21.0). `onShutdown` binds with `process.once`, so the second SIGINT kills the process before shutdown finishes | `libs/shared/src/shutdown.ts` (`onShutdown`) |
| Ultracite enables `useTopLevelRegex` and `noNestedTernary` | Ultracite `config/biome/core/biome.jsonc` |
| pino-http 11.0.0 depends on `pino` `^10.0.0` | `pino-http` 11.0.0 `package.json` |
| Jest runs as native ESM and `jest.fn` is undefined in test files, so stubs and capture streams are hand-written | `package.json#scripts.test`, `tasks/BE-01-04-service-skeleton.md` |

## Current Behavior To Preserve

- `pnpm check`, `typecheck`, `test` and `build` pass with Docker stopped.
- `libs/shared/package.json` keeps only the `development` and `default` export conditions.
- The health response bodies and status codes do not change.
- `createShutdown` keeps its signature and return values (`0`/`1`, same promise on a second call, tasks run in order, a failing task does not stop later ones). `ShutdownTask` stays a plain function, so BE-03-05 can still pass more tasks.
- Startup still fails fast with a non-zero exit when config is invalid or NATS is unreachable.
- `loadConfig` error messages still name variables, never values.

## Prerequisites

- BE-01-04 is done (Express apps, `main.ts` bootstrap, shutdown).

## Scope

**Dependencies** (exact versions, `pnpm --filter <package> add -E`)
- `libs/shared` `dependencies`: `pino` 10.4.0, `pino-http` 11.0.0, `pino-pretty` 13.2.0.
  - At intake, pino 10.4.0 (released 2026-10-02) and pino-http 11.0.0 (2025-10-04) were past the two-week rule. pino-pretty 13.2.0 (2026-10-04) reached two weeks on the intake date. Re-check when work starts and record any change here.
  - `pino-pretty` goes in `dependencies` because pino loads it as a transport at runtime in development.
- Services import only `@payment-be/shared` for logging. If a service file needs the `Logger` type, shared re-exports it, so no service adds `pino`.

**Shared `logger.ts`**
- `createLogger({ service, level, pretty, destination? }): Logger`
  - Base bindings are `{ service }`. Drop pino's default `pid` and `hostname`, since one instance runs per service.
  - Timestamps are ISO (`pino.stdTimeFunctions.isoTime`).
  - With `pretty: true`, output goes through the `pino-pretty` transport. Otherwise it is JSON on stdout. `destination` is an optional writable stream that lets tests capture JSON lines, and it takes precedence over `pretty`.
  - Services pass `pretty: config.NODE_ENV === "development"` and `level: config.LOG_LEVEL`.
- **Redaction** (pino `redact`, censor `"[Redacted]"`). Paths are fixed in shared, not configurable per service:
  - `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`
  - `password`, `token`, `accessToken`, `email`, plus each of those one and two levels deep (`*.password`, `*.*.password`, and so on)
  - pino's redaction has no "any depth" wildcard. These paths are a safety net, not the main control. The rule for callers is: log identifiers (`userId`, `paymentId`, `eventId`), never whole user records, request bodies or event payloads.
- **Request ID** (pino-http `genReqId`)
  - Reuse an incoming `x-request-id` when it is 1 to 128 characters of `[A-Za-z0-9._-]`. Otherwise generate `crypto.randomUUID()`. This keeps `correlationId` and the echoed header short and safe to search and reflect. The raw header still appears, JSON-escaped, under `req.headers`.
  - Set the `x-request-id` response header to the chosen ID inside `genReqId` (it receives `res`), so every response gets it, including health probes.
  - Keep the ID regex in a top-level constant (`useTopLevelRegex`).
- **`httpLogger(logger)`**: pino-http with:
  - `genReqId` as above
  - `customProps` returning only `{ correlationId: req.id }`
  - `customSuccessObject` and `customErrorObject` returning pino-http's object plus any user bound by `bindLogUser`, so the completion line carries `userId` and `role` once
  - `autoLogging.ignore` for paths starting with `/health/`, so probes do not flood the logs
  - a response-level choice of `error` for 5xx or an error, `warn` for 4xx and `info` otherwise (`customLogLevel(req, res, err)`, without nested ternaries)
  - default serializers, with redaction above covering headers
  - Request and response bodies are never logged.
- **`bindLogUser(req, res, { userId, role })`**
  - Stores the user where `customSuccessObject` and `customErrorObject` read it (for example `res.locals`, under a key private to `logger.ts`), so the completion line carries `userId` and `role`.
  - Replaces `req.log` with `req.log.child({ userId, role })`, so lines logged later in the handler carry them too.
  - Takes only `userId` and `role`; its type has no email field. Unauthenticated requests carry neither field.
- Export `createLogger`, `httpLogger`, `bindLogUser` and `type Logger` from `index.ts`.
- Annotate return types: `createLogger` returns `Logger`, and `httpLogger` returns pino-http's `HttpLogger`. This avoids the TS2883 failure BE-01-04 hit, and keeps an `import` of `pino-http` in the emitted `logger.d.ts`, so its `req.id` and `req.log` augmentation of `http.IncomingMessage` also reaches services under `tsc -b`.

**Shared `shutdown.ts`**
- `ShutdownOptions` gains an optional `logger`. When present, `createShutdown`:
  - logs `info` when shutdown starts and when it finishes, with the exit code
  - logs `error` with `{ err }` when `server.close` fails
  - logs `error` with `{ err, task: <index> }` when a task throws
- `onShutdown` logs the received signal and logs `fatal` before the safety-timeout `process.exit(1)`. If `logger` is omitted, behavior is unchanged.

**Services (`auth`, `payment`, `notification`)**
- `main.ts`
  - Create the logger right after `loadConfig`.
  - Start the server with the shared `listen(app, port)` from `libs/shared/src/server.ts`. It wraps Express 5's `listen(port, cb)` callback, which receives the error on failure, in a promise that resolves with the `http.Server`. It lives in shared because all three services need it (moved there during review at the user's request).
  - Log `info` with `{ port }` once `listen` succeeds.
  - Wrap the steps after logger creation (NATS connect, listen) in `try`/`catch`. On failure, log `fatal` with `{ err }`, then call `process.exit(1)`. Do not rethrow: Node would print the error a second time outside pino. Do not rely on `process.exitCode` alone: an open NATS connection would keep the process alive when `listen` fails.
  - A `loadConfig` failure happens before a logger exists, so it keeps today's uncaught-error behavior.
  - Pass `logger` to `onShutdown`.
- `app.ts`: `createApp({ checks, logger })` mounts `httpLogger(logger)` before `healthRouter`, so every route has `req.log` and the `x-request-id` header.

**Tests** (next to each module, `*.test.ts`, capturing JSON through `destination`)
- `libs/shared/src/logger.test.ts`, using supertest on a bare `express()`:
  - A valid incoming `x-request-id` is reused, echoed in the response header and logged as `correlationId`.
  - A missing, too long or bad-character `x-request-id` is replaced by a UUID.
  - The `authorization` and `cookie` headers appear as `"[Redacted]"` on the completion line.
  - `logger.info({ user: { email, password } })` and top-level `token`/`email` come out redacted.
  - After `bindLogUser`, the completion line and a handler `req.log.info` line both carry `userId` and `role`. An unbound request carries neither.
  - `/health/live` produces no completion line but still gets the `x-request-id` header.
  - A 500 response logs at `error`, a 404 at `warn` and a 200 at `info`. Produce the 500 with `res.sendStatus(500)`, not a throwing route, so Express's default handler does not print a stack.
  - A completion line for a bound request contains `correlationId` exactly once (check the raw line, since `JSON.parse` hides duplicate keys).
  - `service` is on every line, and `pid`/`hostname` are absent.
- `libs/shared/src/server.test.ts`: `listen` resolves with a listening server, and rejects with `EADDRINUSE` when the port is taken.
- `libs/shared/src/shutdown.test.ts`: extend it so that, with a capture logger, a failing task logs `error` with its index and the error, and a run without a logger behaves as before.
- `services/*/src/app.test.ts`: pass a silent or capture logger to `createApp`. Existing assertions still pass, and responses carry `x-request-id`.

**Docs**
- `README.md`: add a "Logging" subsection under Getting started covering:
  - JSON logs (pretty in development) and `LOG_LEVEL`
  - the `x-request-id` header (accepted and echoed) and the `correlationId` field
  - what is redacted
  - that users are identified by `userId` and `role`, never email
- `.env.example`: no change. `LOG_LEVEL` is already there.
- `ROADMAP.md`: link this doc in the BE-01-05 row. Set `in-progress` when work starts and `done` at the end.
- OpenAPI: none yet (BE-01-09). When BE-01-09 lands, the `x-request-id` response header belongs in the shared response components.

## Excluded

- Calling `bindLogUser` from auth middleware (BE-02-03)
- Event-consumer logging helpers and consumer log lines (BE-05-01 onward). Follow-ups records the expected shape.
- The error model and error middleware (BE-01-06). This task only logs what pino-http sees.
- Logging email addresses in any form, full or masked
- AsyncLocalStorage or other implicit context propagation
- Log shipping, retention, metrics (BE-07-05) and tracing
- Logging request or response bodies

## Likely Files To Touch

- `libs/shared/package.json`, `pnpm-lock.yaml`
- `libs/shared/src/logger.ts`, `logger.test.ts` (new)
- `libs/shared/src/server.ts`, `server.test.ts` (new)
- `libs/shared/src/shutdown.ts`, `shutdown.test.ts`, `index.ts`
- `services/*/src/main.ts`, `app.ts`, `app.test.ts`
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None. Settled during intake:
- Users are identified on log lines by `userId` (JWT `sub`) and `role` only. Email is never logged, full or masked.
- The HTTP header is `x-request-id`, accepted when valid and echoed. The log field is `correlationId` everywhere. The event header stays `x-correlation-id`.
- Correlation IDs are passed explicitly, not through AsyncLocalStorage.
- Health probes are excluded from automatic request logging.
- pino-pretty is used only when `NODE_ENV=development`.

## Execution Rules

- No `console.*` and no `process.stdout`/`process.stderr` writes. Tests capture output through `destination`. No comments that restate the code.
- Pin exact versions, and add dependencies only to `libs/shared`.
- Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- If pino-http 11 behaves differently from the Code Evidence above (for example `customSuccessObject` does not reach the completion line), update this doc with the observed behavior before choosing another mechanism.

## Deliverables

- `logger.ts` exported from `@payment-be/shared`, with unit tests.
- Shutdown logging in `shutdown.ts`, with tests.
- All three services logging requests, startup, startup failures and shutdown.
- Updated `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual checks, reported in the PR:
  1. With `pnpm infra:up` and `pnpm dev`, each service prints a pretty `listening` line with its port.
  2. Run `curl -i -H 'x-request-id: abc-123' -H 'authorization: Bearer x' localhost:3002/nope`. The response has `x-request-id: abc-123`. The log line is `warn` with `correlationId: "abc-123"` and the authorization header redacted. `curl localhost:3002/health/ready` adds no log line.
  3. `pnpm build`, then `NODE_ENV=production pnpm --filter @payment-be/payment start` emits single-line JSON with `service` and an ISO `time`. A `curl localhost:3002/nope` then adds a JSON line with `correlationId`.
  4. Run a built service directly, not through `pnpm`, which delivers Ctrl-C twice: from `services/payment`, `node --env-file-if-exists=../../.env dist/main.js`. Ctrl-C (or `kill -TERM <pid>`) logs the signal, shutdown start and finish with exit code 0, and `echo $?` prints `0`. With `pnpm infra:down`, the same command logs a `fatal` line and `echo $?` prints `1`.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes. No log line produced by the tests contains an email address, password, token or authorization value. The README describes only behavior that exists. The BE-01-05 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-01-06: the error middleware sets `res.err = err` for unexpected errors, so pino-http's completion line logs the real error instead of a generic one, and its response body includes the request ID.
- BE-01-04 shutdown: a double SIGINT under `pnpm dev` or `pnpm start` force-exits before shutdown finishes (Code Evidence). Not fixed here; decide whether to ignore a repeat signal within a short window.
- BE-01-09: document the `x-request-id` response header in the shared OpenAPI components.
- BE-02-03: call `bindLogUser(req, res, { userId: claims.sub, role: claims.role })` after verifying the token. Never pass `email`.
- BE-04-02 and BE-03-05: pass `req.id` (or the payment's stored correlation ID) as `correlationId` to `publishEvent`.
- BE-05-01: consumer handlers log through `logger.child({ correlationId, eventId, userId })`, taken from `parseEvent` and the payload. Never log `data.email`.
