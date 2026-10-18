# BE-02-01: Auth users and seeded accounts

**Covers:** BE-02-01
**Status:** done

## Objective

The auth service owns a users repository, opened through the shared storage helper, and on every start creates the seeded admin and normal user if their emails are not stored yet. Passwords are stored only as bcrypt hashes. Storage is wired into the service's config, readiness and shutdown, which makes auth the first service to persist data. BE-02-02 then adds register and login on top of this model.

## Source Context

Roadmap milestone BE-02-01 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18. The user asked to keep it simple and follow best practice, and accepted the recommended option for every decision listed under Decisions Required Before Implementation.

## Design Reference

- `ROADMAP.md`, Decisions table, Auth: "`auth` service owns users and issues JWT access tokens (claims: `sub`, `email`, `role`) … Roles: `user`, `admin`; register always creates `user`. Seeded on startup: one admin and one normal user."
- `ROADMAP.md`, Decisions table, Persistence: repository interface with in-memory and JSON-file adapters selected by env var; compare-and-set on `version`.
- `ROADMAP.md`, BE-02-02 row: "bcrypt, JWT with `sub`/`email`/`role` claims".
- `tasks/BE-01-08-json-file-adapter.md`, Follow-ups: "BE-02-01: first service to call `openRepository`; add `storageConfigSchema` to its config, register `close` as a shutdown task …, add `check` to readiness, and document `STORAGE_DRIVER` and `DATA_DIR` in the README and `.env.example`."
- `README.md`, Logging: log lines identify a user by `userId` and `role`, never by email; `password` and `email` fields are redacted.
- `README.md`, Local infrastructure: "The seeded demo accounts will be added with the milestone that introduces them."

## Architecture Summary

`services/auth/src` gains four folders, each with an `index.ts` that re-exports its public API (the layout rule in `AGENTS.md`, Code style). `app.ts` does not change: no route uses users until BE-02-02.

- `user/user.ts`: `userSchema` (Zod), the `User` type, `Role`, and `normalizeEmail()`.
- `core/password.ts`: `hashPassword()` with bcrypt. `verifyPassword()` is left to BE-02-02, its first caller.
- `seed/seed.ts`: `seedUsers({ users, accounts, logger })`, which inserts each account whose email is not yet stored.
- `config/config.ts`: `authConfigSchema`, so the config rules are testable without running `main.ts`.

```
main.ts
  config = loadConfig(authConfigSchema)                       ── top level, as today
  try {
    { repository, check, close } = await openRepository({ name: "users", schema: userSchema, config, logger })
    await seedUsers({ users: repository, accounts: [admin, user], logger })   ── before listen
    server = await listen(createApp({ checks: [check], docs, logger }), config.AUTH_PORT)
    onShutdown({ logger, server, tasks: [close] })
  } catch → existing "startup failed" path, exit 1
```

User record:

```ts
{
  id: string;            // randomUUID(); becomes the JWT `sub` in BE-02-02
  email: string;         // trimmed and lowercased
  passwordHash: string;  // bcrypt
  role: "user" | "admin";
  createdAt: string;     // ISO 8601
  version: number;       // managed by the repository
}
```

## Code Evidence

