# BE-01-01: Monorepo scaffold

**Covers:** BE-01-01
**Status:** done

## Objective

Create an empty but working monorepo. After one `pnpm install` on a fresh clone, `pnpm dev`, `check`, `typecheck`, `test` and `build` all succeed. Every later milestone adds code to this structure, so it must be simple, strict and easy for a reviewer to run.

Priority: KISS first, DRY second. Share config where duplication would drift (TypeScript base config, one Biome config). Keep per-package scripts small and explicit rather than generated or abstracted.

## Source Context

Roadmap milestone BE-01-01 in `ROADMAP.md`. Every decision taken during intake is restated in this doc.

The toolchain was tested by building a scratch copy before implementation, with pnpm 11.21, Node 24.19, TypeScript 6.0.3, Jest 30.5.2, ts-jest 29.4.15, tsx 4.23.15 and Ultracite 8.0.1. The setup below is the one that worked.

## Design Reference

- `ROADMAP.md`, the Decisions table (runtime, architecture, lint and format, testing, task runner)
- `AGENTS.md`, the Code style and Architecture constraints sections

## Architecture Summary

A pnpm workspaces monorepo with three services under `services/` and one shared library under `libs/shared`. TypeScript project references let `tsc -b` build and typecheck everything in dependency order. In dev and tests, services read the shared lib's TypeScript source through a `development` export condition, so changes show up without a build step. The production build compiles each package to `dist`, and services resolve the shared lib's `dist` output. Root pnpm scripts are the only entry point.

## Code Evidence

At intake: none. The repo contained only `AGENTS.md`, `CLAUDE.md`, `README.md`, `ROADMAP.md` and an empty `tasks/` folder, and was not a git repository.

## Current Behavior To Preserve

- `CLAUDE.md` contains only `@AGENTS.md`. Keep it that way.
- Planning docs keep their current structure. Only the sections named in Deliverables change.

## Prerequisites

- Node.js 24 LTS.
- pnpm, through `corepack enable` or a standalone install. Corepack ships with Node 24 but is off by default, and Node 25+ no longer bundles it. pnpm switches itself to the version pinned in `packageManager`.

## Scope

**Repository basics**
- `git init` with a `.gitignore` covering `node_modules`, `dist`, `coverage`, `.env`, `*.tsbuildinfo` and runtime data files (a `data/` directory per service).
- `.nvmrc` pinned to Node 24, and `"engines": { "node": ">=24" }` in the root `package.json`.
- `"packageManager": "pnpm@<exact version>"` in the root `package.json`, and `pnpm-lock.yaml` committed.
- `git init` and `.gitignore` come before the first `pnpm check`, because the Ultracite preset reads the ignore file through `vcs.useIgnoreFile`.

**Workspaces**
- Root `package.json` with `"private": true`, and `pnpm-workspace.yaml` listing `services/*` and `libs/*`.
- `pnpm-workspace.yaml` also has an `allowBuilds:` map naming every dependency whose install script pnpm reports as ignored (esbuild, @parcel/watcher and unrs-resolver at review time). Without it, pnpm 11 exits 1 with `ERR_PNPM_IGNORED_BUILDS` on a fresh install. Set each entry to `false` unless the package needs its build script. Check how the pinned pnpm version handles ignored builds before writing the map.
- Four packages: `@payment-be/auth`, `@payment-be/payment`, `@payment-be/notification` (in `services/`) and `@payment-be/shared` (in `libs/shared`).
- Each service depends on `@payment-be/shared` with `"workspace:*"`. pnpm does not hoist undeclared dependencies, so every package declares what it imports.

**TypeScript**
- TypeScript pinned to the latest 6.x (6.0.3 at review time). Do not use TypeScript 7: it is the native port, exposes no compiler API, and ts-jest's peer range is `>=4.3 <7`.
- Root `tsconfig.base.json` extended by every package, with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `composite`, `module` and `moduleResolution` set to `nodenext`, and `customConditions: ["development"]`.
- ESM throughout. Every package sets `"type": "module"`, and relative imports end in `.js`.
- Each package has a `tsconfig.json` with `rootDir: src`, `outDir: dist`, `tsBuildInfoFile: dist/.tsbuildinfo` and `exclude: ["**/*.test.ts"]`. Keeping build info inside `dist` means deleting `dist` always forces a rebuild; otherwise `tsc -b` sees a stale `.tsbuildinfo`, emits nothing and exits 0.
- Every service's `tsconfig.json` references `../../libs/shared`. The reference is what makes `customConditions` safe in the build: TypeScript swaps shared's source for its `.d.ts` output, so there are no rootDir errors (TS6305 or TS6307).
- A root `tsconfig.json` with `files: []` lists all four packages as references, so `tsc -b` covers the repo.
- A root `tsconfig.test.json` extends the base with `composite: false`, `noEmit: true` and `types: ["jest", "node"]`, and includes `libs/*/src` and `services/*/src` with their test files. TypeScript 6 defaults `types` to `[]`, so without this setting test files fail with "Cannot find name 'describe'". `@types/jest` and `@types/node` are root dev dependencies.

