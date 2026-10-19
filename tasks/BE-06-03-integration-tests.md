# BE-06-03: Cross-service integration tests

**Covers:** BE-06-03
**Status:** done

## Objective

Prove the three services work together over real NATS JetStream and SMTP, end to end, with an automated suite that runs on demand. The suite starts `auth`, `payment` and `notification` as real processes against test-only NATS and Mailpit instances, drives them over HTTP, and checks four flows:

1. **Event flow:** a payment created over HTTP is settled by the processor, its events reach `notification`, and the user gets in-app notifications and emails.
2. **Retries and dead-lettering:** a send that keeps failing is retried on schedule and dead-lettered; a permanent rejection is dead-lettered at once.
3. **DLQ replay:** an admin lists the DLQ and replays an entry, which sends the email and removes it.
4. **Duplicate delivery:** the same event delivered twice produces one notification and one email.

`pnpm test` keeps working with Docker stopped; the integration suite has its own command.

## Source Context

Roadmap milestone BE-06-03 ("Cross-service integration tests (event flow, retries, DLQ, duplicate delivery)") in `ROADMAP.md`. The Decisions table's Testing row already commits to "cross-service integration tests against NATS (from the BE-01-03 compose stack)". On 2026-10-19 the user chose to give BE-06-03 its own task doc, because it is the one Phase 6 milestone with real design decisions. The user confirmed the recommended option for each of D1 to D4 on 2026-10-19 (see Decisions).

## Design Reference

- `ROADMAP.md`, Decisions table: Testing, Inter-service messaging, Email failure handling (as reworded in BE-05-05), Async model.
- `AGENTS.md`: use `pnpm` for every script; no `console.*`; tests sit next to the file they cover (integration tests cover no single file, see decision D3).
- `tasks/BE-05-05-email-retries-dlq.md`: retry schedule env vars (`EMAIL_MAX_ATTEMPTS`, `EMAIL_RETRY_DELAYS_MS`), DLQ stream, admin DLQ API, and its follow-up "BE-06-03: a cross-service integration test that dead-letters and replays against a real NATS".
- `tasks/BE-05-02-idempotent-event-handling.md`: per-channel inbox dedupe, which the duplicate-delivery test exercises.

## Current State

| Behavior | Source |
|---|---|
| Each service is a top-level script (`src/main.ts`) that loads config from env, connects to NATS and listens; it exports nothing, so tests cannot start it in-process | `services/*/src/main.ts` |
| Ports, NATS URL, storage and timings are env vars: `AUTH_PORT`, `PAYMENT_PORT`, `NOTIFICATION_PORT`, `NATS_URL`, `STORAGE_DRIVER` (`memory` or `file`), `PROCESSOR_POLL_INTERVAL_MS`, `GATEWAY_MIN_DELAY_MS`, `GATEWAY_MAX_DELAY_MS`, `GATEWAY_FAILURE_RATE`, `GATEWAY_TIMEOUT_RATE`, `OUTBOX_RELAY_INTERVAL_MS`, `SMTP_HOST`, `SMTP_PORT`, `EMAIL_MAX_ATTEMPTS`, `EMAIL_RETRY_DELAYS_MS` | `services/*/src/config/config.ts`, `README.md` "Install and run" |
| `auth` seeds `admin@example.com` / `Admin123!` and `user@example.com` / `User123!` on start (passwords are demo defaults outside production) | `services/auth/src/main.ts`, `README.md` "Storage and demo accounts" |
| `PAYMENTS` and `DLQ` stream names, and the `notification-inapp` / `notification-email` consumer names, are constants; a NATS server holds one set of them | `libs/shared/src/streams.ts`, `services/notification/src/consumer/consumer.config.ts` |
| `compose.yaml` runs one NATS (`nats:2.15.1-alpine`, JetStream on a named volume, ports 4222 and 8222) and one Mailpit (`axllent/mailpit:v1.31.6`, ports 1025 and 8025), both on `127.0.0.1` | `compose.yaml` |
| `pnpm infra:reset` deletes the NATS volume, which is the developer's own local data | root `package.json` |
| Mailpit has an HTTP API (`GET /api/v1/messages`, `DELETE /api/v1/messages`) used in earlier manual checks | `tasks/BE-05-04-email-channel.md` |
| Jest runs ESM through `ts-jest` with roots `libs` and `services` and no `testPathIgnorePatterns` | `jest.config.js` |
| The payment outbox publishes with `Nats-Msg-Id` = `eventId`; JetStream drops a repeat within 2 minutes, so a duplicate must be published with a different message ID to reach the consumers | `libs/shared/src/nats.ts`, `README.md` "Events" |

