# BE-05-04: Email channel via SMTP

**Covers:** BE-05-04
**Status:** done

## Objective

Make the email channel send one email per payment event that matters to the user, over SMTP (Mailpit locally). The `notification-email` consumer's handler sends to the address carried in the event, for the same four types the in-app channel stores: `payment.created`, `payment.succeeded`, `payment.failed` and `payment.cancelled`. Each email has a subject, a plain-text body and a simple HTML body. A failed send naks the message with a fixed delay, so an SMTP outage retries every few seconds instead of in a tight loop, until BE-05-05 replaces it with bounded backoff. The email address is never logged. Everything ships with unit tests.

## Source Context

Roadmap milestone BE-05-04 ("Email channel via SMTP (templates per payment event)") in `ROADMAP.md`. Scope was agreed during task-doc intake on 2026-10-19. The user chose:

- **Events: the same as in-app.** `created` (a receipt), `succeeded`, `failed` and `cancelled`. `payment.processing` never emails. The handler still runs for it and the inbox marker is still written.
- **On failure: nak with a fixed delay.** A failed send calls `msg.nak(delayMs)` with 5 s instead of an immediate `nak()`. BE-05-05 replaces this with consumer `backoff` and a bounded `max_deliver`, and BE-05-06 adds the DLQ.
- **Readiness: no SMTP check.** SMTP being down only delays email. In-app notifications and the HTTP API keep working, so `/health/ready` does not change. Failures show in the logs.
- **Format: text plus simple HTML.** Each template returns a subject, a plain-text body and a minimal inline-styled HTML body, built in TypeScript with every interpolated value HTML-escaped. No template engine.

Defaults written into this doc for review (not confirmed separately; change them here before implementation if needed):

- **Library: `nodemailer` `10.0.15`**, the newest release at least two weeks old at intake (published 2026-10-05). It has no runtime dependencies and no install scripts (so no `allowBuilds` entry), needs Node `>=20`, and ships its own type declarations beside its ESM entry (`dist/esm/nodemailer.d.ts`), so no `@types` package. Import it as `import { createTransport } from "nodemailer"`. Hand-rolling SMTP is out of scope.
- **Wording reuses the in-app text.** The subject is `renderNotification`'s `title`, and both bodies are built around its `message`, so the two channels never disagree.
- **The fixed nak delay applies to both channels.** The handler is shared, and an in-app storage failure loops the same way. It is one constant, `NAK_DELAY_MS = 5000`, not an env var; BE-05-05 owns retry configuration.
- **Env vars:** `SMTP_HOST` (default `localhost`), `SMTP_PORT` (default `1025`), `SMTP_FROM` (default `Payment Simulation <no-reply@payment-simulation.local>`). No SMTP auth or TLS: the only target is Mailpit.
- **Timeouts:** `connectionTimeout`, `greetingTimeout` and `socketTimeout` of 10 s each, so an unreachable or silent server fails inside the 30 s `ack_wait`. Nodemailer's own defaults are 2 minutes, 30 s and 10 minutes. A refused connection (Mailpit stopped) fails within milliseconds regardless.
- **`Message-ID`** is `<eventId@payment-simulation.local>`, so a resend after a crash carries the same ID and mail clients can thread or dedupe it.
- **`notification-email` keeps its `payment.>` filter.** BE-05-01's follow-up suggested narrowing it to the emailed events and adding an SMTP readiness check. The readiness check is rejected above. Narrowing would need `filter_subjects` with four subjects and a consumer update for existing deployments, to skip one cheap no-op event; the in-app consumer keeps the same filter, so both stay identical.

Review on 2026-10-19 checked these defaults against nodemailer 10.0.15 and the current code; the values are unchanged, and only the timeout and library facts were corrected.

## Design Reference

