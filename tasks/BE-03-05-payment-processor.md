# BE-03-05: Simulated gateway and background payment processor

**Covers:** BE-03-05
**Status:** done

## Objective

Payments move through `pending → processing → succeeded | failed` on their own. A background processor in the payment service claims each `pending` payment and sends it to a simulated gateway. The gateway answers after a random delay with success or failure, or hangs until the processor's timeout fails the payment. The processor records the result. Every change goes through the BE-03-01 state machine and the repository's compare-and-set update, so the processor and the admin `PATCH` never overwrite each other. Payments left `processing` by a restart are sent to the gateway again. Graceful shutdown stops the processor without recording anything half-done.

## Source Context

Roadmap milestone BE-03-05 ("Simulated gateway and background processor (delay, random failure, timeouts, resumes in-flight payments after restart)") in `ROADMAP.md`. The brief (`~/Downloads/Node js assessment.xlsx`) asks for simulated payment processing with asynchronous operations. Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Trigger: polling sweep.** A timer runs a sweep every `PROCESSOR_POLL_INTERVAL_MS`. Each sweep claims `pending` payments and resumes `processing` payments that are not already in flight. One code path covers new payments, restart recovery and records that failed to save. Pickup can lag by up to one interval.
- **Timeout: mark failed.** When the gateway does not answer within `GATEWAY_TIMEOUT_MS`, the payment goes `processing → failed` with `failureReason` "Gateway timed out". The simulated gateway hangs on a configurable share of calls (`GATEWAY_TIMEOUT_RATE`) so this case actually happens.
- **Resume: resubmit to the gateway.** A `processing` payment that is not in flight (after a restart, or after its result failed to save) is sent to the gateway again, with the payment ID as the idempotency key, and its result is recorded as usual.
- **Shutdown: abort, leave processing.** `stop()` ends the sweep timer and aborts in-flight gateway waits through an `AbortSignal`, recording nothing. Those payments stay `processing` and are resumed on the next start.

Defaults written into this doc for review (not separately confirmed; change them here before implementation if needed):

- The 3-attempt get → `statusChange` → `update` loop in `PaymentService.updateStatus` moves into a shared helper that the admin PATCH and the processor both use (the follow-up from `tasks/BE-03-04-update-payment-status.md`). PATCH behavior is unchanged.
- Config defaults: poll every 1000 ms, at most 5 payments in flight, gateway delay 1000–5000 ms, failure rate 0.2, timeout rate 0.05, timeout 10000 ms.
- Failure reasons are drawn from a fixed list: "Card declined", "Insufficient funds", "Issuer unavailable".
- The sweep handles the oldest payments first (by `createdAt`).
- No new readiness check, and no switch to turn the processor off. The processor is started in `main.ts` and is not part of `createApp`, so the existing route tests never see it.
- No events. BE-04-02 adds the outbox.

## Design Reference

- `ROADMAP.md`, Decisions table: Async model ("POST returns `pending`; a simulated gateway resolves it after a random delay. The processor updates status in-process, not over HTTP"); Persistence (compare-and-set on `version`); Money (no floats).
- `AGENTS.md`, Architecture constraints: status changes go through the repository's compare-and-set update so a concurrent admin PATCH and processor update cannot overwrite each other; validate env config with Zod; include IDs in log lines and never log email.
- `AGENTS.md`, Code style: folder per module with `<module>.<role>.ts` file names and a named-export `index.ts`; tests next to the file they cover.
- `tasks/BE-01-04-service-skeleton.md`: "Later milestones add … cleanup tasks (processor timers in BE-03-05) by passing more entries" to `onShutdown`.
- `tasks/BE-03-04-update-payment-status.md`, Follow-ups: the processor reuses the get → `statusChange` → `update` pattern; consider extracting the retry loop now.
- `README.md`, "Payment flow" step 2 already describes this behavior.

## Architecture Summary