## Decisions

All four were settled on 2026-10-19: the user chose the recommended option in each. The alternatives stay listed for context.

**D1. Which NATS and Mailpit the tests use.**
- **(Chosen) Separate test containers.** Add `nats-test` and `mailpit-test` services to `compose.yaml` under a `test` profile: NATS on `127.0.0.1:4223` (monitoring `8223`) with JetStream on `tmpfs`, and Mailpit on `127.0.0.1:1026` / `8026` with chaos enabled (D4). New scripts `pnpm infra:test:up` and `pnpm infra:test:down`. The suite never touches the developer's NATS data or inbox, and every run starts empty.
- Reuse the dev containers and purge `PAYMENTS`, `DLQ` and the consumers before each run. No compose change, but running the suite wipes local dev data, and running it while `pnpm dev` is up breaks both.

**D2. How the services run.**
- **(Chosen) Child processes from source.** A test harness spawns each service with `tsx --conditions=development src/main.ts` (the same way `pnpm dev` does, without `watch`), on fixed test ports (`4101` to `4103`), `STORAGE_DRIVER=memory`, the test NATS and SMTP, and fast timings (gateway 10 to 50 ms, failure and timeout rates 0, poll and relay intervals 50 ms, `EMAIL_MAX_ATTEMPTS=3`, `EMAIL_RETRY_DELAYS_MS=200,400`). It waits for each `/health/ready`, and stops them with SIGTERM in `afterAll`. It captures each process's output for assertions and attaches it on failure. No build step is needed.
- Run `dist/main.js` after `pnpm build`. Closer to production, but adds a build to every run and tests stale code if the build is skipped.
- Export a `start()` from each `main.ts` and run all three in the Jest process. Fastest, but changes every entry point and mixes three services' globals in one process, which hides real boundary problems.

**D3. Where the suite lives and how it runs.**
- **(Chosen)** A new top-level `tests/integration/` folder (the tests cover no single file), with `*.int.test.ts` files and a `harness.ts`. A separate `jest.integration.config.js` (same ESM transform, roots `tests/integration`, a per-test timeout of 30 s, `maxWorkers: 1` because the flows share one NATS) and a root script `pnpm test:integration`. The existing `jest.config.js` keeps its roots, so `pnpm test` never picks the suite up.
- Put the files in each service's `src/` with a different suffix. Keeps "tests next to code", but no single service owns a cross-service test.

**D4. How SMTP failures are triggered.**
- **(Chosen) Mailpit chaos on the test instance.** Start `mailpit-test` with chaos enabled and switch it through Mailpit's chaos API: a `4xx` recipient error at 100% for the retry flow, a `5xx` for the permanent-rejection flow, and off again for replay. One SMTP server for all flows, no restarts, and both retryable and permanent errors are covered. Mailpit `v1.31.6` has `--enable-chaos` ("Enable Chaos functionality (API / web UI)") and `--chaos-triggers` (checked with `docker run --rm axllent/mailpit:v1.31.6 --help` on 2026-10-19). Confirm the chaos API path and body against that version before writing the helper; if they do not cover recipient errors, fall back to the next option and record why here.
- Point the notification process at a closed port for failures. Gives `ESOCKET` only (no permanent rejection), and needs a second notification process with a different `SMTP_PORT` for replay.

## Scope

- **Infrastructure (per D1):** the `test` profile services in `compose.yaml` and the two `infra:test:*` scripts. The default `pnpm infra:up` starts only the dev services, as today.
- **Harness (per D2, D3):** start and stop the three services; wait for readiness; helpers to log in, call the APIs, read and clear Mailpit messages, switch chaos, read service output, and poll for a condition with a timeout (no fixed sleeps).
- **Tests:**
  - `event-flow.int.test.ts`: the demo user creates a payment; it reaches `succeeded`; `GET /notifications` returns the `created` and `succeeded` notifications; Mailpit receives "Payment received" and "Payment succeeded" for `user@example.com`, each with `Message-ID <eventId@payment-simulation.local>`; the correlation ID from the create request appears in the `payment` and `notification` output for those events.
  - `retries-dlq.int.test.ts`:
    - With a retryable chaos error on, a new payment's two emails are retried (the output shows attempts 1 and 2) and dead-lettered on attempt 3 with `reason: "exhausted"`; `GET /admin/dlq` as admin lists both; in-app notifications still arrive.
    - With a permanent chaos error on, a new payment's emails are dead-lettered on attempt 1 with `reason: "rejected"`.
    - Replay with chaos still on returns `502 email-send-failed` and keeps the entry; with chaos off it returns `200`, Mailpit receives the email, and the entry is gone; the demo user gets `403` on the DLQ routes.
  - `duplicate-delivery.int.test.ts`: after a payment's emails arrive, the test publishes one of its events again to `PAYMENTS` (same body, a different `Nats-Msg-Id`); `notification` logs "duplicate skipped" for both channels, and the notification count and Mailpit message count do not change.
