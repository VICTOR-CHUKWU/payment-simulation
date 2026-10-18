# BE-01-09: OpenAPI setup per service

**Covers:** BE-01-09
**Status:** done

## Objective

Each service serves Swagger UI at `/docs` and its OpenAPI 3.1 spec at `/docs/openapi.json`, generated from Zod schemas. A developer can call every route from Swagger, including protected ones: the spec declares a `bearerAuth` scheme, so Swagger UI shows an **Authorize** button that sends `Authorization: Bearer <token>`. The docs routes exist only when `NODE_ENV=development`. The shared lib provides the registry, security and error-response helpers that every later endpoint milestone uses to register its routes.

## Source Context

Roadmap milestone BE-01-09 in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-18. The user asked to be able to do everything in Swagger, including authenticating routes where needed, with the docs available only when `NODE_ENV` is `development`. The user approved the inventory and every recommended decision listed under Decisions Required Before Implementation. A review spike on the same day ran the shared helpers as specified under Scope against the real packages in a scratch project (outside the repo): `tsc` with this repo's compiler options and Biome with the Ultracite core preset passed, and the library rows under Code Evidence come from that run.

## Design Reference

- `ROADMAP.md`, Decisions table, API docs: "OpenAPI spec generated from the Zod schemas (`@asteasolutions/zod-to-openapi`), served via Swagger UI at `/docs`, summarised in README. Each endpoint milestone registers its route."
- `ROADMAP.md`, Decisions table, Auth: other services verify JWT access tokens locally; the token is issued by `POST /auth/login` (BE-02-02).
- `AGENTS.md`, Task docs: "Every endpoint is registered in its service's OpenAPI spec in the same change that adds it, including error responses."
- `README.md`, API section: "Not available yet. Each service will serve Swagger UI, and endpoints will be summarised here."

## Architecture Summary

`libs/shared/src` gains one flat module, `openapi.ts`, re-exported from `index.ts`. Each service gains `src/openapi.ts`, which builds that service's document, and a `docs` option on `createApp`.

```
services/<svc>/src/openapi.ts                 libs/shared/src/openapi.ts
  buildDocument()                               createOpenApiRegistry()  ── bearerAuth, /health/*
    registry = createOpenApiRegistry()          bearerSecurity           ── [{ bearerAuth: [] }]
    (later milestones register routes here)     problemResponses(...)    ── application/problem+json responses
    return buildOpenApiDocument(registry, …)    buildOpenApiDocument()   ── OpenAPI 3.1 document, always with ProblemDetails
                                                docsRouter(document)     ── GET /docs/openapi.json, then Swagger UI under /docs
services/<svc>/src/app.ts
  createApp({ checks, logger, docs })  ── mounts docsRouter(buildDocument()) before notFoundHandler when docs is true
services/<svc>/src/main.ts
  docs: config.NODE_ENV === "development"
```

Using auth from Swagger once BE-02-02 lands: open `localhost:3001/docs`, run `POST /auth/login`, copy `accessToken`, open `localhost:3002/docs` (or 3003), click **Authorize** and paste it. Each port is its own browser origin, so the token is pasted once per service; `persistAuthorization` keeps it across reloads.

## Code Evidence

