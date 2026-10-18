# BE-01-08: JSON-file repository adapter

**Covers:** BE-01-08
**Status:** done

## Objective

`libs/shared` provides `createFileRepository<T>()`, a JSON-file adapter that implements the existing `Repository<T>` contract and passes the same contract suite as the in-memory adapter. It survives restarts and crashes without corrupting its file or losing a write it already acknowledged. The shared lib also gains the storage env vars and a helper that opens the configured adapter, ready for BE-02-01, BE-03-01 and BE-05-03 to adopt.

## Source Context

Roadmap milestone BE-01-08 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18. The user asked for the industry-standard approach. Intake modelled the write path on npm's `write-file-atomic` and lowdb's `steno` (temp file in the same directory, fsync, rename), and the locking and recovery on SQLite and LevelDB (a lock file per database, recovery from leftovers after a crash). The user approved the inventory and every recommended decision listed under Decisions Required Before Implementation.

## Design Reference

- `ROADMAP.md`, Decisions table, Persistence: "Generic repository interface in the shared lib with in-memory and JSON-file adapters, selected by env var (each service owns its data). Updates are compare-and-set on a `version` field. No database or ORM."
- `ROADMAP.md`, Decisions table, Caching: "the JSON-file adapter loads into memory too".
- `ROADMAP.md`, BE-01-08 row: "JSON-file adapter with serialized, atomic writes (temp file + rename, single writer per file)".
- `AGENTS.md`, Architecture constraints: "Validate HTTP input and event payloads with Zod at the boundary." The data file is treated as a boundary too.
- `tasks/BE-01-07-repository-interface.md`, Follow-ups: "the JSON-file adapter implements `Repository<T>`, adds its factory to the `adapters` list in `repository.test.ts`, and serializes writes so its compare-and-set stays atomic across the `await` on disk I/O." Its Excluded list hands this milestone "atomic writes, the storage env var and adapter selection, Zod validation of loaded records, storage readiness check".

## Architecture Summary

`libs/shared/src` gains two flat modules, re-exported from `index.ts`:

- `file-repository.ts`: `createFileRepository<T>()`, the `FileRepository<T>` type and `storageCheck()`.
- `storage.ts`: `storageConfigSchema` and `openRepository()`, which picks the memory or file adapter from config.

```ts
interface FileRepository<T extends Versioned> extends Repository<T> {
  close(): Promise<void>;
  isHealthy(): boolean;
}

createFileRepository<T>({ file, schema, logger?, fs? }): Promise<FileRepository<T>>
```

The adapter keeps every record in memory and rewrites the whole file on each `insert` or `update`. Mutations run one at a time through a per-repository queue. Each one checks against memory, writes the next state to disk atomically, and only then updates memory and resolves. Reads come from memory, so they never see a write that has not been saved.

```
insert/update ──► queue ──► check (memory) ──► write tmp ──► fsync tmp ──► rename ──► fsync dir ──► apply to memory ──► resolve
                                                    └─ failure up to rename: unlink tmp, reject, memory unchanged ─┘
                                                                                   └ failure: log, mark unhealthy, still apply ┘
```

## Code Evidence

| Behavior | Source |
|---|---|
| `Repository<T>` has async `get`, `find`, `insert` and `update(id, expectedVersion, patch)`; errors are `VersionConflictError`, `RecordNotFoundError` (both `AppError`) and `DuplicateRecordError` (plain `Error`) | `libs/shared/src/repository.ts` |
| The memory adapter does each read-compare-write synchronously inside `settle`, copies with `structuredClone`, skips `undefined` patch keys, and forces the stored `id` and the next `version` | `libs/shared/src/memory-repository.ts` |
| The contract suite runs with `describe.each(adapters)`; a factory may return a `Promise`. The list holds only `["memory", createMemoryRepository]` | `libs/shared/src/repository.test.ts` (`AdapterFactory`, `adapters`) |
| The discriminated-union type test uses `createMemoryRepository<Shape>()` directly, outside the adapter loop | `libs/shared/src/repository.test.ts` (`discriminated union records`) |
| `baseConfigSchema` holds `LOG_LEVEL`, `NATS_URL`, `NODE_ENV`; each service `extend`s it and calls `loadConfig`, which throws naming the variable but not its value | `libs/shared/src/config.ts`, `services/*/src/main.ts` |
| `ReadinessCheck` is `{ name, check }`; `healthRouter` treats a throw as `fail` | `libs/shared/src/health.ts` |
| Shutdown runs `ShutdownTask`s in order after the HTTP server closes | `libs/shared/src/shutdown.ts` (`onShutdown`) |
| Services run with their own folder as working directory (`tsx watch … src/main.ts`, `node dist/main.js`), so `data` resolves to `services/<svc>/data`, which `.gitignore` already ignores | `services/*/package.json`, `.gitignore` |
| Under `pnpm dev` and `pnpm start`, pnpm 11.21.0 delivers one Ctrl-C twice and the second SIGINT force-exits, skipping shutdown tasks. A lock file can therefore be left behind on a normal local stop | `tasks/BE-01-05-structured-logging.md` (Follow-ups) |
| Jest runs native ESM without `jest.fn`, so stubs are hand-written | `jest.config.js`, `tasks/BE-01-06-error-model.md` |
| `index.ts` is a sorted barrel with a `biome-ignore lint/performance/noBarrelFile` comment | `libs/shared/src/index.ts` |

