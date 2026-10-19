# Architecture

How the payment simulation is put together: the services and what each one owns, how a payment moves through them, and what happens when something fails. The [README](../README.md) has setup, the API reference and the event catalogue; this document explains the design behind them.

## Services and boundaries

```mermaid
flowchart LR
  client([Client])

  subgraph auth["auth :3001"]
    authApi[Register / login API]
    users[(users.json)]
    authApi --> users
  end

  subgraph payment["payment :3002"]
    payApi[Payment API]
    processor[Background processor]
    gateway[Simulated gateway]
    relay[Outbox relay]
    payments[("payments.json<br/>with outbox")]
    payApi --> payments
    processor --> payments
    processor --> gateway
    relay --> payments
  end

  subgraph notification["notification :3003"]
    inapp[In-app consumer]
    email[Email consumer]
    notifApi[Notifications and DLQ API]
    inbox[(inbox.json)]
    notifs[(notifications.json)]
    inapp --> inbox
    inapp --> notifs
    email --> inbox
    notifApi --> notifs
  end

  subgraph nats["NATS JetStream"]
    PAYMENTS[["PAYMENTS stream<br/>payment.>"]]
    DLQ[["DLQ stream<br/>dlq.>"]]
  end

  mailpit[(Mailpit SMTP)]

  client -- "login → JWT" --> authApi
  client -- "Bearer JWT" --> payApi
  client -- "Bearer JWT" --> notifApi
  relay -- "publish" --> PAYMENTS
  PAYMENTS -- "notification-inapp" --> inapp
  PAYMENTS -- "notification-email" --> email
  email -- "send" --> mailpit
  email -- "dead-letter" --> DLQ
  notifApi -- "inspect / replay" --> DLQ
  notifApi -- replay --> mailpit
```

| Service | Owns | Talks to |
|---|---|---|
| `auth` | Users and their bcrypt password hashes; issues HS256 JWTs with `sub`, `email` and `role` | Nothing at runtime |
| `payment` | Payments, their status rules and the outbox of events not yet published | NATS (publishes to `PAYMENTS`) |
| `notification` | In-app notifications and, per channel, which events it has already handled (the inbox) | NATS (consumes `PAYMENTS`, publishes to and reads `DLQ`), SMTP |
| `libs/shared` | No data. Config loading, event contracts, the NATS wrapper, logger, error model, response envelope, repository adapters and auth middleware | — |

The rules that keep the boundaries real:

- **No shared code between services, and no shared storage.** Each service reads and writes only its own repository (in memory or a JSON file). Anything two services need, such as an event schema, lives in `libs/shared`.
- **Events are the only runtime link.** `payment` never calls `notification`, and nobody calls `auth` after login: `payment` and `notification` verify the JWT themselves with the shared secret.
- **Events carry what consumers need.** Every payment event includes the owner's `userId` and email, so `notification` never has to look a user up.
- **Money is an integer in minor units with an ISO 4217 code**, everywhere, including events.

## How a payment moves through the system

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant A as auth
  participant P as payment API
  participant S as payments store
  participant W as processor
  participant G as gateway
  participant R as outbox relay
  participant J as JetStream PAYMENTS
  participant N as notification
  participant M as Mailpit

  U->>A: POST /auth/login
  A-->>U: accessToken (JWT)
  U->>P: POST /payments (Bearer JWT, x-request-id)
  P->>S: insert pending + payment.created in outbox
  P-->>U: 201 pending
  P->>R: kick
  R->>J: publish payment.created (Nats-Msg-Id = eventId)
  R->>S: remove sent event from outbox
  W->>S: claim: pending → processing (+ payment.processing)
  W->>G: charge(paymentId)
  G-->>W: approved or declined after a random delay (or no answer: timeout)
  W->>S: processing → succeeded | failed (+ event)
  R->>J: publish payment.processing, then the result
  J-->>N: deliver to notification-inapp and notification-email
  Note over N: both channels skip payment.processing
  N->>N: in-app: store notification
  N->>M: email: send, Message-ID = eventId
  U->>N: GET /notifications