| Behavior | Source |
|---|---|
| Each service's `createApp({ checks, logger })` mounts `httpLogger`, `healthRouter(checks)`, `notFoundHandler`, `errorHandler`, in that order. The three files are identical | `services/*/src/app.ts` |
| `main.ts` loads config with `baseConfigSchema.extend(...)` and already branches on `config.NODE_ENV === "development"` for pretty logs | `services/*/src/main.ts` |
| `NODE_ENV` is `z.enum(["development", "test", "production"]).default("development")` | `libs/shared/src/config.ts` (`baseConfigSchema`) |
| `problemDetailsSchema` is a Zod object for the error body; errors are sent as `application/problem+json` | `libs/shared/src/errors.ts` (`problemDetailsSchema`, `errorHandler`) |
| `notFoundHandler` turns any unmatched path into a `not-found` problem | `libs/shared/src/errors.ts` |
| `GET /health/live` returns `{ status: "ok" }`; `GET /health/ready` returns `{ checks: Record<string, "ok" \| "fail">, status: "ok" \| "fail" }` with `200` or `503` | `libs/shared/src/health.ts` (`healthRouter`) |
| No auth middleware or protected route exists yet (BE-02-03, BE-03-02) | `libs/shared/src/index.ts` |
| Shared deps are pinned exactly (`zod 4.6.7`, `express 5.2.1`); services depend on `@payment-be/shared` and import its exports | `libs/shared/package.json`, `services/*/package.json` |
| `@asteasolutions/zod-to-openapi@9.1.0` peers on `zod ^4`, exports `OpenAPIRegistry`, `OpenApiGeneratorV31`, `RouteConfig` and `ResponseConfig`, and reads schema names from `.meta({ id })` without `extendZodWithOpenApi` | package `dist/index.d.ts`, README |
| `registry.register(name, schema)` calls `schema.openapi(name)`, so without `extendZodWithOpenApi` it throws `zodSchema.openapi is not a function` | package `dist/index.cjs` (`OpenAPIRegistry.schemaWithRefId`), checked in a scratch run |
| A `.meta({ id })` schema lands in `components.schemas` only when a route references it or it is passed to the generator as a `{ type: "schema", schema }` definition. A bare Zod schema in the definitions list is skipped, because Zod 4 schemas have a `type` property that the generator mistakes for a definition tag. Calling `.meta({ id })` twice with the same id does not throw | package `dist/index.cjs` (`generateSingle`), checked in a scratch run |
| `registerComponent("securitySchemes", name, object)` emits the raw object under `components.securitySchemes`. A Zod schema in `content[...].schema` with a `.meta({ id })` is emitted as `{ $ref: "#/components/schemas/<id>" }` | package `dist/openapi-registry.d.ts`, checked in a scratch run |
| `generateDocument` returns `OpenAPIObject` from `openapi3-ts/oas31`, which the package does not re-export. `openapi3-ts` is a transitive dependency, so shared cannot import it directly | package `dist/v3.1/openapi-generator.d.ts`, `package.json` |
| `swagger-ui-express@5.0.1` peers on `express >=4 \|\| >=5.0.0-beta` and depends on `swagger-ui-dist >=5`. `@types/swagger-ui-express` latest is `4.1.8`; it depends on `@types/express` `*`, and `5.0.6` is the latest `@types/express` | npm metadata |
| `serve` reads a module-level init script that every `setup` call overwrites. `serveFiles(document, options)` builds its own `swagger-ui-init.js` from `options.swaggerOptions`; `setup` only renders the HTML shell. Swagger UI settings such as `persistAuthorization` go under `swaggerOptions`, not at the top level | package `index.js` (`serveFiles`, `setup`, `swaggerInitFn`) |
| Mounted with `router.use("/docs", ...)` on an Express 5 `Router`: `GET /docs` redirects `301` to `/docs/` (the page loads its assets by relative path), `GET /docs/` returns the HTML, and any other `/docs/*` path the static files do not match falls through to `setup` and returns the HTML, including `/docs/openapi.json` unless that route is registered first | package `index.js`, checked in a scratch run with `express@5.2.1` and supertest |
| The Swagger UI page has no inline `<script>`: it loads `./swagger-ui-init.js` as a file. It does have inline `<style>` blocks | package `index.js` (`htmlTplString`) |
| `httpLogger` skips auto-logging only for `/health/*`, so each Swagger UI page load logs one `info` line per asset (HTML, init script, bundle, preset, CSS, favicons) | `libs/shared/src/logger.ts` (`autoLogging.ignore`) |
| `--env-file-if-exists` does not override a variable already set in the shell, so `NODE_ENV=production pnpm dev` runs in production mode even with `.env` at `development` | Node 24 `--env-file` semantics, checked with `node --env-file-if-exists` |
| Jest runs native ESM with the `development` export condition; supertest is already a dev dependency of each service | `jest.config.js`, `services/*/package.json` |

## Current Behavior To Preserve

- Health responses, the error model and its `application/problem+json` 404 for unknown paths.
- Every existing test passes unchanged apart from passing the new `docs` option to `createApp`.
- `libs/shared/package.json` keeps only the `development` and `default` export conditions.
- `.env.example` does not change: no new env vars.
- `pnpm check`, `typecheck`, `test` and `build` pass with Docker stopped.

## Prerequisites

- BE-01-04, BE-01-05 and BE-01-06 are done.

## Scope

**Dependencies** (in the `dependencies` of `libs/shared/package.json` only, next to `@types/express`, pinned exactly like the existing ones)
- `@asteasolutions/zod-to-openapi` `9.1.0`
- `swagger-ui-express` `5.0.1` and `@types/swagger-ui-express` `4.1.8`

Services do not add these: they use the shared exports, and the registry type is re-exported from shared. After install, `pnpm-lock.yaml` must resolve a single `@types/express` (`5.0.6`); if `@types/swagger-ui-express` pulls a second one, stop and record it here.

