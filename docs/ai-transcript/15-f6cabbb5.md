# Session 15: Approved recommendations

Started 2026-10-18 21:56 UTC · session `f6cabbb5-9063-47d9-b171-60aad54c058e`

---

### You

> /task-doc-intake BE-03-07

_Actions: Bash; Bash; Bash; Bash; Bash_

### Claude

Reading the payment service and shared repository code to ground the idempotency design.

_Actions: Bash_

### Claude

I have enough to propose the scope. **Classification:** feature-grade. It changes the API contract (new header, new 200/422 responses) and adds a field to stored payments. AGENTS.md also lists BE-03-07 as needing an approved task doc.

## BE-03-07 intake: idempotency keys on payment creation

**Objective:** If a client retries `POST /payments` with the same key (after a timeout, say), it gets back the payment it already made instead of creating a second one.

**What the code does today**
- `createPaymentService.create` in [payment.service.ts](services/payment/src/payment/payment.service.ts) inserts a fresh `randomUUID()` payment on every call, with no dedupe of any kind.
- The repository has no unique index. Auth handles the same problem for emails by putting creates in a queue so they run one at a time, then doing a check followed by an insert ([user.service.ts](services/auth/src/user/user.service.ts)). That pattern can be reused here.
- `paymentFieldsSchema` ([payment.ts](services/payment/src/payment/payment.ts)) has no key field. `toPaymentResponse` removes `version` from responses.
- CORS (`corsPolicy` in [security.ts](libs/shared/src/security.ts)) leaves `allowedHeaders` unset, so the `cors` package echoes back whatever headers a browser asks for. A new request header needs no change to `libs/shared`.
- BE-03-02 is committed on this branch but not merged to `main` yet. BE-03-07 builds on top of it.

**Proposed scope (my recommendations)**
1. **Key goes in an `Idempotency-Key` request header**, not the body. This follows the IETF draft and Stripe, and it leaves `CreatePaymentRequest` unchanged. Allowed values: 1–255 printable ASCII characters. Anything else gets `400 validation-error`.
2. **The key is optional.** Without it, the endpoint behaves exactly as it does now.
3. **Keys are scoped to the user** (`userId` + key). Two users can send the same key without colliding, and nobody can read another user's payment by guessing a key.
4. **The key is stored on the payment** as a new optional `idempotencyKey` field. No separate store and no expiry: the key lasts as long as the payment, and it survives restarts through the JSON file. To spot a reused key, the service compares `amount`, `currency` and `description` with the stored payment, so no request hash is needed.
5. **What each case returns:**
   - Same key, same body → `200` with the payment's **current** state, which may have moved past `pending` by then. No new record is created, so BE-04-02 won't publish a second event.
   - Same key, different body → `422 idempotency-key-reused`, as the IETF draft specifies.
   - Two requests with the same key at the same time → creates run one at a time, as in auth, so the second request waits and gets the `200` replay. The IETF draft's `409` for requests still in progress is never needed.
6. **The key is not in the response.** `toPaymentResponse` removes `idempotencyKey` as well as `version`, so the `Payment` schema stays the same.
7. **OpenAPI:** register the optional header parameter, the `200` replay response and the `422` error.
8. **Tests:**
   - Service: replay, mismatch, per-user scoping, no key, and concurrent creates with one key producing one record.
   - Routes: supertest for the `201` → `200` replay, `422`, an invalid header returning `400`, and different users with the same key.
   - OpenAPI: assertions on the spec.
9. **Docs:** a README note in the Payment endpoints section, and set the roadmap row to done.

**Unchanged:** the request body and response schema, behaviour without a key, `libs/shared`, the state machine, and the auth and notification services.

**Excluded:** key expiry or cleanup, keys on any endpoint other than create, an `Idempotent-Replayed` response header (that would need a CORS expose-header change in `libs/shared`), and making the key required.

**Files likely to change:** `payment.ts` (plus its test), `payment.service.ts` (plus its test), `payment.controller.ts`, `payment.schema.ts`, `payment.openapi.ts`, `payment.routes.test.ts`, `app.test.ts`, `README.md`, `ROADMAP.md`, and the new task doc.

