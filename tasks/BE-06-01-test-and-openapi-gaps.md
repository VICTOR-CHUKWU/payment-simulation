# BE-06-01: Close unit, API and OpenAPI gaps

**Covers:** BE-06-01, BE-06-02, BE-06-04
**Status:** todo

## Objective

Audit what every package already tests and documents, close the gaps, and leave evidence that nothing is missing. When this task is done:

- Each package's unit tests cover the state machine, services, repositories, the payment processor and outbox relay, and the notification handlers, channels and DLQ. A coverage report can be generated with one command.
- Every HTTP endpoint has supertest tests for its happy path and for every error status its OpenAPI operation documents.
- Every service's OpenAPI document is complete: a description and examples on each operation, every error response the route can return, and bearer auth on every protected route. A test in each service checks these rules, so a future endpoint cannot skip them.

This is gap-closing work. It adds tests, OpenAPI metadata and a coverage script; it does not change runtime behaviour. A real bug found by a new test is fixed in this task only if the fix is small and local; anything larger is recorded under Follow-ups.

## Source Context

Roadmap Phase 6 milestones in `ROADMAP.md`:

- BE-06-01: "Unit test suite completed: gaps closed across state machine, services, repositories, processor and notification handlers, plus a coverage report"
- BE-06-02: "API test suite completed with supertest (happy paths + error responses for every endpoint)"
- BE-06-04: "OpenAPI spec reviewed for completeness across all services (examples, error responses, auth)"

On 2026-10-19 the user chose to run Phase 6 as three task docs. This one groups the three gap audits because they share one method (inventory, compare, fill) and need no new infrastructure. BE-06-03 (integration tests) and BE-06-05 to BE-06-07 (docs and release) have their own docs. `AGENTS.md` says a milestone ships with its own tests and "Phase 6 only closes gaps", so most behaviour is already covered and this task finds what slipped through.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- **Coverage:** a root script `pnpm test:coverage` runs Jest with `--coverage`, using the `v8` provider, text-summary output in the terminal and an HTML report in `coverage/` (already git-ignored). Coverage is collected from `libs/*/src` and `services/*/src`, excluding `**/*.test.ts`, `**/index.ts` (barrels) and `services/*/src/main.ts` (process entry points, exercised by the manual and integration checks).
- **No coverage threshold.** The report is evidence for this task, not a gate. A threshold is a follow-up if the user wants one.
- **A `500` response on every operation.** The central error handler can return `500 internal-error` from any route, so every operation documents it.
- **Examples come from Zod `.meta({ example })`** on request and response schemas, so `@asteasolutions/zod-to-openapi` emits them and they stay next to the schema they describe.
- **No new dependencies.** The OpenAPI rule test walks the generated document itself, with no external validator.

## Design Reference

- `AGENTS.md`: "A milestone is not done until it ships with its own unit tests (and supertest API tests for endpoints). Phase 6 only closes gaps." "Every endpoint is registered in its service's OpenAPI spec in the same change that adds it, including error responses." Tests sit next to the file they cover. No `console.*`.
- `ROADMAP.md`, Decisions table: Testing ("Jest + supertest (unit + API) …"), API docs ("OpenAPI spec generated from the Zod schemas (`@asteasolutions/zod-to-openapi`), served via Swagger UI at `/docs` … Each endpoint milestone registers its route").
- Earlier task docs (`tasks/BE-0*.md`) list the tests each milestone shipped; they are the baseline for "already covered".

## Current State

Test files and source files per package (source excludes `*.test.ts`):

| Package | Test files | Source files |
|---|---|---|
| `libs/shared` | 19 | 22 |
| `services/auth` | 9 | 20 |
| `services/payment` | 11 | 20 |
| `services/notification` | 19 | 33 |

`pnpm test` passes 813 tests in 58 suites as of commit `5a96921`.

Source files with no sibling `*.test.ts` (barrels excluded), and what covers them today:

