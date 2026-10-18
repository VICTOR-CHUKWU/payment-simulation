# BE-01-07: Generic repository interface and in-memory adapter

**Covers:** BE-01-07
**Status:** done

## Objective

`libs/shared` provides a generic, async `Repository<T>` interface with optimistic concurrency (compare-and-set on a `version` field) and an in-memory adapter that implements it. Services build their data layer on this interface, and BE-01-08's JSON-file adapter implements the same contract and passes the same test suite.

## Source Context

Roadmap milestone BE-01-07 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18. The user asked for the industry-standard approach, and intake chose the repository pattern with optimistic locking on a version field (the model behind JPA `@Version`, ETag/`If-Match` and conditional writes in document stores) over pessimistic locks or last-write-wins. The user approved the inventory and both recommended decisions listed under Decisions Required Before Implementation.

## Design Reference

- `ROADMAP.md`, Decisions table, Persistence: "Generic repository interface in the shared lib with in-memory and JSON-file adapters, selected by env var (each service owns its data). Updates are compare-and-set on a `version` field. No database or ORM."
- `AGENTS.md`, Architecture constraints: "Each service owns its data through a repository interface (in-memory and JSON-file adapters)." Also: "Status changes go through the repository's compare-and-set update, so a concurrent admin PATCH and processor update cannot overwrite each other."
- `tasks/BE-01-06-error-model.md`, Follow-ups: "BE-01-07: compare-and-set failures throw `conflict({ code: "version-conflict" })`, or an equivalent the repository layer maps at the HTTP boundary."

## Architecture Summary

`libs/shared/src` gains two flat modules, re-exported from `index.ts`:

- `repository.ts`: the `Versioned` record constraint, the `Repository<T>` interface, the `NewRecord<T>` and `RecordPatch<T>` helper types, and the three repository errors.
- `memory-repository.ts`: `createMemoryRepository<T>()`, a `Map`-backed implementation.

One test file, `repository.test.ts`, holds the contract suite and runs it with `describe.each` over a list of adapter factories. The list holds only the in-memory adapter now; BE-01-08 adds the JSON-file adapter to it.

```ts
interface Versioned { id: string; version: number }

interface Repository<T extends Versioned> {
  get(id: string): Promise<T | undefined>;
  find(predicate?: (record: T) => boolean): Promise<T[]>;
  insert(record: NewRecord<T>): Promise<T>;
  update(id: string, expectedVersion: number, patch: RecordPatch<T>): Promise<T>;
}
```

Callers use read, check, then write: `get` the record, apply domain rules (for example the BE-03-01 state machine), then `update` with the `version` they read. If another writer got there first, `update` throws `VersionConflictError` and nothing changes. The admin PATCH (BE-03-04) and the processor (BE-03-05) both follow this flow.

## Code Evidence

| Behavior | Source |
|---|---|
| No persistence code exists. `libs/shared/src` has only config, errors, events, health, logger, nats, server and shutdown modules | `libs/shared/src/` |
| `index.ts` is the package entry, a barrel with a `biome-ignore lint/performance/noBarrelFile` comment, exporting values and `type` exports in sorted order | `libs/shared/src/index.ts` |
| `AppError` takes `{ status, code, title?, detail?, plain?, headers?, cause? }`. `plain: true` makes `type` `about:blank` and `title` the status phrase; otherwise `type` is `tag:payment-be,2026:<code>`. The constructor sets `this.name = "AppError"` | `libs/shared/src/errors.ts` (`AppError`) |
| `errorHandler` maps any `instanceof AppError` with a 4xx/5xx status to its own problem body and sends its `headers`. Any other `Error` becomes 500 `internal-error`, with the real error on `res.err` | `libs/shared/src/errors.ts` (`toProblem`, `errorHandler`) |
| `conflict` and `notFound` helpers exist, but a subclass is needed for `instanceof` checks outside HTTP (the processor) | `libs/shared/src/errors.ts` (`problemFactory`) |
| Biome declares Jest globals (`describe`, `it`, `expect`, ...) only for `**/*.{test,spec}.*` and `**/__tests__/**/*`; elsewhere they fail `lint/correctness/noUndeclaredVariables`. The same preset enables `noExportsInTest`, so a test file cannot export a reusable suite | `biome.jsonc`, `node_modules/ultracite/config/biome/jest/biome.jsonc` |
| `*.test.ts` files are excluded from the build and typed with `@types/jest` through `tsconfig.test.json` | `libs/shared/tsconfig.json` (`exclude`), `tsconfig.test.json` |
| `strict` is on and `exactOptionalPropertyTypes` is off, so a `Partial` patch can carry a key set to `undefined` | `tsconfig.base.json` |
| Jest runs native ESM. `jest.fn` is unavailable, so stubs are hand-written | `jest.config.js`, `tasks/BE-01-06-error-model.md` |
| `structuredClone` is a global in Node 24. It copies plain data (objects, arrays, `Date`, `Map`) but drops class prototypes and throws on functions | Node 24 |
| The README `### Errors` table lists every `code` the services can return | `README.md` (`## API`) |

