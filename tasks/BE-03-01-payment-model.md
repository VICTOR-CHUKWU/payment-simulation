# BE-03-01: Payment model and status state machine

**Covers:** BE-03-01
**Status:** done

## Objective

The payment service gets a `payment/` module with the payment record schema and a pure status state machine. A payment belongs to one user (`userId` and `email`), holds an integer amount in minor units with an allowlisted ISO 4217 currency, and carries a `version` for compare-and-set updates. The state machine defines which status changes are allowed, rejects the rest with a `409` from the central error model, and builds the repository patch for an allowed change. It does not decide who may make a change (BE-03-04 and BE-03-05 do). No endpoint, storage wiring or event is added here. All of it ships with unit tests.

## Source Context

Roadmap milestone BE-03-01 in `ROADMAP.md` ("Payment model (owner `userId` + email, minor-unit amount + currency, `version`) and status state machine (allowed transitions)"). Scope was agreed during task-doc intake on 2026-10-18. The user chose:
- **Statuses:** `pending → processing → succeeded | failed`, plus `pending → cancelled`. `succeeded`, `failed` and `cancelled` are final.
- **Currency:** a small allowlist (`NGN`, `USD`, `EUR`, `GBP`), each with minor-unit exponent 2.
- **Storage:** opening the payments repository in `main.ts` is deferred to BE-03-02, its first caller.

The brief (`~/Downloads/Node js assessment.xlsx`) asks for "updating the status of a payment" but names no statuses.

## Design Reference

- `ROADMAP.md`, Decisions table, Money: "Integer amounts in minor units (e.g. kobo, cents) plus ISO 4217 currency code; no floats".
- `ROADMAP.md`, Decisions table, Async model: POST returns `pending`; a simulated gateway resolves it in the background.
- `ROADMAP.md`, Decisions table, Persistence: updates are compare-and-set on a `version` field.
- `ROADMAP.md`, BE-04-01 row: the event list "follows BE-03-01".
- `AGENTS.md`, Architecture constraints: payment events carry `userId` and email; status changes go through the repository's compare-and-set update so an admin PATCH and the processor cannot overwrite each other; money is never a float.
- `README.md`, Payment flow: a payment is saved as `pending`, then the processor publishes `payment.succeeded` or `payment.failed`.

## Architecture Summary

```
services/payment/src/payment/
  payment.ts              currency allowlist, amount, status and payment schemas; Payment type
  payment.test.ts
  payment.status.ts       transition table, canTransition, isTerminal, assertTransition, statusChange
  payment.status.test.ts
  index.ts                named re-exports
```

Status graph:

```
pending ──► processing ──► succeeded
   │             └───────► failed
   └──► cancelled

final: succeeded, failed, cancelled
```

Who uses each edge (for orientation; enforced in later milestones, not here):
- `pending → processing`: the processor claims a payment (BE-03-05). The compare-and-set claim is what stops an admin `cancelled` and the processor from both winning.
- `processing → succeeded | failed`: the processor records the gateway result or a timeout (BE-03-05). An admin PATCH may also use these (BE-03-04).
- `pending → cancelled`: admin PATCH (BE-03-04, BE-03-06).
- After a restart, payments still in `processing` are the in-flight ones BE-03-05 resumes.

Payment record:

```ts
{
  id: string;              // uuid
  userId: string;          // owner, the JWT `sub`
  email: string;           // owner's email at creation, carried into events
  amount: number;          // positive safe integer, minor units
  currency: "NGN" | "USD" | "EUR" | "GBP";
  status: "pending" | "processing" | "succeeded" | "failed" | "cancelled";
  description?: string;    // 1–140 chars
  failureReason?: string;  // 1–200 chars, present exactly when status is "failed"
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  version: number;         // managed by the repository
}
```

## Code Evidence