## Current Behavior To Preserve

- The `Repository<T>` interface, its errors and the memory adapter do not change. Every existing contract case passes unchanged for both adapters.
- `pnpm check`, `typecheck`, `test` and `build` pass with Docker stopped.
- `libs/shared/package.json` keeps only the `development` and `default` export conditions.
- Services, their config and `.env.example` do not change. No service uses storage until BE-02-01.

## Prerequisites

- BE-01-07 is done.

## Scope

**Dependencies**
- None. Node's `node:fs/promises`, `node:path` and `node:crypto` cover everything.

**Shared `file-repository.ts`**

- `createFileRepository<T extends Versioned>(options): Promise<FileRepository<T>>`, options:
  - `file`: path to the data file.
  - `schema: z.ZodType<T>`: required; validates every record on load.
  - `logger?: Logger`: for warnings about stale locks and leftover temp files.
  - `fs?`: the subset of `node:fs/promises` the adapter uses (for example `open`, `readFile`, `readdir`, `mkdir`, `rename`, `unlink`), defaulting to the real module, so tests can inject failures with hand-written stubs. Keep it internal to tests in spirit: it is an option, not a second API.
- **File format:** `{ "formatVersion": 1, "records": [ ... ] }`, written with `JSON.stringify(data, null, 2)` and a trailing newline. `records` is in insertion order.
- **Open sequence**, in this order:
  1. Register the resolved path in a module-level set. If it is already there, reject: one repository per file per process.
  2. Create the directory (`recursive`, mode `0o700`).
  3. Acquire the lock (below).
  4. Delete leftover temp files for this data file (the temp-file pattern below), logging a warning with the count.
  5. Load: a missing file means an empty repository. Otherwise parse the JSON and validate it with an envelope schema (`formatVersion: 1`, `records: z.array(schema)`), and reject duplicate record IDs. Any failure rejects with an `Error` naming the file path and the Zod summary (`z.prettifyError`), never record contents. For invalid JSON, say only that the file is not valid JSON: V8's `SyntaxError` message quotes the file's text, so neither include it nor attach it as `cause`. The file is never overwritten or deleted after a failed load.
  6. If any step fails, release whatever was acquired (lock, registration) before rejecting.
- **Lock (single writer across processes):** `<file>.lock`, created with flag `wx` and containing the owner's pid.
  - If it already exists, read the pid. The lock is stale when the pid is not a positive integer, when `process.kill(pid, 0)` throws `ESRCH`, or when the pid is this process's own (the path is not registered, so no live repository holds it). `EPERM` means the process is alive.
  - A stale lock is unlinked and creation retried once, with a warning logged. If the retry also fails, or the owner is alive, reject with an error naming the lock path and the owning pid.
  - Known limit, accepted: check-then-unlink is not atomic, and a lock is empty between its `wx` create and the pid write. Two processes opening the same file at the same instant can therefore both take it over. The lock guards against an accidental second process, not a simultaneous start.
- **Reads:** `get` and `find` behave exactly as in the memory adapter (copies in and out, insertion order, a throwing predicate rejects). They read committed memory and do not wait for the queue.
- **Writes:** `insert` and `update` go through a promise queue per repository. A failed operation must not stop later ones.
  - Inside the queue: run the same checks and merge rules as the memory adapter (duplicate ID, not found, version conflict, `undefined` keys skipped, stored `id` and next `version` win). Build the next record list without changing memory.
  - Persist atomically: write the serialized list to a temp file in the same directory named `.<basename>.<pid>.<random hex>.tmp` (mode `0o600`), `sync()` and close it, `rename` it over the data file, then open the directory and `sync()` it. Ignore `EISDIR`, `EINVAL` and `EPERM` from the directory sync only, for filesystems that do not support it.
  - On any failure: close the temp file handle if it is open, unlink the temp file (ignoring `ENOENT`, which also covers a failure before it was created), mark the repository unhealthy, and reject with the original error. Memory stays unchanged.
  - A failure after the rename (opening or syncing the directory, other than the ignored codes): the new state is already in the file, so apply it to memory and resolve as on success, but log the error through `logger` (without record contents) and mark the repository unhealthy.
  - On success: replace memory, mark the repository healthy, resolve with a copy.