## Current Behavior To Preserve

- `pnpm check`, `typecheck`, `test` and `build` pass with Docker stopped.
- Existing error responses, health endpoints, logging and redaction do not change.
- `libs/shared/package.json` keeps only the `development` and `default` export conditions.
- Services do not change. No service uses a repository until BE-02-01 and BE-03-01.

## Prerequisites

- BE-01-06 is done (`AppError` and `errorHandler` exist).

## Scope

**Dependencies**
- None.

**Shared `repository.ts`**
- `Versioned`: `{ id: string; version: number }`. Records are plain JSON-compatible data, not class instances.
- `NewRecord<T> = T extends unknown ? Omit<T, "version"> : never`. The caller supplies `id`, normally from `randomUUID()`, so idempotency keys (BE-03-07) and outbox entries (BE-04-02) can reference it before the insert.
- `RecordPatch<T> = T extends unknown ? Partial<Omit<T, "id" | "version">> : never`.
- Both helpers distribute over unions, so a discriminated-union model (for example a BE-03-01 payment keyed on `status`) keeps its discriminant. A plain `Omit` over a union keeps only the common keys.
- `Repository<T extends Versioned>`, all methods async:
  - `get(id)`: the record, or `undefined` if it does not exist.
  - `find(predicate?)`: every record matching the predicate (all records when omitted), in insertion order. The predicate receives copies, so it cannot change stored state even if it mutates its argument. Pagination and sorting are excluded.
  - `insert(record)`: stores it with `version: 1` and returns the stored record. Throws `DuplicateRecordError` if the ID exists.
  - `update(id, expectedVersion, patch)`: if the stored `version` equals `expectedVersion`, shallow-merges `patch` into the record (keys whose value is `undefined` are skipped, so every adapter stores the same thing), sets `version` to `expectedVersion + 1` and returns the new record. The stored `id` and new `version` always win, even if a caller smuggles them into `patch` at runtime. Throws `RecordNotFoundError` for an unknown ID and `VersionConflictError` for a version mismatch; in both cases nothing is stored.
- Errors:
  - `new VersionConflictError({ id, cause? })` extends `AppError`: 409, `code: "version-conflict"`, `title: "Version conflict"`, fixed detail `"The resource was changed by another request. Fetch it and try again."`, `name` `"VersionConflictError"`, `readonly id`.
  - `new RecordNotFoundError({ id })` extends `AppError`: plain 404 (`about:blank`, `code: "not-found"`), fixed detail `"The requested resource does not exist."`, `name` `"RecordNotFoundError"`, `readonly id`.
  - `new DuplicateRecordError({ id })` extends `Error` (not `AppError`), `name` `"DuplicateRecordError"`, `readonly id`. A duplicate UUID means a bug, so it surfaces as a 500 with the real error logged.
  - `AppError` sets `message` to `detail`, so the two `AppError` subclasses set `this.message` after `super` to include the ID, for example `Version conflict on record <id>`. `errorHandler` sends `detail`, not `message`, so responses stay fixed. Messages and details never include record contents.

**Shared `memory-repository.ts`**
- `createMemoryRepository<T extends Versioned>(): Repository<T>`, backed by a `Map` (which keeps insertion order).
- Store and return `structuredClone` copies, and pass copies to the `find` predicate, so mutating a returned object, the object passed to `insert`/`update`, or the predicate's argument never changes stored state.
- Each method does its read-compare-write synchronously, with no `await` between the version check and the write, so concurrent calls on the event loop cannot interleave. The methods are `async` only to satisfy the interface.

**Build config**
- None. The contract lives in a `*.test.ts` file, which the build already excludes and Biome already treats as a test.

**Exports**
- From `index.ts`: `type Versioned`, `type Repository`, `type NewRecord`, `type RecordPatch`, `VersionConflictError`, `RecordNotFoundError`, `DuplicateRecordError`, `createMemoryRepository`. Annotate return types on exported functions.

