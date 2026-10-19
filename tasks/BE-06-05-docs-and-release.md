# BE-06-05: Final README, architecture docs and clean-clone release check

**Covers:** BE-06-05, BE-06-06, BE-06-07
**Status:** todo

## Objective

Finish the project's documentation and prove a newcomer can run it from the public repository. When this task is done:

- The README reads as the finished project, not a work in progress. It covers setup, running locally, demo accounts, the API reference, the testing approach (unit, API, coverage and integration) and design notes.
- An architecture document explains the system with diagrams: the services and their boundaries, the payment and notification flow, the event catalogue, and how failures are handled (outbox, inbox dedupe, email retries, dead-letter queue).
- Someone following only the README, starting from a fresh clone of the GitHub repository, can install, start the infrastructure and services, use the demo accounts, run every test command, and see a payment produce notifications and emails.

## Source Context

Roadmap Phase 6 milestones in `ROADMAP.md`:

- BE-06-05: "README finalised (setup, run locally, demo accounts, API reference, testing approach, design notes)"
- BE-06-06: "Architecture docs (service diagram, event catalogue, failure handling)"
- BE-06-07: "Git repository published with run-locally instructions verified from a clean clone"

On 2026-10-19 the user chose to run Phase 6 as three task docs, with this one last: it documents the finished system and verifies the instructions, so it must follow BE-06-01 to BE-06-04. Phase 7 is deferred, so this task closes the project's planned scope.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- **Architecture docs live in `docs/architecture.md`** (one file), linked from the README's "Architecture" and "Project docs" sections. The README keeps its short overview and points there for detail.
- **Diagrams are Mermaid** blocks in Markdown, which GitHub renders, so they stay text and reviewable in diffs. At least: a service and infrastructure diagram, a payment lifecycle sequence (create → process → events → in-app and email), and a failure-handling diagram (outbox relay; per-channel inbox; retry, DLQ and replay).
- **The event catalogue stays in the README's "Events" table** as the single source; `docs/architecture.md` links to it instead of copying it.
- **Status note:** replaced by a short "What it does" summary; no "in progress" or "will be added" wording remains.

## Design Reference

- `AGENTS.md`: the README is updated as each milestone lands, and "BE-06-05 only finalises it". `ROADMAP.md` is the source of truth for decisions.
- `ROADMAP.md`, Decisions table: every row is a candidate for the design notes, especially Architecture, Inter-service messaging, Async model, Money, Persistence, Notifications, Email failure handling, Caching and Scope.
- Task docs in `tasks/`: each has the reasoning behind its design (for example `BE-04-02` outbox, `BE-05-02` inbox, `BE-05-05` retries and DLQ). Design notes summarise and link them rather than repeating them.

## Current State