| Behavior | Source |
|---|---|
| `services/payment/src` has only `app.ts`, `main.ts`, `openapi.ts` and `config/`; no payment model exists | `services/payment/src` |
| The payment service depends on `zod` 4.6.7 and `@payment-be/shared` | `services/payment/package.json` |
| The user model is a flat `z.object` with `z.uuid()`, `z.email()`, `z.iso.datetime()` and `version: z.number().int().positive()`, tested with an accept case plus an `it.each` reject table | `services/auth/src/user/user.ts`, `user.test.ts` |
| `Repository<T extends Versioned>.update(id, expectedVersion, patch: RecordPatch<T>)` is compare-and-set and throws `VersionConflictError` (409 `version-conflict`); `RecordPatch<T>` is `Partial<Omit<T, "id" \| "version">>` | `libs/shared/src/repository.ts` |
| `conflict(detail, { code })` builds a 409 `AppError` with type `tag:payment-be,2026:<code>` when a code is given | `libs/shared/src/errors.ts` (`problemFactory`, `conflict`) |
| `openRepository({ schema })` validates every record loaded from file against the schema, so the payment schema must accept every stored state | `libs/shared/src/storage.ts`, `libs/shared/src/file-repository.ts` |
| In zod 4.6.7, `.omit()` and `.pick()` throw `cannot be used on object schemas containing refinements` on a refined object (checked against the repo's zod during intake) | `node_modules/.pnpm/zod@4.6.7` |
| No payment event schemas, subjects or streams exist yet | `libs/shared/src/events.ts`, `tasks/BE-01-02-shared-lib.md` (Excluded) |
| `README.md` describes the flow as `pending` then `payment.succeeded` / `payment.failed`, with no `processing` or `cancelled` | `README.md`, Payment flow |

## Scope

- **Schemas** in `payment/payment.ts`:
  - `CURRENCIES`: a readonly map of currency code to minor-unit exponent (`NGN`, `USD`, `EUR`, `GBP`, all `2`), and `currencySchema` built from its keys. Adding a currency is a one-entry change.
  - `amountSchema`: integer, greater than 0, at most `Number.MAX_SAFE_INTEGER`. Rejects floats, zero, negatives and strings.
  - `paymentStatusSchema` and the `PaymentStatus` type.
  - `paymentFieldsSchema`: the plain object with the fields above, without refinements, so BE-03-02 and BE-03-03 can `.pick()`/`.omit()` from it for request and response schemas.
  - `paymentSchema`: `paymentFieldsSchema` plus a refinement that `failureReason` is present exactly when `status` is `failed`. This is the schema passed to `openRepository` in BE-03-02.
  - `Payment` type inferred from `paymentSchema`.
- **State machine** in `payment/payment.status.ts`:
  - `PAYMENT_TRANSITIONS`: `Record<PaymentStatus, readonly PaymentStatus[]>` matching the graph above. Final statuses map to `[]`.
  - `canTransition(from, to)`: true only for an edge in the table. A same-status change (for example `pending → pending`) is not allowed.
  - `isTerminal(status)`: true for `succeeded`, `failed`, `cancelled`.
  - `assertTransition(from, to)`: throws `conflict(...)` with code `invalid-status-transition` and a detail naming both statuses (for example "Cannot change payment status from succeeded to pending."). Statuses are not sensitive, so naming them is fine.
  - `statusChange(payment, to, { failureReason?, now? })`: asserts the transition and returns the `RecordPatch<Payment>` to pass to `repository.update(payment.id, payment.version, patch)`: `status`, `updatedAt` (from `now`, defaulting to the current time) and, for `failed`, `failureReason`. It throws if `failureReason` is missing for `failed`, given for any other status, or fails `failureReasonSchema` (1–200 characters), so callers cannot write a record that `paymentSchema` would reject. These `failureReason` errors are internal invariant errors (plain `Error` or `ZodError`, a 500 if they ever reached HTTP), not client errors; only a rejected transition is a `409`. It does not touch the repository.
- **Module entry** `payment/index.ts` re-exporting the above by name, with the `biome-ignore lint/performance/noBarrelFile: module entry point` header.
- **Tests** next to each file:
  - `payment.test.ts`: a valid payment parses for every status (with `failureReason` only on `failed`); reject table covering an unknown currency, lowercase currency, float, zero, negative and unsafe amounts, a string amount, an unknown status, a bad email, a non-uuid id, an empty or 141-char description, `failureReason` missing on `failed`, `failureReason` present on `succeeded`, and a zero version. `paymentFieldsSchema.pick(...)` works.
  - `payment.status.test.ts`: the full 5 × 5 `canTransition` matrix (exactly the four allowed edges are true); `isTerminal` for each status; `assertTransition` throws an `AppError` with status 409, code `invalid-status-transition` and type `tag:payment-be,2026:invalid-status-transition` on a rejected edge and returns on an allowed one; `statusChange` returns the expected patch for each allowed edge, uses the injected `now`, requires `failureReason` for `failed`, rejects it otherwise, and throws on a rejected edge; a record with the patch applied still parses with `paymentSchema`.
- **README**: update the Payment flow steps so they mention `processing` (the processor claims the payment before calling the gateway) and that a pending payment can be cancelled. No setup, env var, endpoint or test-command change.

## Preserve

- Payment `app.ts`, `main.ts`, `openapi.ts` and config behavior and signatures. Health, docs and shutdown stay as they are.
- `libs/shared` unchanged, including the error model and repository interface.
- Every existing test.

## Excluded

- Opening the payments repository, `storageConfigSchema` in the payment config, its readiness check and shutdown task (BE-03-02).
- Any endpoint or OpenAPI registration (BE-03-02, BE-03-03, BE-03-04).
- Who may make which status change, and the get-then-compare-and-set flow with retry or `VersionConflictError` handling (BE-03-04, BE-03-05, BE-03-06).
- Idempotency key field (BE-03-07).
- Processor timing fields such as a claim time or attempt count, and the set of `failureReason` values (BE-03-05).
- Outbox field (BE-04-02) and payment event schemas, subjects and streams (BE-04-01).
- Refunds, partial captures, more currencies, or currencies with an exponent other than 2.
- Amount formatting or conversion helpers.

## Likely Files To Touch

- `services/payment/src/payment/` (new: `payment.ts`, `payment.test.ts`, `payment.status.ts`, `payment.status.test.ts`, `index.ts`)
- `README.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None.

Settled during intake on 2026-10-18:
- **Statuses:** `pending`, `processing`, `succeeded`, `failed`, `cancelled` with the graph above. Rejected: `pending → succeeded | failed` only (nothing separates a payment the processor has claimed from one an admin may still change, and after a restart every pending payment looks in flight); adding `succeeded → refunded` (another event and email template, beyond the brief).
- **Currency:** allowlist `NGN`, `USD`, `EUR`, `GBP`, exponent 2. Rejected: any ISO 4217 code via `Intl.supportedValuesOf("currency")` (exponent 0 and 3 currencies make minor-unit amounts mean different things).
- **Storage wiring:** deferred to BE-03-02.

Defaults proposed during intake and approved by the user on 2026-10-18:
- Invalid transition is `409` with code `invalid-status-transition`, like `version-conflict`, since the request conflicts with the payment's current state.
- `failureReason` is free text, present exactly when `failed`. `description` is optional, 1–140 characters. Both are untrimmed; BE-03-02 decides input trimming.
- The state machine is actor-agnostic; roles are applied by its callers.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons.
- No new dependencies. Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or `libs/shared`. If one turns out to be needed, stop and record why in this doc first.
- Follow the module layout in `AGENTS.md`, Code style: files inside `payment/` import each other directly; anything outside imports from `payment/index.js`.
- Set the BE-03-01 roadmap row to `in-progress` and link this doc when starting.

## Deliverables

- `services/payment/src/payment/` module with schemas, state machine and tests.
- `README.md` Payment flow updated.
- `ROADMAP.md` BE-03-01 row linked and `done`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
```

- All three exit 0 with Docker stopped.
- `pnpm test -- services/payment` shows the `payment.test.ts` and `payment.status.test.ts` suites passing.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-03-01 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-03-02: open the repository with `openRepository({ name: "payments", schema: paymentSchema, ... })`, wire its check and close; derive the request schema from `paymentFieldsSchema` (amount, currency, description) and set `userId`/`email` from `getAuth(req)`.
- BE-03-04, BE-03-05: change status only through `statusChange` plus `repository.update(id, version, patch)`; decide retry or 409 on `VersionConflictError`.
- BE-04-01: decide which transitions publish events. The README already names `payment.created`, `payment.succeeded` and `payment.failed`; `processing` and `cancelled` are open there.
