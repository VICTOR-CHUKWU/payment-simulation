# payment-be

A payment processing service built as TypeScript + Express microservices that communicate over NATS JetStream. The project overview is in [README.md](README.md); scope, decisions and status live in [ROADMAP.md](ROADMAP.md).

## Commands

Run everything from the repo root with pnpm (Node 24, pnpm version pinned in `packageManager`).

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspaces |
| `pnpm dev` | Run all services with `tsx watch`, reading `libs/shared` from source |
| `pnpm build` | `tsc -b` across all packages into each `dist/` |
| `pnpm start` | Run the compiled services from `dist/` |
| `pnpm typecheck` | Typecheck all source and test files, no output |
| `pnpm test` | Jest (ESM) across all packages |
| `pnpm check` | Ultracite (Biome) lint and format check, read-only |
| `pnpm fix` | Ultracite autofix |
| `pnpm infra:up` | Start NATS (JetStream) and Mailpit in Docker, waiting until healthy |
| `pnpm infra:down` | Stop the containers, keep JetStream data |
| `pnpm infra:logs` | Follow the container logs |
| `pnpm infra:reset` | Stop the containers and delete JetStream data |

Before calling work done, run `pnpm check`, `pnpm typecheck` and `pnpm test`, plus `pnpm build` when package boundaries or tsconfigs change.

## Toolchain notes

- TypeScript stays on 6.x. ts-jest does not support TypeScript 7.
- `libs/shared` exports only `development` (source) and `default` (dist). Do not add a `types` condition: Biome's autofix sorts it ahead of `development`, which makes TypeScript read stale `dist` types. TypeScript finds `dist/index.d.ts` next to `default` by itself.
- A new package needs: `"type": "module"`, a `tsconfig.json` extending `../../tsconfig.base.json` with `rootDir: src`, `outDir: dist` and `tsBuildInfoFile: dist/.tsbuildinfo`, a reference to `../../libs/shared` if it imports it, and an entry in the root `tsconfig.json` references.
- `pnpm test` runs Jest with `--experimental-vm-modules` for ESM and `--disable-warning=ExperimentalWarning` to hide Node's notice about that flag. Run it from the repo root; `pnpm test -- services/auth` runs one package.
- Biome's ignores come from the Ultracite preset (`dist`, `coverage`) and `.gitignore` (`services/*/data/`). Do not add a `files.includes` block with folder-name negations such as `!**/data`: it would also skip source folders with that name.
- If `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`, add the named packages to `allowBuilds` in `pnpm-workspace.yaml`. pnpm writes placeholder entries there itself; replace them rather than adding a second `allowBuilds` key.

## Planning workflow

- [ROADMAP.md](ROADMAP.md) is the source of truth for scope and status. Read it before starting work, and check the Decisions table before choosing a library or pattern.
- Roadmap rows stay to a title, status and task-doc link. Execution detail goes in task docs, never in the roadmap.
- Milestone IDs use `BE-<phase>-<milestone>`, both two-digit (`BE-01-02` is phase 1, milestone 2). IDs are stable once assigned: a new milestone takes the next free number in its phase, and reordering rows never renumbers them.
- When you start, finish or block a milestone, update its status in the roadmap.

## Task docs

- Task docs live in `tasks/`, named `<ID>-<slug>.md` using the lowest milestone ID they cover (e.g. `tasks/BE-01-01-monorepo-scaffold.md`, or `tasks/BE-05-05-email-retries-dlq.md` for BE-05-05 and BE-05-06).
- Each task doc lists the milestone IDs it covers at the top, and the roadmap's "Task doc" column links back to it.
- Do not implement a milestone that involves open decisions without an approved task doc. BE-01-08, BE-02-01, BE-02-02, BE-03-01, BE-03-04, BE-03-05, BE-03-06, BE-03-07, BE-04-01, BE-04-02, BE-05-02, BE-05-05 and BE-05-06 need one.
- A milestone is not done until it ships with its own unit tests (and supertest API tests for endpoints). Phase 6 only closes gaps.
- Every endpoint is registered in its service's OpenAPI spec in the same change that adds it, including error responses.
- When a milestone changes setup, env vars, endpoints or test commands, update the matching README section in the same change. BE-06-05 only finalises it.

## Code style

- No code comments unless one is essential to explain a non-obvious reason (a workaround, a protocol quirk, a deliberate trade-off). Never comment what the code already says.
- No `console.*` anywhere, including scripts and tests. Log through the shared pino logger (from BE-01-05).
- Service source is organised by folder under `src/`: `config/` (env schema), `core/` (cross-cutting helpers such as `password.ts`), one folder per module (`user/`, `payment/`, …) holding its model and, as they arrive, its controller, routes and service, plus task folders such as `seed/`. Module files other than the model are named `<module>.<role>.ts` (`auth.service.ts`, `user.service.ts`). `app.ts`, `main.ts` and `openapi.ts` stay at the root of `src/`. Tests sit next to the file they cover.
- Each folder has an `index.ts` that re-exports its public API by name (no `export *`), starting with `// biome-ignore lint/performance/noBarrelFile: module entry point`. Code outside a folder imports from its `index.js`; files inside a folder import siblings directly.

## Architecture constraints

- Layout: `services/auth`, `services/payment`, `services/notification`, and `libs/shared`, in pnpm workspaces. Use `pnpm` for every install and script; never `npm` or `yarn`.
- Services never import each other's code. Shared code (event contracts, NATS client wrapper, logger, error model, config, auth middleware) goes in `libs/shared`.
- Each service owns its data through a repository interface (in-memory and JSON-file adapters). No service reads another's storage.
- Services communicate only through NATS events, with one exception: services verify JWTs locally using the shared secret and never call `auth` at runtime.
- Payment events carry `userId` and email so the notification service never looks users up.
- Validate HTTP input and event payloads with Zod at the boundary. Return errors only through the central error model.
- Pass request/correlation IDs into event headers and include them in every log line. Never log passwords, tokens or auth headers.
- Store money as integer minor units with an ISO 4217 currency code. Never use floats for amounts.
- Every event carries a unique ID, and consumers must be idempotent: JetStream can deliver the same message more than once. Dedupe per channel (`eventId` + channel), never by event ID alone, so an email retry is not dropped once the in-app notification exists.
- Status changes go through the repository's compare-and-set update, so a concurrent admin PATCH and processor update cannot overwrite each other.

## Scope guard

Phase 7 (stretch) is deferred: do not start its milestones unless the user re-enables it. Keep auth limited to what the Decisions table lists: no refresh tokens, password reset, email verification or OAuth.