```
main.ts
  processor = createPaymentProcessor({ payments, gateway: createSimulatedGateway(config), logger, ...config })
  processor.start()
  onShutdown({ server, tasks: [processor.stop, drainNats, closeRepository] })

sweep (first one at start(), then PROCESSOR_POLL_INTERVAL_MS after the previous sweep finishes; never two at once)
  candidates = payments with status pending, or processing and not in flight; oldest createdAt first
  take up to PROCESSOR_CONCURRENCY minus the number in flight; add their IDs to the in-flight set at once
  claims run in parallel and the sweep awaits them; charges start without being awaited
    pending    → transitionPayment(id, "processing")
                   invalid-status-transition / payment-not-found → skip (e.g. admin cancelled it)
                   version-conflict after 3 attempts            → skip, the next sweep retries
    processing → charge (resume; no claim step)
    charge     → gateway.charge({ paymentId, amount, currency }, { signal })
                   signal is per charge, aborted by its GATEWAY_TIMEOUT_MS timer or by stop()
                   approved           → transitionPayment(id, "succeeded")
                   declined(reason)   → transitionPayment(id, "failed", reason)
                   timeout            → transitionPayment(id, "failed", "Gateway timed out")
                   stop() called      → record nothing (stays processing)
    record     → invalid-status-transition (admin already settled it) → info log, keep the admin's result
                 any other error → error log; the payment stays processing and is resumed by a later sweep
    finally    → drop from the in-flight set, clear the timeout timer
  a sweep that throws (e.g. find fails) → error log; the next sweep is still scheduled

stop()
  set stopped, clear the sweep timer, abort every in-flight charge, wait for the running sweep and every in-flight task to settle
```

The gateway rejects with an `AbortError` both when the timeout fires and when `stop()` aborts, so the processor tells them apart by what aborted the signal (the abort reason or the `stopped` flag), never by the error type. Once `stop()` has been called, nothing new is recorded, even a timeout or answer that lands during shutdown; a record that has already started finishes before `stop()` resolves. The processor stops waiting on a charge as soon as its signal aborts, so `stop()` never depends on the gateway honoring the signal. A sweep that is still claiming when `stop()` is called finishes its claims but starts no charges; those payments stay `processing` and are resumed on the next start.

`transitionPayment(payments, id, to, { failureReason, now })` (with `now: () => Date`, called once per attempt as today) is the loop that `PaymentService.updateStatus` has today, moved out unchanged: up to 3 attempts of `payments.get` → `statusChange` → `payments.update(id, version, patch)`. It re-reads and re-checks only on `VersionConflictError`, and throws `payment-not-found`, `invalid-status-transition`, or the last `VersionConflictError`. It returns `{ from, payment }`, where `payment` is the stored `Payment` (callers map it to a response).

Simulated gateway:

```
charge({ paymentId, amount, currency }, { signal }) → Promise<{ outcome: "approved" } | { outcome: "declined", reason }>
  random() < GATEWAY_TIMEOUT_RATE  → never resolves on its own; rejects with an AbortError once signal aborts
  otherwise wait uniform[GATEWAY_MIN_DELAY_MS, GATEWAY_MAX_DELAY_MS] (abortable)
    random() < GATEWAY_FAILURE_RATE → declined, reason picked from the fixed list
    otherwise                        → approved
```

`random` is injectable so tests are deterministic; tests control time with Jest fake timers. Use `setTimeout`/`clearTimeout` for every delay and timeout, not `AbortSignal.timeout()`, which Jest's fake timers neither advance nor count. The gateway keeps no state; `paymentId` is passed as the idempotency key a real gateway would use to make a resubmit safe.

```
services/payment/src/
  config/config.ts                    processor and gateway env vars
  payment/payment.transition.ts       transitionPayment (moved out of payment.service.ts)
  payment/payment.service.ts          updateStatus delegates to transitionPayment
  processor/processor.gateway.ts      PaymentGateway type, createSimulatedGateway
  processor/processor.service.ts      createPaymentProcessor → { start, stop, sweep }
  processor/index.ts
  main.ts                             create, start, register stop as the first shutdown task
```

## Code Evidence