**Checks:** `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then a manual check: send the same key twice and confirm one record in `payments.json`.

**Decisions for you.** Each has my recommended default:
- **Optional or required key?** I recommend optional. Required is stricter, but it breaks every existing client and test.
- **Replay status: `200` or `201`?** I recommend `200`, because it tells the client the payment was not newly created without adding a header. Stripe returns the original `201` plus a replay header instead.

Do you approve this scope, or want to change any of it? Once you approve, I'll write `tasks/BE-03-07-idempotency-keys.md`.

### You

> i approve and agree with your recomendations

_Actions: Skill: task-doc; Bash; Write: tasks/BE-03-07-idempotency-keys.md_

### Claude

Linking the doc from the roadmap row so the two point at each other:

_Actions: Edit: ROADMAP.md_

### Claude

Written for: whoever implements BE-03-07 (you, a teammate or another agent), without needing this chat.

I've written the BE-03-07 task doc at [tasks/BE-03-07-idempotency-keys.md](tasks/BE-03-07-idempotency-keys.md) and linked it from the BE-03-07 row in [ROADMAP.md](ROADMAP.md). The row's status is still `todo`.

The doc covers the scope you approved: an optional `Idempotency-Key` header, scoped to each user and stored on the payment with no expiry. Repeating a request with the same key and body returns `200` with the payment as it is now. Reusing a key with a different body returns `422 idempotency-key-reused`. Creates run one at a time, so two simultaneous requests with the same key produce one payment. It also lists the tests, the OpenAPI and README changes, and what's excluded. It has no open decisions.

Two things I added while writing it:
- **Lookups only run when a key is present.** The repository's `findOneBy` ignores undefined values, so looking up with no key would match any of the caller's payments.
- **The key is never logged**, the same as tokens and emails.

Both files are uncommitted on `feat/BE-03-02-create-payment`. BE-03-02 hasn't merged to `main` yet, and BE-03-07 builds on it, so implementation should branch from it or wait for the merge. I haven't started the implementation.

### You

> /review-task-docs @tasks/BE-03-07-idempotency-keys.md , use a subagent to review and fix any findings

_Actions: Agent: Review and fix BE-03-07 task doc_

### Claude

Checking the subagent's logging claim and its edits before I report back.

_Actions: Bash_

### Claude

A subagent reviewed [tasks/BE-03-07-idempotency-keys.md](tasks/BE-03-07-idempotency-keys.md) and gave it **revise**: the design is sound, but parts of the doc were wrong or contradicted each other. It made the fixes in the doc and touched no code. I checked the main logging claim against [logger.ts:24-29](libs/shared/src/logger.ts#L24-L29) and it is correct.

**What was fixed, highest risk first:**
1. **The key does get logged, so the doc's rule was impossible to follow.** The doc said the key is never logged. But the request logger writes all request headers and only hides `authorization` and `cookie`, so the key appears on every request log line. The rule now says not to put the key in our own log lines, and accepts that it stays in the request log because it isn't a credential.
2. **Two existing tests have to change, which the doc said wouldn't happen.**
   - `app.test.ts:84-95` checks the exact list of responses, so adding `200` and `422` breaks it.
   - `payment.service.test.ts` uses `create`'s return value as the payment, but `create` will now return `{ payment, replayed }`.

   The doc now names both as allowed updates.
3. **Header name in the API docs.** The OpenAPI library uses the schema's key exactly as written for the header name. The doc now says to register it as `Idempotency-Key`, so the spec doesn't show the lowercase name used for parsing. The subagent generated a test spec to confirm this.
4. **Wrong source file cited.** The check that stored payments are valid on load happens in `file-repository.ts`, not `storage.ts`. Corrected.
5. **A test that could pass for the wrong reason.** Node strips spaces at the start and end of header values, so a trailing-space key would arrive clean and be accepted. The test now uses a space in the middle (`"a b"`) and also checks that the error points at `/idempotency-key`.
6. **New guard test.** A request with `idempotencyKey` in the body must still be rejected with `400`, so the key can only come from the header.

**Your call: hide the key in request logs?** That means adding the header to the hidden list in `libs/shared`, which the doc currently rules out. I'd leave it visible. The key isn't a secret, and because keys are tied to each user, knowing someone's key doesn't let you see or replay their payment. If you'd rather hide it, it's a one-line change in `libs/shared` and I'll add it to the doc's scope.

The task doc is new and the roadmap link is a one-line edit; neither is committed yet. No implementation has started.

### You

> implement @tasks/BE-03-07-idempotency-keys.md , use a subaget to review and fix any findings, branch out but dont commit as i would review myself

### Claude

I'm creating a branch from the BE-03-02 branch, keeping the task doc and roadmap changes uncommitted on it.

_Actions: Bash; Bash_

### Claude

Now the model and schemas.

_Actions: Bash_

### Claude

Service, controller and OpenAPI:

_Actions: Bash_

### Claude

Expected failures in the old service tests. Writing the tests next.

_Actions: Bash_

### Claude

Now the route tests:

_Actions: Bash_

### Claude

An empty key fails both the length and the format rules, so it reports two errors. I'll let the length rule alone handle the empty case, and move the test's regex to module level as Biome wants.

_Actions: Bash_

### Claude

All four checks pass. Updating the README next.

_Actions: Bash_

### Claude

Starting infra and the dev servers for the manual check:

_Actions: Bash; Bash; Bash_

### Claude

Replay and mismatch work against the real service. Restarting to check the key survives a reload from the JSON file:

_Actions: TaskStop; Bash; Bash_

### Claude

The replay still returns `200` with the same id after a restart. Stopping the servers and Docker, then handing the diff to a review subagent.

_Actions: TaskStop; Bash; Agent: Review and fix BE-03-07 implementation_

### Claude

I'm checking the reviewer's README fix and re-running the checks. I already did the manual run before the review, so I'm also marking the milestone done.

_Actions: Bash_

### Claude

BE-03-07 is implemented on a new branch, `feat/BE-03-07-idempotency-keys`, created from the BE-03-02 branch. Nothing is committed, as you asked. `pnpm check`, `typecheck`, `test` (449 tests) and `build` all pass.

**What it does now**
- `POST /payments` accepts an optional `Idempotency-Key` header, and keys are separate for each user.
- The first request with a key returns `201`. Repeating it with the same body returns `200` with the existing payment in its current state, and no new payment is created.
- Reusing a key with a different `amount`, `currency` or `description` returns `422 idempotency-key-reused`.
- An invalid key returns `400`. A request without the header behaves exactly as before.
- The key is saved on the payment but never shown in responses. Two requests arriving at once with the same key still create only one payment.

**Manual run:** I started NATS, Mailpit and the dev servers and logged in as the seeded user. The first request returned `201`, the repeat `200` with the same id, and a changed amount `422`. `payments.json` held one payment with that key. After restarting the payment service, the repeat still returned `200` with the same id. I stopped Docker afterwards.

**What the review subagent found and fixed**
- **README note in the wrong section:** my Idempotency-Key note had landed under Auth endpoints. It moved the note to Payment endpoints.
- **Repeated header:** Node joins two `Idempotency-Key` headers into one value with a comma and space, and the space makes it invalid, so it returns `400`. It added a test for that.
- **Task doc said the key appears only in the request-completed log line:** it actually appears in every log line for that request, including "payment created", because the shared request logger attaches all headers. It corrected the doc; the code didn't change.

**One small change from the task doc:** the rule for valid keys lives in [payment.ts](services/payment/src/payment/payment.ts), with the model, rather than in `payment.schema.ts`. The header wrapper is still in `payment.schema.ts`.

**Decision for you:** keys currently show up in request logs. Hiding them is a one-line change in `libs/shared` that this task ruled out. I'd leave them visible, because a key isn't a secret and knowing one doesn't let anyone see another user's payment.

I've set BE-03-07 to `done` in [ROADMAP.md](ROADMAP.md) and in the task doc, ready for your review. 12 files are modified, and the task doc [tasks/BE-03-07-idempotency-keys.md](tasks/BE-03-07-idempotency-keys.md) is new and untracked.

### You

> commit and push

_Actions: Bash_

### Claude

I committed BE-03-07 as `a292b6d` ("Add idempotency keys to POST /payments (BE-03-07)") and pushed it to `origin/feat/BE-03-07-idempotency-keys`. The branch now tracks the remote. The commit has the 12 changed files and the new task doc, and nothing was left uncommitted.

This branch was cut from the BE-03-02 branch, which hasn't merged to `main` yet. So a PR from it against `main` would also include the BE-03-02 commit (`99181ce`). You can either merge BE-03-02 first or open this PR against `feat/BE-03-02-create-payment`.

I haven't opened a PR. To open one yourself: https://github.com/VICTOR-CHUKWU/payment-simulation/pull/new/feat/BE-03-07-idempotency-keys