**Shared lib resolution**
- `libs/shared/package.json` exports `.` with a `development` condition pointing to `./src/index.ts` and a `default` condition pointing to `./dist/index.js`. There is no `types` condition: Biome's autofix sorts `types` ahead of `development`, which made TypeScript read `dist` types in dev and typecheck. TypeScript finds `dist/index.d.ts` next to `default` without it.
- tsx runs services with `--conditions=development`. Jest resolves the same condition through `testEnvironmentOptions.customExportConditions`. TypeScript uses `customConditions`. One mechanism everywhere, no path aliases.

**Lint and format**
- Biome through Ultracite, configured once at the repo root, with exact pinned versions of both `ultracite` and `@biomejs/biome` (Ultracite needs Biome `^2.5.0` as a peer dependency).
- `biome.jsonc` extends `["ultracite/biome/core"]`, and adds `ultracite/biome/jest` if its rules suit the tests.
- The Ultracite preset sets `noConsole` to `off`, so `biome.jsonc` must override `linter.rules.suspicious.noConsole` to `"error"`. It applies to source, tests and scripts.
- `check` runs `ultracite check` and `fix` runs `ultracite fix`.
- `node_modules`, `dist` and `coverage` are excluded by the Ultracite preset, and data folders by `.gitignore` through `vcs.useIgnoreFile`. No `files.includes` block: a `!**/data` negation also skipped source folders named `data`.

**Testing**
- Jest with ts-jest in ESM mode (`useESM`, `extensionsToTreatAsEsm: [".ts"]`), transpiling only. No ts-jest preset, since the explicit transform covers it. Type errors are caught by `typecheck`, not by Jest.
- ts-jest's `tsconfig` option points at `tsconfig.test.json`. Its default is the root `tsconfig.json`, which has no compiler options. Do not set ts-jest's own `isolatedModules` option: it is deprecated and prints a warning. Transpile-only behaviour comes from `isolatedModules: true` in the tsconfig.
- `testEnvironmentOptions.customExportConditions` is `["development", "node", "node-addons"]`. Without `development`, Jest cannot find `@payment-be/shared`.
- Tests use Jest's injected globals (`describe`, `it`, `expect`). Importing from `@jest/globals` would need it declared in every package, because pnpm is strict.
- Run Jest through `node --experimental-vm-modules` called directly in the script (not through `NODE_OPTIONS`), so it works on every OS.
- One root Jest config covering all packages. Test files sit next to source as `*.test.ts`.
- A mapping strips `.js` from relative imports so ESM imports resolve to `.ts` files.

**Placeholder code**
- `libs/shared/src/index.ts` exports one constant (for example the package name).
- Each service has `src/main.ts` that imports that constant and does nothing visible. Express, logging and ports arrive in later milestones.
- One smoke test per package. Each service's test proves that importing `@payment-be/shared` works under Jest.

**Root scripts**
- `dev`: starts all three services in parallel with `tsx watch` through `pnpm -r --parallel --filter "./services/*" dev`. pnpm prefixes each line with the package name, so no extra runner such as `concurrently` is needed.
- `build`: `tsc -b`.
- `start`: runs each service's compiled `dist/main.js` in parallel, the same way as `dev`.
- `typecheck`: `tsc -p tsconfig.test.json`, which typechecks all source and test files and emits nothing.
- `check`: Ultracite check, read-only.
- `fix`: Ultracite fix.
- `test`: Jest.
- Each package keeps only the scripts the root needs (for example `dev` and `start`).

**Environment**
- Root `.env.example` with only the variables the scaffold uses: `NODE_ENV`, `LOG_LEVEL`, and `AUTH_PORT`, `PAYMENT_PORT` and `NOTIFICATION_PORT`. Later milestones add their own variables.
- Services load the root `.env` with Node's built-in `--env-file-if-exists=../../.env`. The path is relative because `pnpm -r` runs each script from its package directory. A missing `.env` does not crash. No dotenv dependency.
- Service `dev` script: `tsx watch --conditions=development --env-file-if-exists=../../.env src/main.ts`. Service `start` script: `node --env-file-if-exists=../../.env dist/main.js`.

