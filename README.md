# payment-be

A payment processing simulation built as Node.js microservices. Users create payments, a simulated gateway processes them in the background, and a notification service tells users the result in the app and by email.

> **Status:** in progress. The monorepo scaffold is in place; no service features are implemented yet. Progress is tracked in [ROADMAP.md](ROADMAP.md). Setup, run, API and testing instructions will be added as each part lands.

## The brief

Build a Node.js microservice that simulates payment processing, exposing a RESTful API to create payments, retrieve them by ID, and update their status. The brief asks for:

- An Express server with create (POST), retrieve by ID (GET) and update status (PUT/PATCH) endpoints
- Simulated payment processing with asynchronous operations
- In-memory or JSON-file persistence
- Proper error responses, with an emphasis on error handling and logging
- Unit tests (Mocha/Chai or Jest) and API documentation (Swagger or Markdown)
- A Git repository with a README covering setup, API details and testing

## Architecture

| Component | Responsibility |
|---|---|
| `services/auth` | Users, registration, login, JWT issuing. Seeds one admin and one normal user |
| `services/payment` | Payment API, status rules, simulated gateway and background processor. Publishes payment events |
| `services/notification` | Consumes payment events. Stores in-app notifications and sends email, with retries and a dead-letter queue |
| `libs/shared` | Event contracts, NATS client wrapper, logger, error model, config, auth middleware |

Services communicate through NATS JetStream. Each service owns its data, stored in memory or in a JSON file depending on configuration.

### Payment flow

1. A logged-in user calls `POST /payments`. The payment is saved as `pending` and a `payment.created` event is published.
2. The background processor sends the payment to a simulated gateway, which succeeds or fails after a random delay.
3. The payment service records the result and publishes `payment.succeeded` or `payment.failed`.
4. The notification service creates an in-app notification and sends an email. Failed emails are retried with backoff, and emails that still fail are moved to a dead-letter queue for inspection and replay.

## Tech stack

Node.js 24, TypeScript, Express, NATS JetStream, Zod, pino, Jest and supertest, Swagger UI, Biome (Ultracite), pnpm workspaces, docker-compose for local infrastructure (NATS and Mailpit).

## Getting started

### Prerequisites

- Node.js 24 (`.nvmrc` is included, so `nvm use` works)
- pnpm. Run `corepack enable`, or install pnpm on its own. pnpm switches to the version pinned in `package.json`.

### Install and run

```sh
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` starts all three services in watch mode. To run the compiled build instead:

```sh
pnpm build
pnpm start
```

Starting NATS and the mail catcher, and the seeded demo accounts, will be added with the milestones that introduce them.

### Checks

```sh
pnpm check       # lint and format (Biome via Ultracite)
pnpm fix         # apply safe fixes
pnpm typecheck   # TypeScript, including tests
pnpm test        # Jest
```

## API

Not available yet. Each service will serve Swagger UI, and endpoints will be summarised here.

## Testing

Run `pnpm test` from the repo root. To run one package, pass its path, for example `pnpm test -- services/auth`. Tests sit next to the code they cover as `*.test.ts`. This section will grow to cover API and cross-service integration tests.

## Project docs

- [ROADMAP.md](ROADMAP.md): scope, decisions and status
- [tasks/](tasks/): task docs for individual roadmap items