| File | Covered today by |
|---|---|
| `services/*/src/main.ts` | Nothing automated; manual checks only. Excluded from coverage (see defaults). BE-06-03 exercises them |
| `services/*/src/openapi.ts`, `*/*.openapi.ts` | Each service's `app.test.ts` fetches `/docs/openapi.json` and checks some paths |
| `*/*.controller.ts`, `*/*.schema.ts` | The module's `*.routes.test.ts` through `createApp` |
| `services/auth/src/auth/auth.limiter.ts` | `services/auth/src/auth/auth.routes.test.ts` and `app.test.ts` (429 path) |
| `libs/shared/src/memory-repository.ts` | `libs/shared/src/repository.test.ts` |
| `libs/shared/src/jetstream-helpers.ts` | Indirectly through `streams.test.ts` and `consumers.test.ts`; no direct test |

Endpoints and the statuses their OpenAPI operations document today (from each service's `buildDocument()`):

| Service | Method and path | Documented statuses | Auth |
|---|---|---|---|
| auth | `POST /auth/register` | 201, 400, 409, 413, 415 | public |
| auth | `POST /auth/login` | 200, 400, 401, 413, 415, 429 | public |
| payment | `POST /payments` | 200, 201, 400, 401, 413, 415, 422 | bearer |
| payment | `GET /payments/{id}` | 200, 400, 401, 404 | bearer |
| payment | `PATCH /payments/{id}/status` | 200, 400, 401, 403, 404, 409, 413, 415 | bearer, admin |
| notification | `GET /notifications` | 200, 400, 401 | bearer |
| notification | `PATCH /notifications/read` | 200, 401 | bearer |
| notification | `PATCH /notifications/{id}/read` | 200, 400, 401, 404 | bearer |
| notification | `GET /admin/dlq` | 200, 400, 401, 403 | bearer, admin |
| notification | `GET /admin/dlq/{seq}` | 200, 400, 401, 403, 404 | bearer, admin |
| notification | `POST /admin/dlq/{seq}/replay` | 200, 400, 401, 403, 404, 409, 500, 502 | bearer, admin |
| all three | `GET /health/live`, `GET /health/ready` | 200; 200, 503 | public |

OpenAPI gaps already visible:

- Only problem responses carry examples (`problemResponses` attaches one from `problemExample`). No request body or success response has an example.
- `GET /health/live` and `GET /health/ready` have no description (`libs/shared/src/openapi.ts`, `createOpenApiRegistry`).
- `500` is documented only on the DLQ replay.
- Each document's `info` is just `{ title: "<name> service", version: "0.0.0" }`, with no description.

## Code Evidence

| Behavior | Source |
|---|---|
| Jest runs ESM through `ts-jest` with roots `libs` and `services`; no coverage settings | `jest.config.js`, root `package.json` (`test` script) |
| `coverage/` is git-ignored | `.gitignore` |
| `createOpenApiRegistry` registers the bearer scheme and the two health paths; `buildOpenApiDocument` adds `ProblemDetails`; `problemResponses(...statuses)` attaches an example per status | `libs/shared/src/openapi.ts` |
| Each service builds its document in `src/openapi.ts` from its modules' `register*Paths` functions | `services/*/src/openapi.ts`, `services/*/src/*/*.openapi.ts` |
| `errorHandler` returns `500 internal-error` for any unexpected error | `libs/shared/src/errors.ts` |
| Route tests drive `createApp` with supertest and in-memory repositories; protected routes sign tokens with `jose` | `services/*/src/*/*.routes.test.ts` |
| Each service's `app.test.ts` fetches `/docs/openapi.json` | `services/*/src/app.test.ts` |

## Scope

1. **Inventory.** For each package, list the behaviours named in BE-06-01 (state machine and transitions, services, repositories and both adapters, processor and gateway, outbox relay, notification handler, inbox, in-app service, email channel and retry rules, DLQ publisher and service) and the test that covers each, and mark the gaps. Then build the endpoint matrix: every endpoint in the table above × every documented status × the test that triggers it. Record both in the PR description, not in a new file.
2. **Unit test gaps (BE-06-01).** Add tests for each gap found, next to the file they cover. At minimum, a direct `jetstream-helpers.test.ts`. Use the coverage report to find untested branches in the listed areas; chase meaningful branches, not a percentage.
3. **Coverage script (BE-06-01).** `pnpm test:coverage` and the Jest coverage settings above. `pnpm test` stays as it is and does not collect coverage.
4. **API test gaps (BE-06-02).** Every cell of the endpoint matrix has a supertest test that asserts the status and, for errors, the problem `code`. A `413` or `415` can be one shared parameterised test per service where the routes share the body parser. `500` can be one test per service that injects a failing repository.
5. **OpenAPI completeness (BE-06-04).** For every operation in all three services:
   - a `summary`, a `description` and a tag;
   - an example on the request body (if any) and on each `2xx` response;
   - every status the route can return, including `500`; and for protected routes `401`, plus `403` on admin routes;
   - `security: bearerSecurity` on every protected route, and none on public ones;
   - descriptions for the two health operations, and an `info.description` per service.
6. **OpenAPI rule test (BE-06-04).** In each service, a test (in `openapi.test.ts`, next to `openapi.ts`) walks `buildDocument()` and fails if any operation breaks the rules in step 5. Where the rule needs knowledge of the route (public or admin), the test holds a small expected table of operations. The test also fails if the document has an operation the table does not list, so a new endpoint must be added to it.
7. **README "Testing"**: add `pnpm test:coverage` and where the HTML report lands. BE-06-05 rewrites this section later; keep this change to one or two sentences.
8. **Roadmap**: set BE-06-01, BE-06-02 and BE-06-04 to `in-progress` when starting and `done` when finished.

## Preserve

- Runtime behaviour of every service, and every existing test (a test may be strengthened, not weakened or deleted, unless it duplicates a new one).
- `pnpm test` runs without Docker and without coverage.
- The shared OpenAPI helpers' signatures; additions such as a new helper are fine.

## Excluded

- Cross-service and NATS-backed tests (BE-06-03).
- README and architecture rewrites (BE-06-05, BE-06-06).
- A coverage threshold or CI wiring (CI is BE-07-04, deferred with Phase 7).
- Refactors made only to raise coverage.

## Likely Files To Touch

- `jest.config.js`, root `package.json` (`test:coverage`)
- `libs/shared/src/jetstream-helpers.test.ts` (new), `libs/shared/src/openapi.ts` (health descriptions)
- New and existing `*.test.ts` across `libs/shared` and `services/*`
- `services/*/src/openapi.ts`, `services/*/src/openapi.test.ts` (new), `services/*/src/*/*.openapi.ts`, `services/*/src/*/*.schema.ts` (examples)
- `README.md` ("Testing"), `ROADMAP.md`

## Prerequisites

BE-05-05 and BE-05-06 are merged to `main` as of commit `5a96921`. Can run in parallel with BE-06-03.

## Decisions Required Before Implementation

None. The defaults above stand unless changed in this doc.

## Execution Rules

- No `console.*`; no comments unless essential.
- No dependency changes. `jest.config.js` and the root `package.json` may change only for coverage.
- A bug fix found by a new test goes in this task only if it is small and local; record anything larger under Follow-ups and leave its test skipped with a reason.

## Deliverables

- Closed unit and API test gaps, the `pnpm test:coverage` script and report.
- Complete OpenAPI documents and an OpenAPI rule test per service.
- The inventory and endpoint matrix in the PR description.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

- All exit 0 with Docker stopped. `pnpm test:coverage` prints a summary and writes `coverage/index.html`; paste the summary into the PR.
- The endpoint matrix in the PR has a test named in every cell.
- Breaking a rule (for example deleting the example from one schema, or the `401` from one protected operation) makes that service's `openapi.test.ts` fail; revert after checking.
- Swagger UI at `/docs` on each service (with `pnpm infra:up` and `pnpm dev`) shows examples on request bodies and success responses.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and BE-06-01, BE-06-02 and BE-06-04 in `ROADMAP.md` are `done` and link to this file.

## Follow-ups

- A coverage threshold in Jest once the numbers are known.
- Bugs found by new tests that were too large to fix here.