**Shared `openapi.ts`**
- A module-level `problemDetails = problemDetailsSchema.meta({ id: "ProblemDetails" })`. `.meta` returns a copy, so `errors.ts` stays unchanged. Do not use `registry.register`: it needs `extendZodWithOpenApi` (see Code Evidence).
- `createOpenApiRegistry(): OpenAPIRegistry` returns a new registry with:
  - A `bearerAuth` component via `registry.registerComponent("securitySchemes", ...)`: `type: "http"`, `scheme: "bearer"`, `bearerFormat: "JWT"`, with a description saying the token comes from `POST /auth/login` on the auth service.
  - `GET /health/live` (200) and `GET /health/ready` (200 and 503, both with the `{ checks, status }` body), with no security, tagged `health`.
- `bearerSecurity`: the `[{ bearerAuth: [] }]` value a route sets as `security`.
- `problemResponses(...statuses: number[]): Record<string, ResponseConfig>`: maps each status to a description (the HTTP status phrase from `node:http` `STATUS_CODES`) and `{ "application/problem+json": { schema: problemDetails } }`, which the generator emits as a `$ref` to `ProblemDetails`.
- `buildOpenApiDocument(registry, { title, version, description? })`: generates with `new OpenApiGeneratorV31([...registry.definitions, { type: "schema", schema: problemDetails }])`, so `ProblemDetails` is in `components.schemas` even before any route references it, with `openapi: "3.1.0"` and `servers: [{ url: "/" }]` so the spec works on whatever port the service listens on.
- `docsRouter(document)`: an Express `Router` that registers, in this order:
  1. `router.get("/docs/openapi.json", ...)`: the document as JSON. It must come first, or the Swagger UI handler answers it with HTML.
  2. `router.use("/docs", swaggerUi.serveFiles(document, options), swaggerUi.setup(document, options))` with `options = { swaggerOptions: { displayRequestDuration: true, persistAuthorization: true, tryItOutEnabled: true } }`. `GET /docs` redirects to `/docs/`.

  Import with `import swaggerUi from "swagger-ui-express"` (CommonJS default export). Use `serveFiles` rather than the bare `serve` export: `serve` relies on module-level state set by the last `setup` call, which breaks when more than one app is built in a process (as in tests).
- Exports from `index.ts`: `createOpenApiRegistry`, `bearerSecurity`, `problemResponses`, `buildOpenApiDocument`, `docsRouter`, and `type OpenAPIRegistry`, `type OpenApiDocument`. Define `OpenApiDocument` as `ReturnType<OpenApiGeneratorV31["generateDocument"]>`, because the package does not export its document type. Annotate return types on exported functions.

**Each service (`auth`, `payment`, `notification`)**
- `src/openapi.ts`: `buildDocument()` creates a registry with `createOpenApiRegistry()` and returns `buildOpenApiDocument(registry, { title: "<service> service", version: "0.0.0" })`. Later endpoint milestones register their routes here.
- `src/app.ts`: `createApp({ checks, logger, docs })` with `docs: boolean`. When `true`, mount `docsRouter(buildDocument())` after `healthRouter` and before `notFoundHandler`. When `false`, nothing is mounted, so `/docs` falls through to the standard 404.
- `src/main.ts`: pass `docs: config.NODE_ENV === "development"`, and include the docs URL in the `listening` log when enabled (for example `docs: "/docs"`).

**Tests**
- `libs/shared/src/openapi.test.ts`:
  - A document built from a fresh registry has `openapi: "3.1.0"`, `servers: [{ url: "/" }]`, `components.securitySchemes.bearerAuth` as above, `components.schemas.ProblemDetails` (with no route referencing it), and both health paths with their response codes.
  - `problemResponses(401, 404)` yields both statuses with `application/problem+json` content referencing `#/components/schemas/ProblemDetails`.
  - A route registered with `security: bearerSecurity` and `problemResponses(401)` appears in the document with that security requirement.
  - Two registries are independent: registering a path in one does not add it to the other.
  - Through supertest on an app mounting `docsRouter`: `GET /docs/openapi.json` returns `200` `application/json` with the document (proves the route order); `GET /docs` returns `301` to `/docs/`; `GET /docs/` returns `200` HTML containing Swagger UI; `GET /docs/swagger-ui-init.js` contains `persistAuthorization` (proves the options reach the browser).
  - Two `docsRouter` apps built from documents with different titles each serve their own title in `swagger-ui-init.js` (proves no shared module state).
- `services/*/src/app.test.ts`: existing cases pass `docs: false`. Add:
  - With `docs: true`: `GET /docs/openapi.json` returns `200` with the service's title, `bearerAuth` and the health paths; `GET /docs/` returns `200` `text/html`.
  - With `docs: false`: `GET /docs/` and `GET /docs/openapi.json` return the `not-found` problem.