- **`close()`:** marks the repository closed as soon as it is called, then waits for already-queued writes to settle, unlinks the lock, removes the path from the registry. Idempotent: later calls return the same promise. From the moment `close` is called, `get`, `find`, `insert` and `update` reject with an `Error` saying the repository is closed, so nothing is queued after the lock is released. A reopen of the same path in the same process then works.
- **`isHealthy()`:** `false` after a failed write until the next successful one, and after `close`.
- **`storageCheck(repo, name = "storage")`:** a `ReadinessCheck` that returns `repo.isHealthy()`.

**Shared `storage.ts`**

- `storageConfigSchema = z.object({ STORAGE_DRIVER: z.enum(["memory", "file"]).default("file"), DATA_DIR: z.string().min(1).default("data") })`, for services to merge into their config with `baseConfigSchema.extend(storageConfigSchema.shape)`.
- `openRepository<T>({ config, name, schema, logger? })`, where `config` is `z.output<typeof storageConfigSchema>` (a full service config satisfies it structurally), returns `Promise<{ repository: Repository<T>; close: () => Promise<void>; check: ReadinessCheck }>`.
  - `name` must match `/^[a-z][a-z0-9-]*$/` (it becomes a file name); otherwise reject.
  - `memory`: `createMemoryRepository`, `close` a no-op, a check that always passes.
  - `file`: `createFileRepository` at `path.resolve(DATA_DIR, `${name}.json`)`, its `close`, and `storageCheck`.
  - The check is named `storage` in both cases, so readiness bodies look the same.

**Exports**
- From `index.ts`: `createFileRepository`, `type FileRepository`, `type FileRepositoryOptions`, `type FileSystem`, `openRepository`, `type OpenedRepository`, `storageCheck`, `storageConfigSchema`, `type StorageConfig`. The extra types name the `fs` option, the `openRepository` return value and its `config` parameter, so consumers and test stubs can annotate them. Annotate return types on exported functions.

**Tests**
- `libs/shared/src/repository.test.ts`, contract suite: add a `["file", …]` entry whose factory creates a fresh temp directory with `mkdtemp(path.join(os.tmpdir(), "payment-be-repo-"))` and opens a repository with a Zod schema for `Item`. Track opened repositories and directories so an `afterEach` closes them and removes the directories. Every existing case runs for both adapters with no case edited. Add a file-adapter case to the discriminated-union test.
- `libs/shared/src/file-repository.test.ts`:
  - Closing and reopening keeps every record, its `version` and insertion order; the file on disk has the documented envelope.
  - 20 inserts started together all resolve, and a reopen finds all 20.
  - Two concurrent updates with the same expected version: one wins, and the file holds the winner.
  - With an injected failure in the temp file open, the temp write, the file sync and the rename: the operation rejects with that error, `get` returns the previous state, the file is unchanged, no temp file is left, `isHealthy()` is `false`; the next successful write makes it `true`. A later queued operation still runs after a failed one.
  - A directory-sync `EINVAL` is ignored and the write succeeds.
  - With an injected failure in the directory open or a directory-sync error other than the ignored codes: the operation resolves, `get` and a reopen both return the new state, and `isHealthy()` is `false` until the next fully successful write.
  - A missing file opens empty and creates the directory; nothing is written until the first mutation.
  - Invalid JSON, a wrong `formatVersion`, a record failing the schema, and duplicate IDs each make the open reject with the path in the message, and the file content is unchanged afterwards.
  - Leftover temp files matching this data file are deleted on open; unrelated files in the directory are kept.
  - Opening the same path twice in one process rejects, and works again after `close`.
  - A lock file holding a live pid (for example `process.ppid`) makes the open reject naming the pid; a lock holding a dead pid (a child process that has exited) or garbage is taken over.
  - `close` waits for an in-flight write, removes the lock file, and later calls reject; a second `close` resolves.
  - `storageCheck` reflects `isHealthy()`.