| Behavior | Source |
|---|---|
| `PaymentService.updateStatus` holds the 3-attempt loop (`STATUS_UPDATE_ATTEMPTS = 3`) that retries only on `VersionConflictError` and returns `{ from, payment: toPaymentResponse(updated) }` | `services/payment/src/payment/payment.service.ts` |
| `statusChange(payment, to, { failureReason?, now? })` asserts the transition (`409 invalid-status-transition`) and throws a plain `Error` if `failureReason` does not match `failed` | `services/payment/src/payment/payment.status.ts` |
| `PAYMENT_TRANSITIONS`: `pending → processing \| cancelled`, `processing → succeeded \| failed`; final statuses have no edges | `services/payment/src/payment/payment.status.ts` |
| `failureReasonSchema` is `z.string().min(1).max(200)` | `services/payment/src/payment/payment.ts` |
| `Repository` has `find(predicate?)` (returns copies), `get`, and compare-and-set `update(id, expectedVersion, patch)` that throws `VersionConflictError` | `libs/shared/src/repository.ts` |
| An admin can only set `cancelled`, `succeeded` or `failed`, never `processing`, so at runtime every `processing` payment was claimed by the processor | `services/payment/src/payment/payment.schema.ts` (`updatePaymentStatusBodySchema`) |
| `main.ts` builds the repository, app and NATS connection, then calls `onShutdown({ logger, server, tasks: [() => drainNats(nc), close] })` | `services/payment/src/main.ts` |
| `createShutdown` closes the server first, then runs the tasks in order; a failing task does not stop later ones. `onShutdown` exits with code 1 after 10 s if shutdown hangs | `libs/shared/src/shutdown.ts` |
| `paymentConfigSchema` extends the base, storage and JWT schemas and adds `PAYMENT_PORT` with `z.coerce.number()` | `services/payment/src/config/config.ts` |
| `createApp` wires only the HTTP routes; it has no processor | `services/payment/src/app.ts` |
| README "Payment flow" step 2 describes claim → gateway → result; the status line says background processing is not implemented yet | `README.md` |

## Scope

- **Shared transition helper:** move the loop from `updateStatus` into `payment/payment.transition.ts` as `transitionPayment`, export it from `payment/index.ts`, and make `updateStatus` call it. `PATCH /payments/:id/status` responses, errors and logs stay exactly as they are, and its existing tests pass unchanged.
- **Config:** add to `paymentConfigSchema`, each with `z.coerce.number()` and the defaults above: `PROCESSOR_POLL_INTERVAL_MS` (int ≥ 10), `PROCESSOR_CONCURRENCY` (int ≥ 1), `GATEWAY_MIN_DELAY_MS` and `GATEWAY_MAX_DELAY_MS` (int ≥ 0), `GATEWAY_FAILURE_RATE` and `GATEWAY_TIMEOUT_RATE` (0 to 1), `GATEWAY_TIMEOUT_MS` (int ≥ 1). Reject `GATEWAY_MIN_DELAY_MS > GATEWAY_MAX_DELAY_MS` and `GATEWAY_TIMEOUT_MS <= GATEWAY_MAX_DELAY_MS` (otherwise answers the gateway does give would count as timeouts), each with an issue that names the variable. The schema ends in `.transform`, so add these checks with `.superRefine` after the last `.extend` and before `.transform`, or inside the transform as `resolveJwtSecret` does; either way set `path` to the variable (`["GATEWAY_MAX_DELAY_MS"]`, `["GATEWAY_TIMEOUT_MS"]`), because `loadConfig` reports issues through `z.prettifyError`, which names a variable only through the issue path. Add them to `.env.example`.
- **Simulated gateway** (`processor.gateway.ts`): the `PaymentGateway` interface and `createSimulatedGateway({ minDelayMs, maxDelayMs, failureRate, timeoutRate, random = Math.random })`, behaving as in the summary. An aborted signal rejects promptly and clears the delay timer, leaving no pending timers behind.
- **Processor** (`processor.service.ts`): `createPaymentProcessor({ payments, gateway, logger, pollIntervalMs, concurrency, timeoutMs, now = () => new Date() })` returning:
  - `start()`: runs a sweep at once, then schedules the next one with `setTimeout` after each sweep finishes. Calling it twice has no extra effect.
  - `sweep()`: one pass as in the summary. It returns once the pass has claimed its payments and started their work, without waiting for gateway results, and it is exported so tests drive it directly. If a sweep is already running, or `stop()` has been called, it returns without doing anything.
  - `stop()`: as in the summary. It is idempotent, and once it resolves no timer created by the processor or gateway is still pending.
  - The processor tracks the IDs of in-flight payments from selection (before the claim) until the record step ends, so a payment is never worked twice at once and the concurrency cap counts claims still in progress.
  - Logging through the injected logger, with no email: `payment claimed` (`paymentId`), `payment resumed` (`paymentId`) for a `processing` payment picked up again, `payment processed` (`paymentId`, `status`, plus `failureReason` when failed) at info; `payment already settled` (`paymentId`, `status`) at info when the record step hits `invalid-status-transition`; `payment claim skipped` at debug; `payment processing failed` (`paymentId`, `err`) at error for unexpected errors; `payment sweep failed` (`err`) at error when a sweep throws.