| Behavior | Source |
|---|---|
| Auth `main.ts` loads `baseConfigSchema.extend({ AUTH_PORT })`, passes `checks: []` and registers `onShutdown` with no tasks | `services/auth/src/main.ts` |
| `createApp({ checks, docs, logger })` mounts health, docs, 404 and error handlers only | `services/auth/src/app.ts` |
| `openRepository({ config, logger, name, schema })` returns `{ repository, check, close }`; the memory driver's check always passes; `name` must match `^[a-z][a-z0-9-]*$` | `libs/shared/src/storage.ts` |
| `storageConfigSchema` holds `STORAGE_DRIVER` (`memory` \| `file`, default `file`) and `DATA_DIR` (default `data`) | `libs/shared/src/storage.ts` |
| The file adapter validates every loaded record against the schema and refuses to start on a bad file | `tasks/BE-01-08-json-file-adapter.md`, `libs/shared/src/file-repository.ts` |
| `Repository<T>` has `find(predicate)`, `get`, `insert` (throws `DuplicateRecordError` on an existing `id`) and compare-and-set `update`; there is no unique index on other fields | `libs/shared/src/repository.ts` |
| `onShutdown` runs `tasks` in order after the HTTP server closes | `libs/shared/src/shutdown.ts` |
| `loadConfig(schema, env = process.env)` calls `safeParse` and throws `Invalid environment configuration` plus `z.prettifyError`, which names each failing path (`→ at SEED_ADMIN_PASSWORD`) but not its value | `libs/shared/src/config.ts` |
| `baseConfigSchema.NODE_ENV` defaults to `development`. Zod 4.6.7 runs an object's `.transform`/`.superRefine` only when every field parsed, so a production-only rule cannot be a field default; it needs optional fields plus an object-level check (verified against the repo's zod during review) | `libs/shared/src/config.ts`, `zod` 4.6.7 |
| The logger redacts the exact keys `password`, `token`, `accessToken` and `email` at up to two levels deep. `passwordHash` is not covered, so logging a user record would leak the hash | `libs/shared/src/logger.ts` (`REDACT_PATHS`) |
| Ultracite enables `lint/performance/noAwaitInLoops`; `shutdown.ts` uses a `biome-ignore` with a reason for its deliberate sequential loop | `node_modules/ultracite/config/biome/core/biome.jsonc`, `libs/shared/src/shutdown.ts` |
| pnpm has no `save-exact` setting here, so `pnpm add` writes a `^` range unless given `-E` | `pnpm-workspace.yaml`, `pnpm config get save-exact` |
| The `dev` and `start` scripts load `../../.env` with `--env-file-if-exists`, which never overrides a variable already set in the shell. `tsx watch` keeps running after the child exits, so it cannot show an exit code | `services/auth/package.json` |
| Under `pnpm dev`, Ctrl-C reaches the child twice and the second SIGINT skips shutdown tasks, so the lock file can be left behind; the next start logs `taking over a stale lock` and continues | `tasks/BE-01-08-json-file-adapter.md` (Code Evidence), `libs/shared/src/file-repository.ts` |
| Services run from their own folder, so `DATA_DIR=data` resolves to `services/auth/data`, already ignored by `.gitignore` | `services/auth/package.json`, `.gitignore` |
| `.env.example` lists no storage or seed variables yet | `.env.example` |
| No password-hashing library is installed | `services/auth/package.json` |

## Scope