- `AGENTS.md`, Architecture constraints: payment events carry `userId` and email so notification never looks users up; consumers are idempotent and dedupe per channel; never log passwords, tokens or auth headers; Zod for env config.
- `ROADMAP.md`, Decisions table: Notifications ("In-app … and email (SMTP to Mailpit locally), each on its own durable consumer"); Email failure handling (retries with backoff bounded by `max_deliver`, then a DLQ; that is BE-05-05 and BE-05-06, not this task); Logging.
- `tasks/BE-05-02-idempotent-event-handling.md`, Follow-ups: "BE-05-04: plug email sending into `onEvent`. A crash between sending and the marker sends the email again, which the at-least-once choice accepts."
- `tasks/BE-05-01-notification-consumers.md`: never log `data.email`, `data.description` or the raw payload; `ack_wait` stays at the 30 s server default.
- `tasks/BE-05-03-inapp-notifications.md`: `renderNotification`, `formatAmount` and `NOTIFIED_TYPES` live in `services/notification/src/notification/`.

## Architecture Summary

```
services/notification/src/
  email/
    email.templates.ts    renderEmail(event) → { subject, text, html } | undefined   (undefined for payment.processing)
                            built on renderNotification(event); HTML escapes every value
    email.transport.ts    createMailer({ host, port, createTransport? }) → Mailer
                            Mailer = { send(message) → Promise<{ messageId }>, close() }
                            createTransport defaults to nodemailer's; tests pass a fake
                            transport options: { host, port, secure: false,
                              connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 }
                            (no logger/debug option: nodemailer's own logger would print addresses)
    email.service.ts      createEmailService({ from, mailer }) → { send(event, logger) → Promise<void> }
                            renderEmail → undefined: return
                            mailer.send({ from, to: data.email, subject, text, html, messageId })
                            on success: logger.info "email sent"
                            on error: throw EmailSendError (sanitized, see below); EmailSendError lives here
    index.ts              createMailer, Mailer, createEmailService, EmailService, EmailSendError, renderEmail
  consumer/consumer.handler.ts   nak(NAK_DELAY_MS) instead of nak(); ConsumerMessage.nak takes an optional delay
  config/config.ts               SMTP_HOST, SMTP_PORT, SMTP_FROM
  main.ts                        createMailer before the consumers start; email handler gets
                                   onEvent = (event, log) => emailService.send(event, log)
                                 shutdown: [stop in-app, stop email, drainNats, inbox.close, notifications.close, mailer.close]
```

Email content (`<amount>` is `formatAmount`, so `NGN 1,500.00` with a no-break space):

| Part | Content |
|---|---|
| Subject | `renderNotification(event).title`, e.g. `Payment succeeded` |
| Text | `message`, a blank line, `Payment ID: <paymentId>`, a blank line, a one-line footer saying it was sent by the payment simulation |
| HTML | the same three parts in a single inline-styled block: `<h1>` title, `<p>` message, `<p>` payment ID, small footer. No images, links or external CSS |

The HTML escapes `&`, `<`, `>`, `"` and `'` in every interpolated value. `description` and `failureReason` are user- or admin-supplied, so an unescaped `<script>` or `<a>` would land in the email.

**Never log the address.** Nodemailer errors can quote the recipient (for example `550 5.1.1 <ada@example.com>: Recipient address rejected`) in `message`, `stack` and `response`, and carry it in `recipient`, `rejected` and `rejectedErrors`. The handler logs `err` on "event handling failed", and the shared logger's redaction only covers keys named `email` (and `password`, `token`, `accessToken`), not text inside other fields. So `email.service.ts` catches every send rejection (Error or not) and throws a new `EmailSendError` built from an allowlist: a fixed message (for example `Email send failed`), and nodemailer's `code` (such as `ESOCKET` for a refused connection, `ETIMEDOUT`, `EENVELOPE`), `responseCode` and `command` when present. Everything else is dropped, and it does not set `cause`: pino's `err` serializer appends every cause's message and stack to the logged `message` and `stack`. Because the error is new, its own `stack` holds only the fixed message.