| Fact | Source |
|---|---|
| README sections: The brief, Architecture (Payment flow, Events), Tech stack, Getting started (Prerequisites, Install and run, Health checks, Storage and demo accounts, Logging, Local infrastructure, Checks), API (Responses, Auth, Payment, Notification, Admin DLQ endpoints, Errors), Testing, Project docs | `README.md` |
| The status note still says "in progress" and "Setup, run, API and testing instructions will be added as each part lands" | `README.md` line 5 |
| "Testing" says "This section will grow to cover cross-service integration tests" | `README.md` "Testing" |
| There is no "Design notes" section and no `docs/` folder | `README.md`, repo root |
| The repository is public at `github.com/VICTOR-CHUKWU/payment-simulation`, with an empty description and no `LICENSE` file | `gh repo view`, repo root |
| `.gitignore` covers `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, `.env`, `services/*/data/`, `*.log`, `.DS_Store` | `.gitignore` |
| Node 24 and the pinned pnpm version (`packageManager`) are prerequisites; Docker runs NATS and Mailpit | root `package.json`, README "Prerequisites" |

BE-06-01 to BE-06-04 add `pnpm test:coverage`, `pnpm test:integration` and the `infra:test:*` scripts and change "Testing"; this task works from whatever they ship, not from the list above.

## Decisions

Settled by the user on 2026-10-19:

- **D1: list known limitations in the README** (the recommended option below).
- **D2: add an MIT licence**, with the copyright line `Copyright (c) 2026 Okenwa`.
- **D3: skip the GitHub repository metadata.** The description and topics stay as they are.

**D1. Known limitations in the README.** The project has a few deliberate limits recorded in task docs, for example:
- gateway timeouts are marked `failed` (a real system would retry or reconcile);
- a permanently rejected outbox event would block that payment's later events;
- an inbox read failure uses up an email attempt;
- under `pnpm dev`, one Ctrl+C reaches the services twice and skips graceful shutdown.

Options:
- **(Chosen)** A short "Known limitations" list under "Design notes", one line each with a link to the task doc that explains it. Reviewers see the trade-offs were deliberate.
- Leave them out of the README. They stay only in task docs.

**D2. Licence.** The public repository has no `LICENSE`, so by default nobody may reuse the code.
- **(Chosen)** Add an MIT licence in `LICENSE`: `Copyright (c) 2026 Okenwa`.
- Leave it unlicensed.

**D3. GitHub repository metadata.** The repository has no description or topics. Setting them changes a public page, so it needs explicit approval.
- Set a one-line description and topics with `gh repo edit`.
- **(Chosen)** Leave them empty.

## Scope

- **README (BE-06-05):**
  - Replace the status note with a short summary of what the system does.
  - Check every setup and run instruction against the code (scripts in `package.json`, env vars in each `config.ts` and `.env.example`, ports, demo accounts); fix any drift.
  - "Testing": the testing approach as one coherent section: unit tests next to the code, API tests with supertest through `createApp`, the coverage report, the integration suite and what it needs (Docker, test containers), and which command runs what.
  - A new "Design notes" section: the key decisions and why (service split — link to the existing "What was added, and why" section rather than repeating it — events over JetStream, outbox and inbox, background processing, integer money, file-or-memory storage, no cache, email retries and DLQ), each one or two sentences with a link to its task doc or `docs/architecture.md`; plus "Known limitations" per D1.
  - "API": a one-line pointer to each service's Swagger UI and spec as the full reference; the existing endpoint tables stay as the summary.
  - Remove every "will be added", "for now" and "arrives with BE-…" phrase that no longer holds.
- **Architecture docs (BE-06-06):** `docs/architecture.md` with the diagrams listed under defaults and short prose for each: service responsibilities and data ownership; how a payment moves through the system; the event catalogue (linked); failure handling (outbox relay and ordering, consumer dedupe, at-least-once delivery, email retries and DLQ, readiness and graceful shutdown).
- **Clean-clone check (BE-06-07):** see Completion Verification. Fix any instruction that fails, in the README or `.env.example`.
- **Licence (D2):** an MIT `LICENSE` at the repo root, and a one-line "Licence" note at the end of the README linking to it.
- **Roadmap:** link this doc from BE-06-05, BE-06-06 and BE-06-07. Set them to `in-progress` when starting and `done` when finished.

## Preserve

- Code and tests: this task changes documentation, `.env.example` and adds `LICENSE`. A code bug found during the clean-clone check is recorded and fixed in its own change unless it is a one-line fix.
- The README's existing API tables, error table and examples, unless they are wrong.
- `ROADMAP.md`'s structure and `AGENTS.md`.

## Excluded

- Any Phase 7 work (deferred).
- New features, refactors or test changes.
- A documentation website or generated API docs beyond Swagger UI.
- The user's separate project handoff note.
- GitHub repository settings, description and topics (D3).

## Likely Files To Touch

- `README.md`, `docs/architecture.md` (new), `.env.example` (only if drift is found)
- `LICENSE` (new)
- `ROADMAP.md`

## Prerequisites

- BE-06-01, BE-06-02, BE-06-03 and BE-06-04 are `done` and merged to `main`.

## Execution Rules

- Every command, path, port, env var and account in the docs must match the code at the commit being documented. Check, do not copy from older docs.
- Plain, concise prose in the README's existing style; Mermaid only for diagrams.
- No changes to GitHub repository settings (D3).

## Deliverables

- Final `README.md` and `docs/architecture.md`.
- A clean-clone run log in the PR description.
- An MIT `LICENSE`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0.
- Mermaid diagrams render on GitHub (check the PR's file view) and every relative link in `README.md` and `docs/architecture.md` resolves.
- `grep -nE "in progress|will be added|for now|arrives with BE-" README.md` finds nothing that is still untrue.
- **Clean clone.** Make sure no other `pnpm dev` is running and the dev containers are down, then in a new temporary directory:
  - `git clone https://github.com/VICTOR-CHUKWU/payment-simulation.git` (the branch under review, or `main` after merge), and follow the README literally from "Prerequisites": install, copy `.env.example`, `pnpm infra:up`, `pnpm dev`.
  - Log in with each demo account, create a payment, and see it settle, its in-app notifications, and its emails in Mailpit.
  - Run `pnpm test`, `pnpm test:coverage` and the integration suite exactly as "Testing" describes.
  - Open each service's `/docs`.
  - Any step that needs knowledge not in the README is a failure: fix the README and repeat.
  - Record each command and its result in the PR, then delete the temporary directory and stop its containers.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and BE-06-05, BE-06-06 and BE-06-07 in `ROADMAP.md` are `done` and link to this file.

## Follow-ups

- If Phase 7 is ever picked up, update the README and architecture doc in each Phase 7 change.