- **Wiring** (`main.ts`): build the gateway and processor from config, call `start()` after `listen`, and pass `processor.stop` as the first shutdown task, before NATS drain and repository close, so no record is written after storage closes.
- **Tests**, next to each file, using the memory repository, an injected `now`, Jest fake timers or controllable promises, and no real waiting. Tests run as native ESM, where there is no global `jest` (it is `undefined` at runtime, though it typechecks) and `@jest/globals` is not a direct dependency: use `import.meta.jest` (`import.meta.jest.useFakeTimers()`, `advanceTimersByTimeAsync`, `getTimerCount()`, `fn()`), which `@types/jest` already types.
  - `payment.transition.test.ts`: the cases that cover the loop in `payment.service.test.ts` today (success, one conflict then success, 3 conflicts, re-read finds the payment final → `invalid-status-transition`, unknown ID). Moving those cases out of the service test is fine as long as `updateStatus` keeps a test showing it delegates and maps the response.
  - `processor.gateway.test.ts`: with stubbed `random`, an approval after a delay inside the range; a decline with a reason from the list; a hang that only settles when aborted; abort during the delay rejects and leaves no pending timers (`jest.getTimerCount()`).
  - `processor.service.test.ts`, with a stub gateway whose calls the test resolves:
    - a sweep claims a `pending` payment (`processing`, `updatedAt` from `now`), and an approval records `succeeded`;
    - a decline records `failed` with the gateway's reason;
    - no answer within `timeoutMs` records `failed` with "Gateway timed out" and aborts the gateway's signal;
    - a new processor over a repository holding a `processing` payment resubmits it without a claim step, and logs `payment resumed`;
    - a payment cancelled between `find` and the claim (a wrapped repository) is skipped and the gateway is not called;
    - an admin marking the payment `failed` while the gateway call is pending wins: the processor's result is not written, `payment already settled` is logged, and nothing throws;
    - with `concurrency: 2` and 3 pending payments, only the 2 oldest are in flight, and the third is claimed by the next sweep after one finishes;
    - a payment already in flight is not picked up by a second sweep;
    - a sweep called while another is running does nothing (a wrapped repository holds `find` open);
    - a sweep whose `find` rejects logs `payment sweep failed`, and `start()` still runs the next sweep;
    - `stop()` called while a sweep is claiming: the claim finishes, no charge starts, and the payment stays `processing`;
    - an error while recording the result is logged, and the payment stays `processing` and is resumed by the next sweep;
    - `stop()` with a call in flight aborts it, records nothing, leaves the payment `processing`, leaves no pending timers, and no later sweep runs;
    - `start()` runs a sweep at once and another after `pollIntervalMs`.
  - `config.test.ts`: the new defaults, numeric coercion, out-of-range rates, `min > max` delay and `timeout <= max delay` rejected with the variable named.
- **README:** update the status line, document the new env vars (defaults and what each does) in "Install and run", next to the `LOGIN_RATE_LIMIT_*` paragraph, extend the SIGTERM/SIGINT sentence there to say the payment processor stops first, and add to "Payment flow" or the payment endpoint notes: pickup can lag one poll interval, a timeout means `failed` with "Gateway timed out", payments interrupted by a restart are resumed, and shutdown leaves in-flight payments `processing` for the next start. Mention that the PATCH `processing → succeeded | failed` edges race the processor and the first change wins.
- **Roadmap:** set BE-03-05 to `in-progress` when starting and `done` when finished.

## Preserve