**Tests**
- `libs/shared/src/repository.test.ts`, contract suite: a local `adapters` list of `[name, factory]` entries, where each factory returns a fresh, empty `Repository` of a test record type (a `Promise` is allowed, for BE-01-08's temp files). It holds only `["memory", createMemoryRepository]` now. `describe.each(adapters)` runs the cases below once per adapter, each case on a new repository. The file exports nothing.
  - `insert` returns the record with `version: 1`; `get` returns an equal record; `get` of an unknown ID returns `undefined`.
  - `insert` with an existing ID rejects with `DuplicateRecordError` and leaves the original unchanged.
  - `find()` returns all records in insertion order; `find(predicate)` returns only matches; an empty repository returns `[]`.
  - `update` with the current version merges the patch, increments `version`, and `get` reflects it. Untouched fields are kept.
  - `update` with a stale version rejects with `VersionConflictError`, and the stored record is unchanged.
  - Two `update` calls started together with the same expected version (`Promise.allSettled`): exactly one fulfils and one rejects with `VersionConflictError`.
  - `update` of an unknown ID rejects with `RecordNotFoundError`.
  - A patch containing `id` or `version` (cast past the type) does not change them. A patch key set to `undefined` leaves the stored field unchanged.
  - Mutating the object returned by `get`, `find`, `insert` or `update`, the object passed in, or the argument inside a `find` predicate, does not change what the next `get` returns.
- `libs/shared/src/repository.test.ts`, type check: on a memory repository of a two-member discriminated-union test type, `insert` of a record and `update` with a patch, each carrying a field only one member has, typecheck and run. `pnpm typecheck` fails if the helpers stop distributing.
- `libs/shared/src/repository.test.ts`, error mapping, in its own `describe` outside the adapter loop: each error's `name`, `id` and `instanceof` (`AppError` for the first two, not for `DuplicateRecordError`). On a bare `express()` with `httpLogger` and `errorHandler`, a route that throws `VersionConflictError` returns 409 problem+json with `code: "version-conflict"` and `type: "tag:payment-be,2026:version-conflict"`; one throwing `RecordNotFoundError` returns 404 `not-found`; one throwing `DuplicateRecordError` returns 500 `internal-error` without its message. No response `detail` contains the record ID.

**Docs**
- `README.md`: add a `409 | version-conflict | The resource changed since it was read; fetch it and retry` row to the `### Errors` table. Add nothing about storage configuration (BE-01-08).
- `ROADMAP.md`: the BE-01-07 row already links this doc. Set `in-progress` when work starts and `done` at the end.

## Excluded

- JSON-file adapter, atomic writes, the storage env var and adapter selection, Zod validation of loaded records, storage readiness check (BE-01-08)
- Delete (no milestone needs it)
- Pagination, sorting, `GET /payments` list (BE-07-02)
- Unique secondary indexes, for example on idempotency keys (BE-03-07)
- Payment, user and notification models and their repositories (BE-02-01, BE-03-01, BE-05-03)
- Transactions across multiple records, or the payment outbox (BE-04-02)
- Wiring repositories into services

## Likely Files To Touch

- `libs/shared/src/repository.ts`, `memory-repository.ts` (new)
- `libs/shared/src/repository.test.ts` (new)
- `libs/shared/src/index.ts`
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None. Settled during intake:
- Repository pattern with optimistic concurrency on `version`; versions start at 1.
- Conflict and not-found errors extend `AppError`, so `errorHandler` maps them with no new code, and non-HTTP callers still catch them with `instanceof`. Alternative rejected: storage-only errors translated per route (more code, same result here).
- `update` takes the expected version and a shallow patch, not an updater function. Callers read, check domain rules, then write with the version they read, which fits both HTTP and the processor.
- Callers generate IDs. A duplicate ID is a bug (500), not a client error.
- One contract suite shared by every adapter: a single `repository.test.ts` that runs it with `describe.each` over adapter factories. Alternative rejected: a separate non-test contract module, which Biome's Jest globals override and `noExportsInTest` rule do not allow without config changes.

## Execution Rules

- No `console.*`. No comments that restate the code; the no-`await`-between-check-and-write rule is a candidate for one short comment.
- No new dependencies. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Keep the interface storage-agnostic: nothing in `Repository` may assume memory (for example no synchronous methods or exposed `Map`).

## Deliverables

- `Repository<T>`, the three errors and `createMemoryRepository` exported from `@payment-be/shared`.
- A contract suite in `repository.test.ts`, parameterized over adapters, passing against the in-memory adapter.
- Updated `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- `pnpm test libs/shared/src/repository.test.ts --verbose` lists the contract cases under a `memory` block.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes. The contract suite, including the concurrent-update case, passes against the in-memory adapter. A version conflict reaches HTTP clients as 409 `version-conflict` problem+json. The README describes only behavior that exists. The BE-01-07 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-01-08: the JSON-file adapter implements `Repository<T>`, adds its factory to the `adapters` list in `repository.test.ts`, and serializes writes so its compare-and-set stays atomic across the `await` on disk I/O.
- BE-03-04 and BE-03-05: status changes call `update(id, version, { status })` after checking the transition. Decide there whether a processor that hits `VersionConflictError` re-reads and retries or drops the update.
- BE-03-07: idempotency-key lookup uses `find`, or adds a unique index if a race between two first requests must be closed.