**Logging.** On success `send` logs "email sent" at `info` through the `logger` argument, which is the handler's child logger (already carrying `correlationId`, `eventId` and `userId`), with `channel: "email"`, `type` and the `messageId` returned by the mailer. It never logs `to`, `subject`, `text` or `html`.

**Failure and redelivery.**
- A send error throws from `onEvent`, so the handler logs "event handling failed" and calls `msg.nak(NAK_DELAY_MS)`. JetStream redelivers after 5 s, with no `max_deliver` limit until BE-05-05. The same delayed nak applies when `inbox.get` throws, since it shares that catch.
- While one message waits out its delay, the consumer keeps handling the next ones, so after a short failure the emails for one payment can arrive out of order (for example `Payment succeeded` before `Payment received`). Accepted for now; each email stands alone.
- The marker is written only after a successful send (BE-05-02). A crash between the send and the marker sends the email again on redelivery, with the same `Message-ID`. The at-least-once choice accepts this.
- An unreachable or silent server fails within the 10 s timeouts, well inside the 30 s `ack_wait`. A live server that answers each command just under `socketTimeout` could exceed it; the redelivery then waits behind the running handler and is acked as a duplicate once the marker exists (BE-05-02), so the result is at most one extra email.

**Startup and shutdown.** `createMailer` builds the transport without connecting. Nodemailer connects per message (no pool), so startup does not depend on SMTP being up, which matches the no-readiness-check choice. `close()` runs last on shutdown, after `drainNats`. For the non-pooled SMTP transport it only emits `close`, so it is cheap; it stays so a pooled transport later needs no shutdown change.

**Nak delay.** `ConsumerMessage.nak` becomes `(delayMs?: number) => void`, which `JsMsg.nak(millis?: number)` already satisfies (`@nats-io/jetstream` `lib/jsmsg.d.ts`). Only the "event handling failed" path uses the delay. The handler's other paths (term on invalid input, ack on a duplicate, ack after a marker write failure) are unchanged. BE-05-02 acked after a marker write failure because an immediate nak would loop; that reasoning still holds with a 5 s delay (each retry would send the email again), so that path stays an ack.

## Code Evidence

