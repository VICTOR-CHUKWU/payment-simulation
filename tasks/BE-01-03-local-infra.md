# BE-01-03: Local infrastructure

**Covers:** BE-01-03
**Status:** done

## Objective

One command starts the local infrastructure the services depend on: NATS with JetStream, and Mailpit as a local mail catcher. `pnpm infra:up` returns only once both are healthy, so the next command can rely on them. Keep it to one compose file and four root scripts.

## Source Context

Roadmap milestone BE-01-03 in `ROADMAP.md`. Scope was agreed during task-doc intake, and every decision is restated here. Image tags were current on Docker Hub at intake. The compose setup below was tested in a scratch project before implementation; the snippets and checks are the ones that worked.

## Design Reference

- `ROADMAP.md`, the Decisions table rows for inter-service messaging, notifications and package manager / task runner
- `AGENTS.md`, the Commands and Toolchain notes sections

## Architecture Summary

A single `compose.yaml` at the repo root runs two containers for local development only: `nats` (JetStream enabled, data on a named volume) and `mailpit` (SMTP plus a web UI). Root pnpm scripts wrap `docker compose`, so pnpm stays the only entry point. Services keep running on the host with `pnpm dev` and reach the containers through localhost ports. No application code changes in this task.

## Code Evidence

| Behavior | Source |
|---|---|
| Root scripts are the single entry point; none touch Docker yet | `package.json#scripts` |
| `.env.example` lists only variables the code reads today | `.env.example`, `tasks/BE-01-01-monorepo-scaffold.md#Environment` |
| README has Node and pnpm prerequisites and says infra steps arrive with their milestones | `README.md#Getting started` |
| AGENTS.md has a command table for root scripts | `AGENTS.md#Commands` |

## Current Behavior To Preserve

- `pnpm install`, `check`, `typecheck`, `test`, `build`, `start` and `dev` keep working without Docker running. Nothing in the services needs NATS or Mailpit yet.
- `.env.example` keeps listing only variables something reads. No new env vars in this task.

## Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose`, not the old `docker-compose` binary). Verified at intake with Docker 29.8 and Compose v5.5.

## Scope

**`compose.yaml`**
- Top-level `name: payment-be`, so containers, the network and the volume get predictable names.
- `nats` service:
  - Image `nats:2.15.1-alpine`. The alpine variant is used because it has BusyBox `wget` for the healthcheck; the scratch image has no shell or `wget`. Both tags are multi-arch, so Apple Silicon needs nothing extra. The image runs as root, which is acceptable for local use.
  - `command: ["-js", "-sd", "/data", "-m", "8222"]` enables JetStream, stores data under `/data` and turns on the monitoring port. The image entrypoint turns leading-dash arguments into `nats-server ...`, which skips the image's default config file and its cluster block. JetStream writes into `/data/jetstream`.
  - Named volume `nats-data` mounted at `/data`.
  - Ports `127.0.0.1:4222:4222` (clients) and `127.0.0.1:8222:8222` (monitoring).
  - Healthcheck, in exec form so the URL needs no shell quoting:
    ```yaml
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://localhost:8222/healthz?js-enabled-only=true"]
      interval: 5s
      start_period: 10s
      start_interval: 1s
    ```
    `interval: 5s` keeps a failing healthcheck from taking about 71s to report (10s start period plus three 30s default intervals); with it, failure reports in about 25s. `start_interval` matters: without it Docker probes every 30s, and `infra:up` took about 31s instead of about 2s. The endpoint reports JetStream readiness only when JetStream is enabled; a server without `-js` also returns ok. So it is a readiness probe, not proof that JetStream is on. Verification checks `/jsz` for that.
- `mailpit` service:
  - Image `axllent/mailpit:v1.31.6`.
  - Ports `127.0.0.1:1025:1025` (SMTP) and `127.0.0.1:8025:8025` (web UI and API).
  - No healthcheck in `compose.yaml`. The image already defines `/mailpit readyz` with a 1s start interval, and `docker compose up --wait` honours it.
  - Messages stay in memory. Losing caught emails on restart is fine for local use.
- All ports bind to `127.0.0.1` only, so nothing is reachable from the network. NATS runs without auth, which is acceptable only because of that binding.
- No `restart` policy, so the containers do not start by themselves when Docker starts.

**Root scripts**
- `infra:up`: `docker compose up -d --wait`. Blocks until both healthchecks pass, and exits 1 if either fails.
- `infra:down`: `docker compose down`. Stops and removes the containers and keeps the `nats-data` volume.
- `infra:logs`: `docker compose logs -f`.
- `infra:reset`: `docker compose down -v`. Also removes the volume, for a clean JetStream.

