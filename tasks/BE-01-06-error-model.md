# BE-01-06: Central error model and error-handling middleware

**Covers:** BE-01-06
**Status:** done

## Objective

Every error response from every service uses one format: RFC 9457 Problem Details (`application/problem+json`). A central Express error handler in `libs/shared` maps known errors, validation errors and unexpected errors to that format. Responses never expose internal details, and the real cause of an unexpected error reaches the logs exactly once.

## Source Context

Roadmap milestone BE-01-06 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18. The user asked for the industry-standard approach, and intake chose RFC 9457 over a custom envelope (for example Stripe's `{ error: { ... } }`). RFC 9457 is the IETF standard and is used by the Zalando, Microsoft and Spring API guidelines.

## Design Reference

- `ROADMAP.md`, Decisions table: Validation (Zod at the HTTP boundary), Logging (pino-http, request IDs, redaction) and API docs (OpenAPI generated from Zod schemas, BE-01-09)
- `AGENTS.md`, Architecture constraints: "Validate HTTP input and event payloads with Zod at the boundary. Return errors only through the central error model." Also: "Never log passwords, tokens or auth headers." Task docs: "Every endpoint is registered in its service's OpenAPI spec ... including error responses."
- `tasks/BE-01-05-structured-logging.md`, Follow-ups: "the error middleware sets `res.err = err` for unexpected errors, so pino-http's completion line logs the real error instead of a generic one, and its response body includes the request ID."
- RFC 9457 (Problem Details for HTTP APIs), RFC 6901 (JSON Pointer)

## Architecture Summary

`libs/shared/src` gains one flat module, `errors.ts`, re-exported from `index.ts`:

- `problemDetailsSchema` is the Zod schema for the response body. BE-01-09 registers it as the shared OpenAPI error component.
- `AppError` is the error class that handlers and domain code throw for expected failures. Helper constructors cover the common statuses.
- `notFoundHandler` is the catch-all for unknown routes.
- `errorHandler` is the last middleware in every app. It turns any thrown or forwarded error into a problem response.

Each service's `createApp` mounts the routes, then `notFoundHandler`, then `errorHandler`.

**Response shape.** Standard RFC 9457 members plus three extension members:

```json
{
  "type": "tag:payment-be,2026:validation-error",
  "title": "Validation failed",
  "status": 400,
  "detail": "The request is invalid.",
  "instance": "/payments",
  "code": "validation-error",
  "requestId": "abc-123",
  "errors": [
    { "pointer": "/amount", "detail": "Too small: expected number to be >0", "code": "too_small" }
  ]
}
```

- `type`: `about:blank` for problems that a plain HTTP status fully describes (404, 413, 415, 500, and so on). In that case `title` is the standard status phrase, as RFC 9457 §4.2.1 requires. Errors specific to this service use a stable tag URI, `tag:payment-be,2026:<code>`. RFC 9457 allows tag URIs when no documentation site can be resolved, and this project has none.
- `code`: a stable kebab-case string that clients can branch on. Problems with `about:blank` also get a code (`not-found`, `internal-error`, and so on).
- `requestId`: `req.id` from pino-http, the same value as the `x-request-id` response header and the `correlationId` log field.
- `instance`: the request path (`req.originalUrl` without its query string).
- `errors`: present only for validation problems.

## Code Evidence

| Behavior | Source |
|---|---|
| `createApp({ checks, logger })` mounts only `httpLogger(logger)` and `healthRouter(checks)`. There is no error handler, no 404 handler and no body parser | `services/*/src/app.ts` |
| An unknown path gets Express's default HTML 404. A route that throws reaches Express's default handler, which sends an HTML page and prints the stack with `console.error` unless `NODE_ENV=test` | `express` 5.2.1, `finalhandler` 2.1.1 |
| Express 5 forwards both synchronous throws and rejected promises from route handlers to error middleware (reproduced) | `express` 5.2.1, `router` 2.2.0 `lib/layer.js` |
| `res.type("application/problem+json")` followed by `res.json()` keeps the type and appends a charset: `application/problem+json; charset=utf-8` (reproduced). Tests match the media type by prefix, not equality | `express` 5.2.1 `lib/response.js` (`json`) |
| In an app-level error handler `req.path` is the full path, but inside a mounted router it is relative to the mount point. `req.originalUrl` is always the full URL with the query string (reproduced with `app.use("/mounted", router)`) | `express` 5.2.1 `lib/request.js` |
| If the error handler calls `next(err)` after headers were sent, finalhandler destroys the socket (supertest rejects with `ECONNRESET`, message `aborted`) and Express prints `err.stack` with `console.error` unless the app's `env` is `test`. The completion line is `info` with the original status and no `err` (reproduced) | `finalhandler` 2.1.1 `index.js:118`, `express` 5.2.1 `lib/application.js` (`logerror`) |
| pino-http writes the completion line on the response's `close` as well as `finish`, so destroying a half-sent response still logs it. It includes `res.err` whatever the status, but picks the level with `customLogLevel(req, res, err)`, where `err` is only the response `error` event's argument. The shared `logLevel` checks only that `err` and the status, so a destroyed 200 response with `res.err` set would log at `info` | `pino-http` 11.0.0 `logger.js` (`onResFinished`, `loggingMiddleware`), `libs/shared/src/logger.ts` (`logLevel`) |
| Each service's `app.test.ts` 404 test asserts only the status code | `services/*/src/app.test.ts` ("returns 404 for an unknown path") |
| When a JSON body fails to parse, body-parser attaches the raw body string to the error: `createError(400, err, { body: str, type: err.type \|\| 'entity.parse.failed' })`. The result is the original `SyntaxError` with own `expose`, `status`, `statusCode`, `body` and `type`. Its `message` can quote the input too: `'"x"'` gives `Unexpected token '"', ""x"" is not valid JSON` (reproduced) | `body-parser` 2.3.0 `lib/read.js:164` |
| Other body-parser errors are `http-errors` instances with `status`, `statusCode`, `expose: true` (below 500) and `type`: 413 `entity.too.large` and `parameters.too.many`, 415 `charset.unsupported` and `encoding.unsupported`, 403 `entity.verify.failed`, 400 for aborted or invalid-size requests. `http-errors` always sets `status` and `statusCode` to the same value | `body-parser` 2.3.0 `lib/read.js`, `lib/types/urlencoded.js`, `http-errors` 2.0.1 `index.js:95`, `:163` |
| pino's `err` serializer copies every enumerable property of the error (`for (const key in err)`) and appends `cause` messages and stacks. Serializing the parse error above wrote `"body":"{\"password\":\"hunter2\""` (reproduced). The redaction paths (`*.password` and similar) do not match inside a string | `pino-std-serializers` 7.1.0 `lib/err.js:21-28`, `libs/shared/src/logger.ts` (`REDACT_PATHS`) |
| pino-http logs `res.err` on the completion line whenever it is set, at any status. `res.err = err` set inside Express error middleware reaches the line with the real message and stack (reproduced). Without it, a 5xx line carries a generic `failed with status code 500` and a 4xx line has no `err`. Nothing in Express, router or finalhandler sets `res.err`, and pino-http's own error source is only the response `error` event. `customLogLevel` already picks `error` for 5xx and `warn` for 4xx | `pino-http` 11.0.0 `logger.js:114` (`onResFinished`), `:202`, `libs/shared/src/logger.ts` (`logLevel`) |
| Status phrases come from Node's `http.STATUS_CODES`, for example 405 `Method Not Allowed`, 418 `I'm a Teapot`, 422 `Unprocessable Entity`. An unassigned 4xx such as 499 has no phrase | `node:http` (Node 24) |
| Zod issue `path` is `PropertyKey[]`: array indexes are numbers, and a schema with symbol keys yields symbol segments. A template literal on a symbol throws `TypeError`, so segments go through `String()` first | `zod` 4.6.7 `v4/core/errors.d.ts:9` |
| Built-in Zod messages for `invalid_type`, `invalid_value`, `too_small`, `too_big` and `invalid_format` describe what was expected, not the input (`invalid_value` lists the allowed values, a regex failure shows the pattern). Two cases do echo client data: `unrecognized_keys` names the unknown keys (`Unrecognized key: "extraSecretKey"`), and a custom `error` function can interpolate `iss.input` (reproduced) | `zod` 4.6.7 |
| `req.id` is set by `httpLogger` before any route runs, and `x-request-id` is set on every response | `libs/shared/src/logger.ts` (`requestId`, `httpLogger`) |
| `/health/ready` returns its own `503` body `{ checks, status: "fail" }`, not an error | `libs/shared/src/health.ts` |
| `parseEvent` throws a raw `ZodError` or `SyntaxError` for bad messages. It runs in consumers, not in HTTP handlers | `libs/shared/src/nats.ts` (`parseEvent`) |
| Ultracite enables `useTopLevelRegex` and `noNestedTernary`. Jest runs as native ESM, and `jest.fn` is undefined, so stubs are hand-written | Ultracite `biome.jsonc`, `tasks/BE-01-05-structured-logging.md` |

## Current Behavior To Preserve

- `pnpm check`, `typecheck`, `test` and `build` pass with Docker stopped.
- The health response bodies and status codes do not change, including the readiness 503 body.
- Every response, including error responses, still carries `x-request-id`. Health probes still produce no completion log line.
- Log redaction from BE-01-05 is unchanged. No new log line contains a request body, password, token or authorization value.
- `libs/shared/package.json` keeps only the `development` and `default` export conditions.

## Prerequisites

- BE-01-05 is done (`httpLogger` sets `req.id` and logs completion lines).

## Scope

**Dependencies**
- None. `zod` and `express` are already `libs/shared` dependencies. Detect `http-errors`-style errors by shape (the client-error row of the `errorHandler` table), not by importing `http-errors`.

**Shared `errors.ts`**
- `problemDetailsSchema` (Zod):
  - `type` (string), `title` (string), `status` (integer 400–599), `detail` (optional string), `instance` (string), `code` (string), `requestId` (string)
  - optional `errors`: an array of `{ pointer: string, detail: string, code: string }`
  - Export the inferred `ProblemDetails` type.
- `AppError extends Error`:
  - Constructor options: `status`, `code`, `title`, optional `detail`, optional `errors`, optional `headers` (sent with the response, for example `WWW-Authenticate: Bearer` on a 401), optional `cause` (standard `Error` cause, never sent to the client).
  - `type` is `tag:payment-be,2026:<code>` unless the caller marks the problem as plain HTTP, in which case it is `about:blank` and `title` is the status phrase. Choose the option name during implementation.
  - `name` is `"AppError"`.
- Helper constructors that return an `AppError`: `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable`, `serviceUnavailable`. Each takes an optional `detail` and optional overrides (`code`, `title`, `headers`, `cause`).
  - Without a `code` override the problem is plain HTTP: `about:blank`, `title` is the status phrase and `code` is that phrase in kebab case (`bad-request`, `unauthorized`, `forbidden`, `not-found`, `conflict`, `unprocessable-entity`, `service-unavailable`).
  - With a `code` override, `type` is `tag:payment-be,2026:<code>`, and `title` is the override or else the status phrase. Domain errors such as "version conflict" (BE-01-07) or "invalid status transition" (BE-03-04) are built with these helpers and a domain `code`. They are not added in this task.
- `ZodError` mapping, done by `errorHandler` so handlers can call `schema.parse(...)` directly:
  - status 400, `code: "validation-error"`, `title: "Validation failed"`, `detail: "The request is invalid."`
  - one `errors` entry per issue: `pointer` is the issue path as an RFC 6901 JSON Pointer (`["items", 0, "currency"]` becomes `/items/0/currency`, the root path becomes `""`, each segment goes through `String()` so numbers and symbols work, then `~` and `/` are escaped as `~0` and `~1`, in that order), `detail` is the issue message and `code` is the Zod issue code.
  - Built-in messages do not echo input values, except `unrecognized_keys`, which names the client's own keys. That is acceptable because the body goes only to that client and 4xx errors are never logged. Do not add `input` or `received` values to `errors`, and custom Zod messages in this repo must not interpolate the input.
  - Export the pointer conversion only if a test or a later milestone needs it. Otherwise keep it private.
- `notFoundHandler`: a middleware that passes a `notFound` `AppError` (`about:blank`, `code: "not-found"`, detail naming no internals) to `next`.
- `errorHandler` (four-argument Express error middleware):
  - If `res.headersSent`, set `res.err = err` and call `res.destroy()`. Do not call `next(err)`: Express would print the stack with `console.error` and pino would never log the error. The completion line then carries the real error.
  - Map the error:

    | Error | Status and code | Detail |
    |---|---|---|
    | `AppError` | its own `status`, `type`, `title` and `code` | its own `detail` |
    | `ZodError` | 400 `validation-error` | as above, with `errors` |
    | client error by shape (numeric `status`, else `statusCode`, from 400 to 499, and `expose !== false`), for example from body-parser | that status, `about:blank`, `title` the status phrase; codes `malformed-json` (400 `entity.parse.failed`), `payload-too-large` (413), `unsupported-media-type` (415), otherwise the status phrase in kebab case (`bad-request` for 400). A status with no phrase becomes 400 `bad-request` | a fixed message for the three named codes, otherwise none; never `err.message` and never `err.body` |
    | anything else, including errors with a 5xx `status` | 500 `internal-error`, `about:blank`, `title` `Internal Server Error` | fixed: `"An unexpected error occurred."` |

  - Kebab case means lowercase, with each run of characters other than `a-z0-9` replaced by one `-` (`I'm a Teapot` becomes `i-m-a-teapot`). Keep the regex top-level.
  - Send the body with `res.status(status).type("application/problem+json").json(body)`, adding `instance` and `requestId`.
  - Set `Cache-Control: no-store` and any `AppError.headers`.
  - Logging: set `res.err = err` only when the response is 5xx (including an `AppError` with a 5xx status), so pino-http's completion line logs the real error and stack once. Do not set `res.err` for 4xx responses: the existing `warn` line with status and `correlationId` is enough, and it keeps client payloads (such as `err.body`) out of the logs. The handler itself writes no log lines.
- Export `problemDetailsSchema`, `type ProblemDetails`, `AppError`, the helper constructors, `notFoundHandler` and `errorHandler` from `index.ts`. Annotate return types on exported functions.

**Shared `logger.ts`**
- `logLevel` also returns `error` when `res.err` is set, so the destroyed-response case above logs at `error`. No other change to `logger.ts`.

**Services (`auth`, `payment`, `notification`)**
- `app.ts`: after `healthRouter(checks)`, mount `notFoundHandler` then `errorHandler`. No other change. Future route milestones mount their routers before `notFoundHandler`.

**Tests** (next to each module, `*.test.ts`, supertest on a bare `express()` with `httpLogger` and a capture `destination` where logs are asserted)
- `libs/shared/src/errors.test.ts`:
  - An `AppError` thrown synchronously and one rejected from an async handler both produce its status, `code`, `type`, `detail`, a `content-type` starting with `application/problem+json` and `cache-control: no-store`. The body parses with `problemDetailsSchema`.
  - `requestId` equals the `x-request-id` response header, including when the client sends a valid `x-request-id`. `instance` is the path without the query string.
  - `AppError` `headers` are sent (for example `WWW-Authenticate` on a 401).
  - A route that calls `schema.parse` on bad input returns 400 `validation-error` with JSON Pointer paths, including a nested array path and a key that needs `~1` escaping.
  - With `express.json()` mounted, malformed JSON whose raw text contains `"password":"hunter2"` returns 400 `malformed-json`. Neither the response nor any captured log line contains `hunter2`.
  - A body over the `express.json({ limit })` size returns 413 `payload-too-large`.
  - A plain `Error("db exploded at /var/secret")` returns 500 `internal-error` with the fixed detail. The response does not contain the message. The completion log line is `error` and its `err` carries the real message and stack.
  - A 4xx `AppError` produces a `warn` completion line with no `err`.
  - An unknown route returns 404 `not-found` problem+json through `notFoundHandler`.
  - If headers are already sent (a route that calls `res.write`, then `next(err)`), the supertest request rejects with `ECONNRESET`, and the captured completion line is `error` and carries the real `err`.
  - Pointer conversion: the root path, numeric and symbol segments, and `~`/`/` escaping (`~1` must not become `~01`).
- `libs/shared/src/logger.test.ts`: a response with `res.err` set and a 200 status logs at `error`.
- `services/*/src/app.test.ts`: the existing 404 test also checks `content-type` and `code: "not-found"`. Health tests are unchanged.

**Docs**
- `README.md`: add an `### Errors` subsection under `## API`, keeping the "Not available yet" line for endpoints. Describe the problem format with one example body, the `code` values defined here, that `requestId` matches `x-request-id`, and that 500 responses never carry internal details. Describe only behavior that exists.
- `ROADMAP.md`: this doc is linked in the BE-01-06 row. Set `in-progress` when work starts and `done` at the end.
- OpenAPI: none yet (BE-01-09). See Follow-ups.

## Excluded

- Request-validation middleware or route schema declarations. BE-01-09 decides how routes declare schemas for OpenAPI. This task only maps `ZodError`.
- Domain error codes for repositories, payments or auth (BE-01-07, BE-02-02, BE-02-03, BE-03-04)
- Event-consumer error handling, nak/term decisions and dead-lettering (BE-05-02, BE-05-05, BE-05-06)
- Mounting `express.json()` in the services (the first endpoint milestone does this; tests mount it on a bare app)
- 405 Method Not Allowed, content negotiation for non-JSON clients, localised messages
- Changing the readiness 503 body
- Registering the schema in OpenAPI (BE-01-09)

## Likely Files To Touch

- `libs/shared/src/errors.ts`, `errors.test.ts` (new)
- `libs/shared/src/index.ts`, `logger.ts`, `logger.test.ts`
- `services/*/src/app.ts`, `app.test.ts`
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None. Settled during intake:
- Format: RFC 9457 Problem Details, with `code`, `requestId` and `errors` extension members.
- `type`: `about:blank` for plain HTTP problems; `tag:payment-be,2026:<code>` for service-specific ones.
- Validation failures return 400, not 422. 422 stays available for semantically invalid requests (for example an illegal status transition in BE-03-04).
- Field paths in `errors` use RFC 6901 JSON Pointer.
- No request-validation middleware in this task.
- An error after headers are sent is recorded on `res.err` and the response is destroyed, instead of being passed to Express's default handler (decided after review).
- A shape-detected 4xx status with no standard phrase (for example 499) becomes 400 `bad-request`, so every problem has a standard `title` (decided after review).

## Execution Rules

- No `console.*` and no `process.stdout`/`process.stderr` writes. No comments that restate the code.
- No new dependencies. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Never put `err.message`, `err.stack`, `err.body` or `cause` into a response body.
- If Express 5.2.1, body-parser 2.3.0 or pino-http 11.0.0 behaves differently from the Code Evidence above (for example `res.err` set in error middleware does not reach the completion line), update this doc with the observed behavior before choosing another mechanism.

## Deliverables

- `errors.ts` exported from `@payment-be/shared`, with unit tests.
- All three services return problem+json for unknown routes and unhandled errors.
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
  1. With `pnpm infra:up` and `pnpm dev`, `curl -i -H 'x-request-id: abc-123' localhost:3002/nope` (payment, port 3002) returns 404 with `content-type: application/problem+json; charset=utf-8`, `cache-control: no-store`, and a body containing `code: "not-found"` and `requestId: "abc-123"`. The log line is `warn` with `correlationId: "abc-123"`.
  2. `curl -i localhost:3001/health/ready` and `/health/live` respond as before.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes. No response produced by the tests contains an internal error message, stack or raw request body, and no log line contains a request body or password. The README describes only behavior that exists. The BE-01-06 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-01-07: compare-and-set failures throw `conflict({ code: "version-conflict" })`, or an equivalent the repository layer maps at the HTTP boundary.
- BE-01-09: register `problemDetailsSchema` as a shared OpenAPI response component (and the `x-request-id` header from BE-01-05). Every route lists its error responses with it.
- BE-02-02 and BE-02-03: login failures and missing or invalid tokens use `unauthorized` with `WWW-Authenticate: Bearer`. Role failures use `forbidden`. Detail text must not reveal whether an email exists.
- BE-03-04: an illegal status transition uses `unprocessable` or `conflict` with a domain `code`. Decide in that task doc.
- BE-05-02: consumers handle `parseEvent` failures separately (term, not retry). This middleware does not apply to them.