| Behavior | Source |
|---|---|
| `createEventHandler` calls `msg.nak()` with no delay when `inbox.get` or `onEvent` throws, and logs `{ channel, err }` as "event handling failed" | `services/notification/src/consumer/consumer.handler.ts` |
| `ConsumerMessage.nak: () => void` | `services/notification/src/consumer/consumer.handler.ts` |
| `JsMsg.nak(millis?: number): void` | `@nats-io/jetstream` `lib/jsmsg.d.ts` |
| `startConsumer` awaits each `handle(msg)` in turn, one message at a time per consumer | `libs/shared/src/consumers.ts` |
| Consumers set no `ack_wait`, `max_deliver` or `backoff` (server defaults: 30 s, unlimited, none) | `services/notification/src/consumer/consumer.config.ts`, `tasks/BE-05-01-notification-consumers.md` |
| The email handler is created with no `onEvent`; the in-app one uses `service.record`; shutdown is `[stop consumers…, drainNats, inbox.close, notifications.close]` | `services/notification/src/main.ts` |
| `renderNotification(event)` returns `{ title, message }` for the four notified types and `undefined` for `payment.processing`; `formatAmount` and `NOTIFIED_TYPES` are exported | `services/notification/src/notification/notification.render.ts`, `notification.ts`, `index.ts` |
| Event `data` carries `email`, `paymentId`, `userId`, `amount`, `currency`, optional `description`, and `failureReason` only on `payment.failed` | `libs/shared/src/payment-events.ts` |
| `notificationConfigSchema` extends base, storage and JWT config and adds `NOTIFICATION_PORT` | `services/notification/src/config/config.ts` |
| Mailpit runs in compose on `127.0.0.1:1025` (SMTP) and `127.0.0.1:8025` (web UI and API), with no auth | `compose.yaml`, README "Local infrastructure" |
| `.env.example` has no SMTP variables | `.env.example` |
| No SMTP library is installed in any package | `services/*/package.json`, `libs/shared/package.json` |
| `nodemailer@10.0.15` has no `types` field and no `types` export condition, but `exports["."].import` is `dist/esm/nodemailer.js` (in a `"type": "module"` folder) with `dist/esm/nodemailer.d.ts` beside it. TypeScript 6.0.3 with `nodenext` resolves it, and both `import { createTransport }` and the default import typecheck (checked in a scratch project with this repo's compiler options) | npm registry tarball, `tsconfig.base.json` |
| Jest's ESM mode resolves nodemailer's `import` condition even though `customExportConditions` lists only `development`, `node`, `node-addons` (checked with this repo's Jest) | `jest.config.js` |
| `nodemailer@10.0.15`: no `dependencies`, no `preinstall`/`install`/`postinstall` scripts (`prepare` only runs for git installs), `engines.node >=20` | npm registry metadata |
| Transport options `secure`, `connectionTimeout` (default 2 min), `greetingTimeout` (default 30 s), `socketTimeout` (default 10 min); `sendMail` takes `messageId` and resolves to `{ messageId, … }`; `close()` on the SMTP transport only emits `close`; with no `logger` option nodemailer logs nothing | `dist/esm/smtp-connection/index.d.ts`, `index.js`, `dist/esm/smtp-transport/index.js`, `dist/esm/shared/index.js` |
| `NodemailerError` has `code`, `command`, `response`, `responseCode`, `recipient`, `rejected`, `rejectedErrors`. A refused connection rejects within milliseconds with `code: "ESOCKET"`, `command: "CONN"`, message `connect ECONNREFUSED 127.0.0.1:<port>` | `dist/esm/errors.d.ts`, local run |
| `jsonTransport: true` sends nothing over the network and resolves with the given `messageId` and the message as JSON | local run |
| pino 10.4.0's `err` serializer (pino-std-serializers 7.1.0) appends `cause` messages and stacks to `message` and `stack`, and copies every other enumerable property | `node_modules/.pnpm/pino-std-serializers@7.1.0/…/lib/err.js` |
| The shared logger redacts keys `password`, `token`, `accessToken`, `email` at depth 0 to 2, not text inside other fields | `libs/shared/src/logger.ts` |
| Mailpit's `GET /api/v1/messages` returns `{ total, messages: [{ ID, MessageID, Subject, To: [{ Name, Address }], … }] }`; Mailpit keeps mail only while its container runs | Mailpit v1.31.6 local run, README "Local infrastructure" |
| A payment `description` is any string of 1 to 140 characters, so `<b>Order & co</b>` is accepted | `services/payment/src/payment/payment.ts`, README "Payment endpoints" |
| README "Events" says "The email handler only logs events for now; sending email arrives with BE-05-04."; the status note says "Email notifications are not implemented yet." | `README.md` |

## Scope

- **Dependency**: `pnpm --filter @payment-be/notification add nodemailer@10.0.15` (exact version, as every other dependency is pinned). No other dependency changes.
- **`email/` module** as in the Architecture Summary, with an `index.ts` barrel. `email/` imports `renderNotification` from `../notification/index.js`; `notification/` imports nothing from `email/`.
- **Config**: `SMTP_HOST` (non-empty string, default `localhost`), `SMTP_PORT` (`z.coerce.number().int().min(1).max(65_535)`, default `1025`), `SMTP_FROM` (non-empty string, default above). Add all three to `.env.example`.
- **Handler**: `nak(NAK_DELAY_MS)` on the "event handling failed" path; `NAK_DELAY_MS = 5000` exported from `consumer.handler.ts`; `ConsumerMessage.nak` takes an optional delay.
- **`main.ts`**: create the mailer (`config.SMTP_HOST`, `config.SMTP_PORT`) and email service (`config.SMTP_FROM`) before the consumers start, pass `onEvent: (event, log) => emailService.send(event, log)` to the `email` handler only, and add `mailer.close` as the last shutdown task.
- **Tests** (stub mailer or nodemailer's `jsonTransport`, logs captured through a pino destination stream as in `consumer.handler.test.ts`; no network):
  - `email.templates.test.ts`:
    - Each of the four types returns the expected subject, and text and HTML that contain the message and payment ID.
    - `payment.processing` returns `undefined`.
    - A `description` of `<b>"x" & 'y'</b>` appears escaped in the HTML and verbatim in the text.
    - The `failed` email contains the `failureReason`.
  - `email.service.test.ts`:
    - `send` calls the mailer once with `from`, `to` = the event's email, the rendered parts and `messageId` `<eventId@payment-simulation.local>`.
    - `send` of `payment.processing` does not call the mailer.
    - A mailer rejection shaped like a nodemailer `EENVELOPE` error (address in `message`, `response`, `recipient`, `rejected` and `rejectedErrors`) is rethrown as `EmailSendError` with `code`, `responseCode` and `command`, no `cause`, and no address anywhere: logging it as `{ err }` through a captured logger produces a raw line without the address.
    - A rejection with a non-Error value is still rethrown as `EmailSendError`.
    - The "email sent" log line has `channel`, `type` and `messageId` and does not contain the address or the description.
  - `email.transport.test.ts` (fake `createTransport`): `createMailer` passes host, port, `secure: false` and the three 10 s timeouts, and no `logger` or `debug`; `send` resolves with the transport's `messageId`; `close` calls the transport's `close`.
  - `consumer.handler.test.ts`: a failing `onEvent` and a failing `inbox.get` each nak with `NAK_DELAY_MS`. Record the delay separately in the stub (for example a `nakDelays` array) so existing `actions` assertions keep passing unchanged.
  - `config.test.ts`: the SMTP defaults apply, and an invalid `SMTP_PORT` fails with the variable named.
- **README**:
  - Status note: email notifications are sent through SMTP (Mailpit locally).
  - "Events", "How the notification service consumes": replace the email "only logs events" sentence with what the email handler sends (same four types as in-app), that a failed send is retried every 5 s for now (bounded retries arrive with BE-05-05), and that a crash after sending can send the email again with the same `Message-ID`.
  - "Install and run": after the payment processor table, add a short paragraph or table for `SMTP_HOST`, `SMTP_PORT` and `SMTP_FROM` with their defaults, noting they point at Mailpit, that no auth or TLS is used, and that `notification` starts and stays ready without Mailpit (emails wait until it is back).
  - "Local infrastructure": next to the existing "Mailpit keeps emails in memory" sentence, say that emails sent by `notification` appear in the Mailpit web UI at http://localhost:8025.
- **Roadmap**: link this doc from the BE-05-04 row. Set it to `in-progress` when starting and `done` when finished.

## Preserve

- The handler's decode, term, dedupe, marker and ack flow and its log lines from BE-05-01 to BE-05-03; only the nak gains a delay.
- In-app behavior, the notification HTTP API and its OpenAPI document.
- Readiness checks (`nats`, `consumers`, `storage`) and the startup failure path.
- The consumer definitions: no `ack_wait`, `max_deliver`, `backoff` or filter changes.
- The shared library, and the payment and auth services.
- `compose.yaml` and `pnpm-workspace.yaml` (nodemailer needs no `allowBuilds` entry).

## Excluded

- Bounded retries, `backoff`, `max_deliver`, retry env vars (BE-05-05) and the DLQ with inspect and replay (BE-05-06).
- An SMTP readiness check.
- SMTP auth, TLS, connection pooling and a production mail provider.
- Per-user email preferences or unsubscribe links.
- Changing in-app wording or the event catalogue.

## Likely Files To Touch

- `services/notification/src/email/` (new)
- `services/notification/src/consumer/consumer.handler.ts`, `consumer.handler.test.ts`
- `services/notification/src/config/config.ts`, `config.test.ts`
- `services/notification/src/main.ts`
- `services/notification/package.json`, `pnpm-lock.yaml` (`nodemailer` only)
- `.env.example`, `README.md`, `ROADMAP.md`

## Prerequisites

BE-05-03 (in-app notifications, `renderNotification`) is merged to `main` as of commit `5a49dac`.

## Decisions Required Before Implementation

None. The four decisions were settled during intake on 2026-10-19 (see Source Context). The listed defaults stand unless changed in this doc.

## Execution Rules

- No `console.*`. Comments only for non-obvious reasons, such as why send errors are rebuilt without `cause`.
- Never log the recipient address, subject, bodies, `description` or `failureReason`. Do not set nodemailer's `logger` or `debug` options.
- Pin `nodemailer` exactly. If its types do not resolve under `nodenext`, stop and record why in this doc before adding anything else.
- Do not change `tsconfig*.json`, `jest.config.js`, `biome.jsonc` or the shared library.
- Named exports only in each `index.ts`.

## Deliverables

- Email sending for the four notified event types, through SMTP, with text and HTML bodies.
- A delayed nak on handling failures.
- SMTP config, unit tests, and updates to `.env.example`, `README.md` and `ROADMAP.md`.

## Completion Verification

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- All four exit 0 with Docker stopped.
- Manual check against local NATS and Mailpit. Start clean: with the services stopped, run `pnpm infra:reset` and `rm -rf services/payment/data services/notification/data`, then `pnpm infra:up` and `pnpm dev`.
  - Log in as the demo user and create a payment:
    ```sh
    TOKEN=$(curl -s localhost:3001/auth/login -H 'Content-Type: application/json' \
      -d '{"email":"user@example.com","password":"User123!"}' | jq -r .data.accessToken)
    curl -s localhost:3002/payments -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d '{"amount":150000,"currency":"NGN","description":"<b>Order & co</b>"}'
    ```
    Wait until it settles (up to about 10 s, `GATEWAY_TIMEOUT_MS`).
  - `curl -s localhost:8025/api/v1/messages | jq '.messages[] | {Subject, To: [.To[].Address], MessageID}'` lists two emails to `user@example.com`: `Payment received` and `Payment succeeded` (or `Payment failed`), each with a message ID ending in `@payment-simulation.local`. Open one at http://localhost:8025: the HTML shows `<b>Order & co</b>` as literal text, not bold, and the text part is readable.
  - The `notification` lines in the `pnpm dev` output have "email sent" twice and none contain `user@example.com` or `Order & co`.
  - **Outage.** Run `docker compose stop mailpit` from the repo root (this also clears the emails Mailpit holds), create another payment, and watch the log: "event handling failed" for the email channel, with `err.code` `ESOCKET`, repeats about every 5 s per message, not in a tight loop. In-app notifications still arrive (`curl -s localhost:3003/notifications -H "Authorization: Bearer $TOKEN"`), and `curl -i localhost:3003/health/ready` stays `200`. Run `docker compose start mailpit`: within about 5 s of it starting, "email sent" appears for the new payment's emails, the failures stop, and Mailpit lists them.
  - Record the results in the PR.
- `git status --porcelain` lists only files under Likely Files To Touch and this task doc.

## Approval Gates

None.

## Completion Criteria

Every Completion Verification check passes, and the BE-05-04 row in `ROADMAP.md` is `done` and links to this file.

## Follow-ups

- BE-05-05: replace the fixed nak delay with consumer `backoff` and `max_deliver` on the email consumer, with short delays configurable for tests, and decide whether the in-app consumer keeps the fixed delay.
- BE-05-06: on the last attempt, publish to the DLQ instead of nak'ing; `EmailSendError.code` is the reason to record.
- Production mail: SMTP auth, TLS and pooling if the project ever sends real email.