- `POST /payments`, `GET /payments/:id` and `PATCH /payments/:id/status` behavior, responses, OpenAPI entries and existing tests.
- `payment.status.ts` transition table and `statusChange` behavior.
- `createApp`'s signature and the HTTP test setup.
- `libs/shared` unchanged. Auth and notification services unchanged.
- Shutdown order: server close first (shared), then processor stop, NATS drain, repository close.

## Excluded

- Publishing events or an outbox for any transition (BE-04-01, BE-04-02).
- Gateway retries before failing, and any persistent gateway state or real idempotency store.
- More than one payment service instance (no distributed lease or claim owner field).
- A switch to turn the processor off, an admin endpoint to trigger sweeps, or metrics (BE-07-05).
- New payment statuses, refunds, or changes to the transition table.

## Likely Files To Touch

- `services/payment/src/payment/payment.transition.ts`, `payment.transition.test.ts` (new)
- `services/payment/src/payment/payment.service.ts`, `payment.service.test.ts`, `index.ts`
- `services/payment/src/processor/processor.gateway.ts`, `processor.gateway.test.ts`, `processor.service.ts`, `processor.service.test.ts`, `index.ts` (new)
- `services/payment/src/config/config.ts`, `config.test.ts`
- `services/payment/src/main.ts`
- `.env.example`, `README.md`, `ROADMAP.md`

## Prerequisites

BE-03-04 is merged to `main` (it is, as of commit `1b35bb1`).

## Decisions Required Before Implementation

None. The four behavior decisions were settled during intake on 2026-10-19 (see Source Context). Rejected options:

- Trigger: notifying the processor on create plus a startup scan (two code paths, and a missed notification waits for a restart); notify plus a periodic sweep (most moving parts).
- Timeout: retrying before failing (more config and tests for little demo value); leaving the payment `processing` (a payment that always hangs would never become final).
- Resume: marking interrupted payments failed (every restart would turn in-flight payments into failures).
- Shutdown: waiting for in-flight calls (shutdown could take as long as the maximum gateway delay).

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why the sweep reschedules with `setTimeout` instead of `setInterval`, or why an aborted charge records nothing.
- Never log email, tokens or the `Authorization` header.
- Every status change goes through `transitionPayment`. No direct `payments.update` with a status outside it.
- No floats for money. The gateway receives `amount` as stored.
- No dependency changes. Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or `libs/shared`. If one turns out to be needed, stop and record why in this doc first.

## Deliverables

- A simulated gateway and a background processor started by the payment service, with the claim, result, timeout, resume and shutdown behavior specified above.
- The shared `transitionPayment` helper used by both the admin PATCH and the processor.
- New config with validation, unit tests, and `.env.example`, `README.md` and `ROADMAP.md` updated.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
```

- All three exit 0 with Docker stopped. `pnpm test --detectOpenHandles services/payment` also exits 0 and reports no open handles.
- Manual run (`pnpm infra:up`, `pnpm dev`): as the seeded user, create a few payments. Each shows `processing` and then `succeeded` or `failed` on `GET /payments/:id` within about 6 s (one poll interval plus the maximum delay; about 11 s for one that times out), and the logs show `payment claimed` and `payment processed`. With `GATEWAY_TIMEOUT_RATE=1` and `GATEWAY_TIMEOUT_MS` just above `GATEWAY_MAX_DELAY_MS` in `.env`, a payment ends `failed` with "Gateway timed out". With the file driver, stopping the service (Ctrl+C) while a payment is `processing` leaves it `processing` in `services/payment/data/payments.json`. On restart, `payment resumed` is logged and the payment is settled. Under `pnpm dev`, pnpm delivers one Ctrl-C to the service twice, so the second SIGINT force-exits and skips the shutdown tasks, including `processor.stop`. The check still holds, because an aborted charge records nothing either way, but it does not exercise `stop()`; to see that path, send one SIGTERM to the payment service's process instead and check the log ends with `shutdown finished` and exit code 0.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-03-05 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-04-02: `transitionPayment` is the single place status changes happen, so the outbox entry can be written in the same `update` patch. Each processor transition (`processing`, `succeeded`, `failed`) then publishes through it.
- BE-07-05: the processor's logs map directly to metric counters (claimed, processed by status, timeouts).