**Docs**
- `README.md`:
  - Add Docker with Compose v2 to the prerequisites.
  - Add `pnpm infra:up` to the install and run steps, before `pnpm dev`. Replace the sentence saying NATS and the mail catcher will be added with later milestones; keep the part about seeded demo accounts.
  - List the local addresses: NATS at `nats://localhost:4222`, the NATS monitor at `http://localhost:8222`, Mailpit at `http://localhost:8025` and SMTP at `localhost:1025`.
  - Explain that `infra:down` keeps JetStream data and `infra:reset` wipes it.
- `AGENTS.md`: add the four `infra:*` scripts to the Commands table.
- `ROADMAP.md`: the BE-01-03 row already links this doc and lists all four scripts. Set its status to `in-progress` when work starts and `done` at the end.

## Excluded

- Dockerfiles or containers for the services (BE-07-03).
- Creating JetStream streams or consumers. Services create them at startup (BE-04-01).
- NATS client code and the `NATS_URL` env var (BE-01-02).
- SMTP env vars and email sending (BE-05-04).
- NATS auth, TLS or clustering.
- Prometheus or other monitoring containers (BE-07-05 adds only a `/metrics` endpoint).

## Pre-Implementation Verification

- Confirm `nats:2.15.1-alpine` and `axllent/mailpit:v1.31.6` still exist. If a newer patch exists, use it and record the tag here. Checked at implementation: both exist on Docker Hub, and `2.15.2-alpine` and `v1.31.7` do not, so the pinned tags stand.
- Confirm host ports 4222, 8222, 1025 and 8025 are free. Stopped containers from other projects can claim them when started (at intake, stopped `ncdmb-nats` and `ncdmb-mailpit` containers existed on this machine). If a port is taken, stop and report rather than picking a different port silently, since later milestones and the README rely on these defaults.

## Likely Files To Touch

- `compose.yaml` (new)
- `package.json` (scripts)
- `README.md`, `AGENTS.md`, `ROADMAP.md`

## Decisions Required Before Implementation

None. Settled during intake:
- JetStream data persists in a named volume. `infra:reset` wipes it.
- Ports are fixed in `compose.yaml`, not read from env.
- No new env vars until a milestone reads them.

## Execution Rules

- Pin exact image tags. Never use `latest` or a bare major tag.
- Scripts must work on macOS, Linux and Windows: plain `docker compose` invocations only, no shell-only syntax.
- Do not change any service, lib or TypeScript config.

## Deliverables

- `compose.yaml` running NATS with JetStream and Mailpit, both with healthchecks.
- Four root scripts: `infra:up`, `infra:down`, `infra:logs`, `infra:reset`.
- Updated `README.md`, `AGENTS.md` and `ROADMAP.md`.

## Completion Verification

The commands use a POSIX shell (`printf` and a pipe). The `infra:*` scripts themselves are plain `docker compose` calls and work on every OS.

```sh
pnpm infra:up
docker compose ps
curl -s "http://127.0.0.1:8222/healthz?js-enabled-only=true"
curl -s http://127.0.0.1:8222/jsz
printf 'Subject: infra check\r\n\r\nhello\r\n' | curl -sS smtp://127.0.0.1:1025 --mail-from test@example.com --mail-rcpt user@example.com -T -
curl -s http://127.0.0.1:8025/api/v1/messages
pnpm infra:down
docker volume ls --filter name=payment-be_nats-data
pnpm infra:up
pnpm infra:reset
docker volume ls --filter name=payment-be_nats-data
```

- `pnpm infra:up` exits 0 in a few seconds, not about 30, and `docker compose ps` shows both containers as `healthy`.
- The NATS health endpoint returns `{"status":"ok"}`.
- `/jsz` has no `"disabled": true` field, and its `config.store_dir` is `/data/jetstream`. This is the proof that JetStream is on.
- After sending the test email, `GET /api/v1/messages` returns `"total": 1` and `messages[0].Subject` is `infra check`.
- After `pnpm infra:down`, no `payment-be` containers are running, and the filtered `docker volume ls` still lists `payment-be_nats-data`.
- `pnpm infra:up` starts again on the existing volume. This task writes no JetStream data, so this only proves the volume is reused cleanly; persistence of real streams is checked when BE-04-01 creates them.
- After `pnpm infra:reset`, the filtered `docker volume ls` lists nothing.
- Every published mapping in `docker compose ps` (each `->` entry) starts with `127.0.0.1:`. Exposed-only ports such as `6222/tcp` and `1110/tcp` have no host binding and are expected.
- `pnpm check`, `typecheck`, `test` and `build` still exit 0, and work with Docker stopped.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, the docs list only commands that were run and work, and the BE-01-03 row in `ROADMAP.md` is `done` with a link to this file.

## Follow-ups

- BE-01-02: config loader with `NATS_URL`, and the NATS client wrapper tested against this NATS.
- BE-05-04: SMTP settings pointing at Mailpit.
- BE-07-04: CI runs NATS as a service container, using the same image tag as `compose.yaml`.