```

- A status change and its event are written together in one compare-and-set update, so neither can exist without the other. The relay publishes afterwards.
- Each outbox entry stores a correlation ID, sent in the `x-correlation-id` header. Events from the processor carry the ID of the `POST /payments` request, so one ID can be followed from the HTTP request through the processor to both notification channels. Events from an admin `PATCH` carry that request's own ID.
- An admin can cancel a `pending` payment, or settle a `processing` one, with `PATCH /payments/:id/status`. That change goes through the same compare-and-set update as the processor's, so whichever is saved first wins: the admin gets `409`, or the processor drops its result and logs `payment already settled`.

The event types and their payload are listed in the README under [Events](../README.md#events).

## Failure handling

```mermaid
flowchart TB
  subgraph pub["payment: publishing"]
    change[Status change] --> outbox[(Outbox on the payment)]
    outbox --> relay{Relay publish}
    relay -- ok --> remove[Remove from outbox]
    relay -- "fails" --> wait[Stop for this payment,<br/>retry on the next sweep]
    wait --> relay
  end

  subgraph con["notification: consuming, per channel"]
    deliver[Delivery from PAYMENTS] --> valid{Valid event?}
    valid -- no --> term[term: never redelivered]
    valid -- yes --> seen{In this channel's inbox?}
    seen -- yes --> skip[Ack, log duplicate skipped]
    seen -- no --> work[Store notification / send email]
    work -- ok --> mark[Record in inbox, ack]
    work -- "in-app store fails" --> nak5[nak, retry in 5 s] --> deliver
  end

  subgraph mail["email failures"]
    work -- "send fails" --> kind{Permanent?<br/>5xx, or envelope error with no reply}
    kind -- "no, attempts left" --> nak[nak with the next delay] --> deliver
    kind -- "yes, or attempts used up" --> dlq[["Publish to DLQ, record, ack"]]
    dlq --> admin[Admin lists and replays]
    admin -- "SMTP accepts" --> sent[Email sent, entry deleted]
    admin -- "SMTP refuses" --> keep[502, entry kept]
  end

  remove -. "JetStream" .-> deliver
```

### Publishing: the outbox

`payment` never publishes inside a request. Each event is saved in the payment's outbox in the same write as the status change, and a relay publishes it afterwards. A NATS outage therefore never fails a request or loses an event: the event waits for the next sweep. One payment's events go out in order, and delivery is at least once, with JetStream's duplicate window catching quick repeats. The README's [Events](../README.md#events) section has the exact rules. Detail: [BE-04-02](../tasks/BE-04-02-payment-event-outbox.md).

### Consuming: at-least-once delivery and the inbox

JetStream may deliver a message more than once, so each notification channel keeps an inbox keyed by `eventId` + channel and skips an event it has already handled. Keying by channel means an email retry is never hidden by the in-app notification having been stored already. An event is recorded only after its work succeeds, so a crash between the work and the record repeats the work: in-app notifications use the `eventId` as their ID, so that still leaves one notification, but the email is sent again (with the same `Message-ID`). A message that is not valid JSON or fails the schema is terminated, so it never loops. The README's [Events](../README.md#events) section has the exact rules. Detail: [BE-05-02](../tasks/BE-05-02-idempotent-event-handling.md).

### Email retries and the dead-letter queue

JetStream has no built-in dead-letter stream, so the email handler runs its own. A failed send is nak'd with a delay from `EMAIL_RETRY_DELAYS_MS`, up to `EMAIL_MAX_ATTEMPTS` deliveries. A permanent rejection (a 5xx reply, or an envelope error with no reply) is not retried. When attempts run out, or on a permanent rejection, the handler publishes the event to the `DLQ` stream with the reason (`exhausted` or `rejected`) and the last SMTP error, records the event as handled and acks it, so JetStream stops redelivering. Admins list, read and replay entries through `/admin/dlq`. A replay sends the email inside the request and deletes the entry only if the send succeeds. The in-app channel has no limit: it retries every 5 seconds until storing works. Detail: [BE-05-05](../tasks/BE-05-05-email-retries-dlq.md).

### Concurrent updates

Every repository update is compare-and-set on a `version` field. The processor and an admin `PATCH` can race for the same payment. A write that loses re-reads the payment and re-checks the transition, up to 3 attempts in total; if the payment has moved on, the admin gets `409` and the processor logs `payment already settled`. The JSON-file adapter writes through a temporary file and a rename, with one writer per file, so a crash never leaves a half-written file. Detail: [BE-01-07](../tasks/BE-01-07-repository-interface.md), [BE-01-08](../tasks/BE-01-08-json-file-adapter.md).

### Readiness and graceful shutdown

`/health/ready` checks each service's real dependencies: storage for all three, the NATS connection for `payment` and `notification`, and the consumer loops for `notification`. It returns `503` while any of them fails, for example during a NATS outage. On SIGTERM or SIGINT a service stops accepting connections, lets in-flight requests finish, then stops in order: the processor and the outbox relay (`payment`), the consumers (`notification`), the NATS connection (drained, then force-closed if the drain fails), storage, and the SMTP transport (`notification`). A 10-second timer force-exits if shutdown hangs. Payments left `processing` by a shutdown are resumed on the next start. Detail: [BE-01-04](../tasks/BE-01-04-service-skeleton.md), [BE-03-05](../tasks/BE-03-05-payment-processor.md).