**Docs**
- `AGENTS.md`: replace the "no commands yet" paragraph with the verified commands.
- `README.md`: fill "Getting started" with prerequisites (Node 24, and pnpm through `corepack enable` or a standalone install) and the install, dev, test and check commands. Docker steps come with BE-01-03.
- `ROADMAP.md`: the BE-01-01 row already links this doc. Set its status to `in-progress` when work starts and `done` at the end.

## Excluded

- Express, health endpoints and graceful shutdown (BE-01-04).
- Logger and error model (BE-01-05, BE-01-06). Placeholders print nothing.
- Config loader and env validation (BE-01-02).
- docker-compose, NATS and Mailpit (BE-01-03).
- Pre-commit hooks and CI (CI is BE-07-04).
- Turborepo, Nx or any other build orchestrator.
- Path aliases.

## Pre-Implementation Verification

- Confirm the repo still has no code and no `package.json`. If someone has started a scaffold, adapt to it instead of replacing it.
- Pin exact versions of pnpm, TypeScript 6.x, tsx, Jest, ts-jest, `@types/jest`, `@types/node`, Ultracite and `@biomejs/biome`. Check ts-jest's `typescript` and `jest` peer ranges and Ultracite's Biome peer range before pinning. If a version differs from those listed in Source Context, rerun the affected checks.

## Likely Files To Touch

- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`, `.nvmrc`, `.env.example`
- `tsconfig.base.json`, `tsconfig.json`, `tsconfig.test.json`
- `biome.jsonc`
- `jest.config.*`
- `libs/shared/{package.json,tsconfig.json,src/index.ts,src/index.test.ts}`
- `services/{auth,payment,notification}/{package.json,tsconfig.json,src/main.ts,src/main.test.ts}`
- `AGENTS.md`, `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None. Settled during intake:
- Test runner: Jest, as in the roadmap.
- Shared lib: source through the `development` condition in dev and tests, `dist` in build.
- Module format: ESM with `nodenext`.
- Package manager: pnpm. Parallel dev runner: `pnpm -r --parallel`, with no `concurrently`.

## Execution Rules

- No code comments unless one explains a non-obvious reason. No `console.*` anywhere.
- No dependency the scaffold does not use yet. Express, pino, Zod and the rest arrive with their milestones.
- Pin exact versions for all dev tooling.
- Keep scripts runnable on macOS, Linux and Windows. No shell-only syntax such as `VAR=value cmd` or `&&` chains that depend on bash.

## Deliverables

- A workspace that installs with one `pnpm install` and passes all root scripts.
- Four packages with placeholder entry points and smoke tests.
- One Biome config, one TypeScript base config and one Jest config, all at the root.
- Updated `AGENTS.md`, `README.md` and `ROADMAP.md`.

## Completion Verification

Run from a fresh clone, or after deleting `node_modules`, every `dist` and any `*.tsbuildinfo`:

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm start
pnpm dev
```

- `pnpm install` exits 0 with no `ERR_PNPM_IGNORED_BUILDS`.
- `check`, `typecheck`, `test` and `build` exit 0, and `check` reports a non-zero number of files checked.
- `pnpm test` runs four smoke tests, all passing.
- `pnpm build` produces `dist/` in all four packages.
- `pnpm start` exits 0. With `libs/shared/dist` deleted, `pnpm start` fails with `ERR_MODULE_NOT_FOUND`, which proves the build resolves `dist` and not `src`. Rebuild afterwards.
- A temporary `process.exitCode = 7` in one service's `main.ts` makes `pnpm start` exit non-zero, which proves child failures surface. Remove it afterwards.
- `pnpm dev` prints a `services/<name> dev$` line for each of the three services and keeps running. Editing `libs/shared/src/index.ts` prints a tsx rerun line for each service, with no build step. Stop it with Ctrl+C.
- Adding `console.log("x")` to any service file makes `pnpm check` fail. Remove it afterwards.
- A type error in a test file makes `pnpm typecheck` fail.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, the docs list only commands that were run and work, and the BE-01-01 row in `ROADMAP.md` is `done` with a link to this file.

## Follow-ups

- BE-01-03: docker-compose and the `infra:*` scripts.
- BE-01-02: config loader with Zod env validation, which replaces the bare `--env-file-if-exists` reads.
- BE-01-04: Express skeleton, which replaces the placeholder `main.ts` files.