- `libs/shared/src/storage.test.ts`: `storageConfigSchema` defaults and rejects an unknown driver; `openRepository` returns a memory repository for `memory` (no files created) and a file repository at `<DATA_DIR>/<name>.json` for `file`; an invalid `name` rejects; `close` and `check` work for both.

**Docs**
- `ROADMAP.md`: link this doc in the BE-01-08 row. Set `in-progress` when work starts and `done` at the end.
- `README.md` and `.env.example`: no change. The `STORAGE_DRIVER` and `DATA_DIR` variables are documented by BE-02-01, the first milestone where they take effect.

## Excluded

- Wiring storage into any service, and the README storage section (BE-02-01, BE-03-01, BE-05-03)
- Coalescing pending writes into one disk write: it conflicts with acknowledging a write only once it is on disk
- Backups, rotation, append-only journals, compaction, migrations between `formatVersion`s
- Validating records against the schema on write (callers validate at the HTTP and event boundaries)
- Delete, pagination, sorting, secondary indexes (as in BE-01-07)
- macOS `F_FULLFSYNC`; locks across machines or network filesystems
- Changes to the `Repository<T>` interface

## Likely Files To Touch

- `libs/shared/src/file-repository.ts`, `storage.ts` (new)
- `libs/shared/src/file-repository.test.ts`, `storage.test.ts` (new)
- `libs/shared/src/repository.test.ts`
- `libs/shared/src/index.ts`
- `ROADMAP.md`

## Decisions Required Before Implementation

None.

Settled after task-doc review on 2026-10-18, the recommended option:
- **Failure after the rename:** once `rename` succeeds the data file holds the new state, so a later directory open or sync failure applies the change to memory and resolves, logging the error and marking the repository unhealthy. Only the write's power-loss durability is in doubt. Rejected: rejecting with memory unchanged, which lets a restart bring back a write the caller was told failed (a client retry with a new ID could duplicate a payment); applying to memory but rejecting, which reports failure for a write that stands; treating it as fatal until reopen.

Settled during intake on 2026-10-18, each the recommended option:
- **Cross-process lock:** a pid lock file created with `wx`, taken over when its pid is dead. Rejected: an in-process lock only (lowdb's approach), which does not stop a second process; and the `proper-lockfile` dependency, which detects stale locks by mtime and needs a refresh timer. Stale-lock takeover is required because the pnpm double-SIGINT issue skips shutdown tasks.
- **Durability:** fsync the temp file and the directory on every write. Rejected: rename only, which is faster but can lose the last acknowledged write on power loss.
- **Load validation:** a Zod schema is required for every file repository; a bad file stops startup rather than being overwritten. Rejected: trusting the file.
- **Default driver:** `file`, so demo data survives restarts. Rejected: `memory` as the default.
- **Dependencies:** none.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, for example why the directory is synced, why some directory-sync errors are ignored, or why reads skip the queue.
- No new dependencies. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Tests must not write outside `os.tmpdir()`, must create every directory with the `payment-be-repo-` prefix, and must clean up their directories.
- Ultracite flags `await` inside loops (`noAwaitInLoops`) and regex literals outside the top level (`useTopLevelRegex`): clean up temp files and test repositories with `Promise.all`, and hoist the `name` regex to a module constant.
- Never log or put record contents in error messages.

## Deliverables

- `createFileRepository`, `storageCheck`, `storageConfigSchema` and `openRepository` exported from `@payment-be/shared`.
- The contract suite passing against both adapters, plus the file-adapter and storage tests.
- `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- `pnpm test libs/shared/src/repository.test.ts --verbose` lists every contract case under both a `memory` and a `file` block.
- After `pnpm test`, `find "$(node -p 'require("node:os").tmpdir()')" -maxdepth 1 -name 'payment-be-repo-*'` prints nothing, and `git status --porcelain` lists only the files under Likely Files To Touch.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes. The file adapter passes the shared contract suite, persists across reopen, leaves the file and memory unchanged when any write step before the rename fails, keeps memory and file in step when a step after the rename fails, refuses a second writer and recovers from a stale lock. The BE-01-08 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-02-01: first service to call `openRepository`; add `storageConfigSchema` to its config, register `close` as a shutdown task after NATS drain (draining lets in-flight handlers finish, and they write to storage), add `check` to readiness, and document `STORAGE_DRIVER` and `DATA_DIR` in the README and `.env.example`.
- BE-03-07: a unique index on idempotency keys, if needed, must be checked inside the write queue to stay race-free.
- BE-04-02: the outbox stored with the payment rides on the same atomic whole-file write.