- **README "Testing"**: how to run the suite (`pnpm infra:test:up`, `pnpm test:integration`, `pnpm infra:test:down`), what it covers, and that it needs Docker. BE-06-05 rewrites this section later; keep it short.
- **Roadmap**: link this doc from BE-06-03, set it to `in-progress` when starting and `done` when finished.

## Preserve

- Every service's runtime behaviour and source; the harness only sets env vars. If a test exposes a real bug, fix it only if small and local; otherwise record it and skip the test with a reason.
- `pnpm test`, `pnpm infra:up`, `pnpm infra:down`, `pnpm infra:reset` and the dev containers.

## Excluded

- CI (BE-07-04, deferred with Phase 7).
- Load, chaos or long-running soak tests.
- Testing a restart of `notification` mid-flow (redelivery after a crash). The duplicate-publish test covers the dedupe path; a restart test is a follow-up.
- Unit or API test gaps (BE-06-01, BE-06-02).

## Likely Files To Touch

- `compose.yaml` (test profile), root `package.json` (`infra:test:up`, `infra:test:down`, `test:integration`)
- `jest.integration.config.js` (new)
- `tests/integration/` (new: `harness.ts`, the three `*.int.test.ts` files)
- `tsconfig.test.json` (include `tests/**` for typecheck), if needed
- `README.md` ("Testing"), `ROADMAP.md`

## Prerequisites

- BE-05-05 and BE-05-06 are merged to `main` as of commit `5a96921`.
- Can run in parallel with BE-06-01 (`tests/integration/` is outside its scope; coordinate if both touch `README.md` "Testing").

## Execution Rules

- No `console.*`; the harness reports through the shared pino logger or Jest's own output. No comments unless essential.
- No new runtime dependencies. `tsx` and `jose` are already in the workspace; if the harness needs anything else, stop and record why here first.
  - Recorded during delivery: the root `package.json` gains `@payment-be/shared` (`workspace:*`) as a dev dependency, so the duplicate-delivery test can reach NATS through the shared lib's client. It is a workspace package, not a new external dependency.
- No fixed `sleep` in tests: poll with a timeout.
- Never log or print tokens.

## Deliverables

- Test infrastructure, harness and the three integration test files.
- `pnpm test:integration` and the `infra:test:*` scripts.
- README and roadmap updates.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test          # Docker stopped: unchanged, still passes
pnpm build
pnpm infra:test:up
pnpm test:integration
pnpm infra:test:down
```

- `pnpm test:integration` passes three times in a row from a fresh `infra:test:up`, with each run under 2 minutes.
- Running it while `pnpm dev` and the dev containers are up leaves dev data untouched (per D1): the dev Mailpit inbox and `PAYMENTS` stream are unchanged afterwards.
- Breaking a flow fails the right test. For example, set `EMAIL_MAX_ATTEMPTS` to 1 in the harness and the retry test fails; revert after checking.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and BE-06-03 in `ROADMAP.md` is `done` and links to this file.

## Delivery notes

- Mailpit `v1.31.6` chaos is `PUT /api/v1/chaos` with `{"Recipient": {"ErrorCode": <code>, "Probability": <0-100>}}`, confirmed against the container before writing the helper.
- nodemailer reports every refused recipient as `EENVELOPE`, including a temporary `451`, so `isPermanent` dead-lettered 4xx recipient errors at once instead of retrying them. Fixed in `services/notification/src/email/email.retry.ts`: the SMTP reply code decides first, and `EENVELOPE` without one stays permanent. Unit tests cover both cases.

## Follow-ups

- A restart test: kill `notification` between sending and marking, restart it, and check the email is sent again with the same `Message-ID`.
- Run the suite in CI (BE-07-04) if Phase 7 is ever picked up.