- **User model** in `user/user.ts`, with fields as above. `normalizeEmail` trims and lowercases. The schema is strict enough for the file adapter's load validation: a valid email, a non-empty hash, a known role, an ISO datetime and a positive integer version.
- **Password hashing** in `core/password.ts` with `bcryptjs` at cost 10. Hashing is async so it does not block the event loop.
- **Repository lookups** in `libs/shared` (added during implementation at the user's request): `Repository<T>` gains `findOne(predicate)` and `findOneBy(where)`, each returning the first match in insertion order or `undefined`. `findOneBy` compares each given field with `===` and ignores `undefined` values. Both adapters implement them through shared helpers in `repository.ts`, return copies, and pass the contract suite.
- **Seeding** in `seed/seed.ts`. For each account it normalizes the email, looks it up with `findOneBy({ email })`, and only if it is missing hashes the password and inserts the user with a new UUID and the given role. An existing account is left alone, even when its password or role differs from the config, so a restart never resets a changed password. One `info` line per created account with `userId` and `role`, never email or password. When an existing account's role differs from the seeded role (for example the admin email already belongs to a `user`), it logs one `warn` line with `userId`, the stored role and the expected role, and still changes nothing. The function runs before `listen`, one account at a time, so seeding has no race. The sequential loop needs `// biome-ignore lint/performance/noAwaitInLoops: <reason>`, as in `shutdown.ts`.
- **Config** in `config/config.ts`, exported as `authConfigSchema` and loaded in `main.ts` with `loadConfig(authConfigSchema)`: `baseConfigSchema.extend(storageConfigSchema.shape).extend({ AUTH_PORT, SEED_* })`, moving `AUTH_PORT` over from `main.ts` unchanged. Add `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`.
  - Emails are `z.email()` and default to `admin@example.com` and `user@example.com` in every environment. They must differ after `normalizeEmail`.
  - Passwords must be 8 to 72 bytes, checked with `Buffer.byteLength` (`.max(72)` counts UTF-16 units, not bytes; bcrypt ignores everything past 72 bytes).
  - Passwords are `.optional()` fields, then one object-level `.transform((config, ctx) => …)` adds a `custom` issue with `path: ["SEED_ADMIN_PASSWORD"]` (or `SEED_USER_PASSWORD`) when `NODE_ENV` is `production` and the value is missing, adds one on `SEED_USER_EMAIL` when the emails match, and otherwise fills the demo defaults `Admin123!` and `User123!`. The output type then has both passwords as `string`. Issue messages must not include the value.
- **Wiring** in `main.ts`: open the `users` repository, seed, add its `check` to readiness, and register `close` as a shutdown task. An open or seed failure is caught by the existing `startup failed` path and exits 1.
- **Docs**:
  - `.env.example`: add `STORAGE_DRIVER=file`, `DATA_DIR=data`, `SEED_ADMIN_EMAIL=admin@example.com` and `SEED_USER_EMAIL=user@example.com`, and the two passwords as commented-out lines (`# SEED_ADMIN_PASSWORD=Admin123!`), so a copied `.env` never carries demo passwords into production.
  - `README.md`: under Install and run, a short storage paragraph (`STORAGE_DRIVER` `file` or `memory`, data in `services/<svc>/data`, `DATA_DIR`) and the seed variables, with the production rule. Replace the "will be added" line with a demo accounts table (email, password, role). Change the Health checks sentence that says auth has no dependencies: auth now reports `storage`. Adjust the `.env.example` sentence if it still claims every variable has a value.
- **Tests** (Jest, alongside the code):
  - `user/user.test.ts`: `normalizeEmail`; the schema accepts a valid user and rejects a bad role, email or missing hash.
  - `core/password.test.ts`: the hash is not the plaintext and verifies with `bcryptjs.compare`; two hashes of the same password differ.
  - `seed/seed.test.ts`, against `createMemoryRepository<User>()`: creates both accounts with the right roles and normalized emails; a second run creates nothing and keeps the same IDs; an existing account with a different hash is not overwritten; an existing account with the admin email but role `user` is left unchanged and triggers one `warn` log with no email in it; stored records hold no plaintext password.
  - `config/config.test.ts`, through `loadConfig(authConfigSchema, env)` with an otherwise valid env: production without seed passwords fails and the message names both variables; production with both passwords passes; outside production the defaults apply; a password of 73 bytes made of multi-byte characters (under 72 characters) fails; emails that differ only in case fail.

## Preserve

- `createApp`'s signature and every existing auth route and test.
- Existing `Repository<T>` methods and their behaviour, `openRepository` and the rest of `libs/shared`, apart from the two additions under Scope.
- The shared logger's redaction of `password` and `email`.

## Excluded

- `POST /auth/register`, `POST /auth/login`, `verifyPassword`, JWT issuing, and email uniqueness under concurrent registration (BE-02-02; see Follow-ups)
- Auth middleware and role guards (BE-02-03)
- Any users endpoint or OpenAPI change: no route is added
- Updating a seeded account's password or role from config, deleting users, user names or profile fields
- Refresh tokens, password reset, email verification, OAuth (out of scope per the Decisions table)

## Likely Files To Touch

- `services/auth/src/user/`, `core/`, `seed/`, `config/` (new): each module, its `*.test.ts` and an `index.ts`
- `services/auth/src/main.ts`
- `libs/shared/src/repository.ts`, `memory-repository.ts`, `file-repository.ts`, `index.ts`, `repository.test.ts`
- `services/auth/package.json`, `pnpm-lock.yaml` (`bcryptjs`)
- `.env.example`, `README.md`, `ROADMAP.md`, `AGENTS.md` (layout rule)

## Decisions Required Before Implementation

None.

Settled during intake on 2026-10-18, each the recommended option:
- **Hashing library:** `bcryptjs` (pure JavaScript, ships its own types, pinned to the exact version like other deps; 3.0.3 at intake). Rejected: native `bcrypt`, which needs a build step and an `allowBuilds` entry; `node:crypto` scrypt or argon2, which depart from the bcrypt named in the BE-02-02 row.
- **Cost factor:** 10, the bcrypt default and the OWASP minimum, as a module constant. Rejected: making it configurable, which adds a variable nothing needs yet.
- **Seed credentials:** env vars with demo defaults outside production, passwords required in production. Rejected: hard-coded credentials, which a deployment could not change; required everywhere, which forces every local run and test to set four extra variables.
- **Existing seeded accounts:** never overwritten. A role mismatch is logged as a warning so a missing admin is visible. Rejected: syncing password and role from config on every start, which would silently undo changes; staying silent on a role mismatch, which hides that no admin exists.
- **Seed passwords in `.env.example`:** commented out, so a copied `.env` never carries demo passwords into production; local runs use the code defaults. Rejected: listing them with values, which keeps the "every variable has a value" convention but lets a copied `.env` slip past the production check.
- **User ID:** a random UUID, not the email, so the JWT `sub` stays stable. Email uniqueness is therefore not enforced by the repository and is handled in BE-02-02.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons (for example the 72-byte bcrypt limit).
- Never log, or put in an error message, an email, password or hash.
- Add only `bcryptjs`, with `pnpm --filter @payment-be/auth add -E bcryptjs@3.0.3` (or the current latest, exact). Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`; if one turns out to be needed, stop and record why in this doc first.
- Tests use the memory adapter and must not write to `services/auth/data`.
- Set the BE-02-01 roadmap row to `in-progress` when starting.

## Deliverables

- Auth starts, seeds both accounts, reports `storage` in readiness and closes the repository on shutdown.
- The new modules and tests listed under Scope.
- `.env.example`, `README.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual seed run, from the repo root: `rm -rf services/auth/data`, then `STORAGE_DRIVER=file pnpm --filter @payment-be/auth dev` (it reads `../../.env` relative to `services/auth`; the shell value wins). It logs two seeded users. `curl localhost:3001/health/ready` returns `{"checks":{"storage":"ok"},"status":"ok"}`. Stop it with Ctrl-C and start it again: no user is created (a `taking over a stale lock` warning is expected, see Code Evidence). `services/auth/data/users.json` holds two records with `$2` bcrypt hashes and neither demo password.
- Manual production check, after `pnpm build`, without `.env`: `cd services/auth && env -u SEED_ADMIN_PASSWORD -u SEED_USER_PASSWORD NODE_ENV=production node dist/main.js; echo $?` prints an error naming both variables and `1`. With both passwords set and `STORAGE_DRIVER=memory` it starts.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc. `services/auth/data/` is ignored and does not appear.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-02-01 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-02-02: register must reject a taken email (normalized) with `409`. `find` then `insert` spans an `await`, so two concurrent registrations for one email can both pass the check; serialize the check-and-insert in the auth service (for example a single in-process promise chain), which is enough for one instance. Add `verifyPassword`, compare against a dummy hash when the email is unknown so response time does not reveal which emails exist, and cap passwords at 72 bytes as the seed config does.
- BE-02-02: register passes `role: "user"` explicitly; the request schema never accepts a role.