**Docs**
- `README.md`, API section: replace "Not available yet" with the docs URLs per service (development only), how to authorize (log in on auth's `/docs`, paste `accessToken` into **Authorize** on each service), and the note that docs are off for `test` and `production`. Keep the Errors subsection.
- `ROADMAP.md`: link this doc in the BE-01-09 row. Set `in-progress` when work starts and `done` at the end.

## Excluded

- Auth middleware and role guard (BE-02-03); login and register endpoints (BE-02-02); any protected route (BE-03-02 onwards)
- CORS, helmet and rate limiting (BE-02-04)
- A combined Swagger UI covering all services
- Writing the spec to a file, generating it at build time, or validating it with an external OpenAPI linter
- Serving docs in `test` or `production`
- The spec completeness review across services (BE-06-04)
- Changes to `problemDetailsSchema`, `healthRouter` or the error handler

## Likely Files To Touch

- `libs/shared/package.json`, `pnpm-lock.yaml`
- `pnpm-workspace.yaml`: `"@scarf/scarf": false` under `allowBuilds`. Install failed with `ERR_PNPM_IGNORED_BUILDS` for `swagger-ui-dist`'s telemetry postinstall, so it is disabled per the `allowBuilds` rule in `AGENTS.md`
- `libs/shared/src/openapi.ts`, `openapi.test.ts` (new), `index.ts`
- `services/*/src/openapi.ts` (new), `app.ts`, `main.ts`, `app.test.ts`
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None.

Settled during intake on 2026-10-18, each the recommended option:
- **Swagger UI package:** `swagger-ui-express`. Rejected: serving `swagger-ui-dist` by hand, which saves a dependency but means maintaining the asset serving and init script.
- **Where the UI lives:** one Swagger UI per service on its own port. Requests stay same-origin, so no CORS is needed; the cost is pasting the token once per service. Rejected: one combined UI with a spec dropdown, which needs CORS on every service and absolute server URLs now, pulling part of BE-02-04 forward.
- **Development-only gating:** an explicit `docs` flag on `createApp`, set by `main.ts` from `NODE_ENV`. Tests cover both states without touching env vars; when off, `/docs` returns the standard 404 problem. Rejected: reading `process.env` inside `createApp`.
- **Initial content:** the health endpoints, the `ProblemDetails` component and the `bearerAuth` scheme, so the Authorize button exists before the first protected route.
- **Spec version and generator:** OpenAPI 3.1 via `OpenApiGeneratorV31`; schema names from `.meta({ id })`, without `extendZodWithOpenApi`. (Review on 2026-10-18 found that `registry.register` needs `extendZodWithOpenApi`, so it is not used.)

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, for example why `serveFiles` is used instead of `serve`.
- Only the dependencies listed under Scope. Do not change `tsconfig*.json`, `jest.config.js` or `biome.jsonc`. If one turns out to be needed, stop and record why in this doc first.
- Install with `pnpm` from the repo root. If it fails with `ERR_PNPM_IGNORED_BUILDS`, follow the `allowBuilds` rule in `AGENTS.md`.
- Build each document once per `createApp` call, not per request.
- Swagger UI asset requests are logged by `httpLogger` at `info`. That is accepted for a development-only page; do not change `logger.ts`.
- The spec must not include example tokens, secrets or real user data.

## Deliverables

- The shared OpenAPI helpers exported from `@payment-be/shared`.
- Each service serving `/docs` and `/docs/openapi.json` in development only, with the `bearerAuth` scheme and health paths.
- Shared and per-service tests as listed.
- `README.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual, with `.env` at `NODE_ENV=development`: `pnpm infra:up && pnpm dev`, then open `localhost:3001/docs`, `localhost:3002/docs` and `localhost:3003/docs`. Each shows Swagger UI with the health endpoints, **Try it out** works on `/health/ready`, and **Authorize** accepts a value that survives a reload.
- Manual, with infra still up (payment exits at startup without NATS): `NODE_ENV=production pnpm dev`, then `curl -i localhost:3002/docs/` returns `404` `application/problem+json`. The shell value wins over `.env`.
- `git status --porcelain` lists only files under Likely Files To Touch.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes. Each service serves its OpenAPI 3.1 spec and Swagger UI only in development, the spec declares `bearerAuth` and documents the health endpoints, the shared helpers let a later milestone register a protected route with its problem responses, and the BE-01-09 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-02-02: register `POST /auth/register` and `POST /auth/login` in `services/auth/src/openapi.ts`, with request and response schemas and `problemResponses(...)`.
- BE-02-03 onwards: every protected route sets `security: bearerSecurity` and includes `problemResponses(401, 403)` as applicable.
- BE-02-04: check `/docs` still renders under helmet's default Content Security Policy. The page has no inline script, but its inline styles, `img-src` and `upgrade-insecure-requests` can still break it. If it does, mount `docsRouter` before helmet or relax the policy for `/docs`.
- BE-06-04: review examples and error responses across all three specs.
