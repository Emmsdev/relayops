# RelayOps

A NestJS service that delivers signed webhooks in the background. Producers submit an event once, then follow its delivery status and attempt history through a REST API.

[![CI](https://github.com/Emmsdev/relayops/actions/workflows/ci.yml/badge.svg)](https://github.com/Emmsdev/relayops/actions/workflows/ci.yml)

## Run the demo

Requires Docker Compose and Node.js 22+. The demo receiver verifies the HMAC and deliberately fails the first attempt.

```sh
cp .env.example .env
docker compose up -d --build --wait
npm run demo
```

Expected output

```text
Accepted <event-id>. Duplicate returned the same ID.
Verified signed delivery and retry: 503 → 204.
```

Open the [delivery console](http://127.0.0.1:3000/console/) and connect with the demo workspace key from `.env`. To try recovery, open **Send a webhook** and queue the prefilled `demo.recover` event. Use **Refresh** to see its first attempt end with HTTP 422, then select **Replay failed event** and refresh again to see the new cycle delivered. The original failure stays in the history. The console keeps the workspace key in page memory.

Open [Swagger UI](http://127.0.0.1:3000/docs) to send requests with the demo bearer key from `.env`. The OpenAPI document is available at `/docs-json`. Run `docker compose logs worker` to see the attempt outcomes and `docker compose down` to stop the services. The database volume persists between runs.

## How it works

```mermaid
flowchart LR
    Client -->|POST event| API[NestJS REST API]
    Client -->|GET status| API
    API -->|Insert or retrieve| DB[(PostgreSQL)]
    DB -->|Claim a due event| Worker[NestJS worker]
    Worker -->|Signed HTTP POST| Receiver[Configured receiver]
    Receiver -->|HTTP status| Worker
    Worker -->|Record attempt and transition| DB
```

- **Accept.** The API validates the workspace bearer key, destination alias and JSON body. A unique constraint on `(workspace, idempotency_key)` deduplicates concurrent submissions. The same key and equivalent JSON object return the same event ID and acceptance timestamp. Different data under the same key returns HTTP 409.
- **Claim.** A worker claims a due row with `FOR UPDATE SKIP LOCKED`, increments the attempt number and records the attempt in a short transaction. Multiple worker processes can claim different events. [PostgreSQL locking clauses](https://www.postgresql.org/docs/14/sql-select.html#SQL-FOR-UPDATE-SHARE)
- **Deliver.** The worker performs the HTTP call outside the transaction with a five-second timeout. Network errors, HTTP 408, 429 and 5xx trigger exponential backoff with jitter. A 2xx response succeeds. Other responses, including redirects, are terminal. After five unsuccessful attempts, the event enters the `dead` state.
- **Recover.** A 30-second lease makes a job claimable again after a worker stops mid-attempt. The next worker records the expired lease and starts a fresh attempt. Completion checks both the attempt number and the lease, so a late worker cannot overwrite newer state.
- **Deduplicate at the receiver.** Delivery has at-least-once semantics within the retry budget. A worker can stop after the receiver accepted an event and before PostgreSQL records success. The receiver should use the stable event UUID from `Idempotency-Key` to deduplicate its own side effects.

PostgreSQL holds the queue and attempt history in the same database. This lets the service persist each transition atomically and run with a single stateful dependency.

## API

| Method | Path | Result |
| --- | --- | --- |
| POST | `/v1/workspaces/{workspace}/events` | Accepts `{ type, destination, payload }` with a required `Idempotency-Key`. Returns HTTP 202 with `id`, `createdAt` and `statusUrl`. |
| GET | `/v1/workspaces/{workspace}/events` | Lists events newest first. Supports `state`, `limit` and a `cursor` from the previous page. |
| POST | `/v1/workspaces/{workspace}/events/{id}/replay` | Queues a new delivery cycle for a dead event and returns HTTP 202. Repeating the call for the same source returns the same cycle. |
| GET | `/v1/workspaces/{workspace}/events/{id}` | Returns event state and attempt history scoped to the authenticated workspace. |
| GET | `/health/live` | Confirms the HTTP process is responding. |
| GET | `/health/ready` | Confirms PostgreSQL is reachable and the event tables exist. |

Event endpoints require `Authorization: Bearer <workspace-key>`. The API accepts JSON request bodies up to 64 KiB. Payloads must be JSON objects with a maximum nesting depth of 32. Send identifiers and integers outside JavaScript’s safe integer range as strings. Errors use `application/problem+json`.

A replay has its own API ID and attempt history, linked to the failed cycle. Every cycle sends the original event ID, creation time and payload to the receiver, which can deduplicate processing across replays.

Each delivery includes `X-Relay-Event-Id`, `X-Relay-Timestamp` and `X-Relay-Signature`. To verify the signature, compute HMAC-SHA256 over the timestamp, a period and the exact raw body bytes. Compare the digest in constant time to the hex after `v1=` and enforce a freshness window. The demo receiver shows this flow.

## Development

Use an existing local PostgreSQL instance and a dedicated database. For native execution, point `DATABASE_URL` at that database and replace `http://receiver:4000/webhooks` in `.env` with `http://127.0.0.1:4000/webhooks`.

```sh
npm ci
npm run build
npm run migrate
```

Run `npm start`, `npm run worker` and `npm run demo -- receiver` in separate terminals, then run `npm run demo`. Migrations are versioned, checksummed and serialized by an advisory lock. When upgrading to replay support, run the migration and upgrade all worker instances before using the new API. The replay migration adds columns and indexes while preserving existing events and attempts.

The integration suite uses a real PostgreSQL instance and a local HTTP receiver. It creates and cleans up its own randomly named schema in the database provided.

```sh
npm run typecheck
TEST_DATABASE_URL=postgresql://relayops:relayops@127.0.0.1:5432/relayops_test npm test
```

The GitHub Actions workflow runs the typecheck, integration suite, build and Docker Compose demo.

## Deployment boundaries

`RELAY_WORKSPACES` is operator-managed configuration shared by API and worker processes. API clients can select configured aliases only. Destinations use HTTPS by default and the worker refuses redirects. Use distinct high-entropy API keys and signing secrets, and enable `RELAY_ALLOW_HTTP=1` only for a local demo. The Compose stack binds the API to loopback and uses example credentials.

The initial scope is one webhook destination per event, one in-flight send per worker process and bounded retries. A public deployment needs a retention policy, traffic quotas and alerting for queue growth and dead events. A receiver controls downstream deduplication.
