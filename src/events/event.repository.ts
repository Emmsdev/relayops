import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database } from '../database';
import { ClaimedEvent, DeliveryOutcome, EventInput, EventState, LEASE_MS, MAX_ATTEMPTS } from './event.contract';

interface EventSummary {
  id: string;
  type: string;
  destination: string;
  state: EventState;
  attemptCount: number;
  createdAt: Date;
  finishedAt: Date | null;
  replayOf: string | null;
  replayedBy: string | null;
}

interface EventDetail extends EventSummary {
  attempts: Array<{
    number: number;
    startedAt: string;
    finishedAt: string | null;
    outcome: DeliveryOutcome['kind'] | 'lease_expired' | null;
    httpStatus: number | null;
  }>;
}

type Acceptance = { id: string; createdAt: Date };
const summaryFields = `
  e.id, e.event_type AS type, e.destination, e.state, e.attempt_count AS "attemptCount",
  e.created_at AS "createdAt", e.finished_at AS "finishedAt", e.replay_of AS "replayOf",
  (SELECT child.id FROM relay_events child
   WHERE child.workspace = e.workspace AND child.replay_of = e.id) AS "replayedBy"
`;

type Candidate = ClaimedEvent & { state: 'queued' | 'sending' };

@Injectable()
export class EventRepository {
  constructor(private readonly db: Database) {}

  async enqueue(workspace: string, key: string, input: EventInput) {
    const values = [workspace, key, input.type, input.destination, JSON.stringify(input.payload)];
    const inserted = await this.db.pool.query<Acceptance>(`
      INSERT INTO relay_events (workspace, idempotency_key, event_type, destination, payload, id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (workspace, idempotency_key) DO NOTHING
      RETURNING id, created_at AS "createdAt"
    `, [...values, randomUUID()]);
    const created = inserted.rows[0];
    if (created) return created;

    // A fresh statement sees the committed winner after ON CONFLICT waited.
    const existing = await this.db.pool.query<Acceptance>(`
      SELECT id, created_at AS "createdAt"
      FROM relay_events
      WHERE workspace = $1 AND idempotency_key = $2
        AND event_type = $3 AND destination = $4 AND payload = $5::jsonb
    `, values);
    return existing.rows[0];
  }

  async list(workspace: string, state: EventState | undefined, cursor: string | undefined, limit: number) {
    const { rows } = await this.db.pool.query<EventSummary>(`
      SELECT ${summaryFields}
      FROM relay_events e
      WHERE e.workspace = $1 AND ($2::text IS NULL OR e.state = $2)
        AND ($3::uuid IS NULL OR (e.created_at, e.id) < (
          SELECT anchor.created_at, anchor.id FROM relay_events anchor
          WHERE anchor.workspace = $1 AND anchor.id = $3
        ))
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $4
    `, [workspace, state ?? null, cursor ?? null, limit + 1]);
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items.at(-1)?.id ?? null : null };
  }

  async replay(workspace: string, id: string) {
    const inserted = await this.db.pool.query<Acceptance>(`
      INSERT INTO relay_events (
        id, workspace, idempotency_key, event_type, destination, payload, replay_of, delivery_id
      )
      SELECT $3, e.workspace, '@replay:' || e.id, e.event_type, e.destination, e.payload,
             e.id, COALESCE(e.delivery_id, e.id)
      FROM relay_events e
      WHERE e.workspace = $1 AND e.id = $2 AND e.state = 'dead'
      ON CONFLICT (replay_of) DO NOTHING
      RETURNING id, created_at AS "createdAt"
    `, [workspace, id, randomUUID()]);
    if (inserted.rows[0]) return { status: 'accepted' as const, event: inserted.rows[0] };

    const existing = await this.db.pool.query<{ id: string | null; createdAt: Date | null }>(`
      SELECT child.id, child.created_at AS "createdAt"
      FROM relay_events e
      LEFT JOIN relay_events child ON child.workspace = e.workspace AND child.replay_of = e.id
      WHERE e.workspace = $1 AND e.id = $2
    `, [workspace, id]);
    const source = existing.rows[0];
    if (!source) return { status: 'missing' as const };
    if (source.id && source.createdAt) {
      return { status: 'accepted' as const, event: { id: source.id, createdAt: source.createdAt } };
    }
    return { status: 'unavailable' as const };
  }

  async find(workspace: string, id: string) {
    const { rows } = await this.db.pool.query<EventDetail>(`
      SELECT ${summaryFields},
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'number', a.number, 'startedAt', a.started_at,
                 'finishedAt', a.finished_at, 'outcome', a.outcome,
                 'httpStatus', a.http_status
               ) ORDER BY a.number)
               FROM relay_attempts a WHERE a.event_id = e.id
             ), '[]'::jsonb) AS attempts
      FROM relay_events e WHERE e.workspace = $1 AND e.id = $2
    `, [workspace, id]);
    return rows[0];
  }

  claim(leaseMs = LEASE_MS): Promise<ClaimedEvent | undefined> {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<Candidate>(`
        SELECT e.id, COALESCE(e.delivery_id, e.id) AS "deliveryId", e.workspace,
               e.event_type AS type, e.destination, e.payload, e.state, e.attempt_count AS attempt,
               COALESCE(original.created_at, e.created_at) AS "createdAt"
        FROM relay_events e
        LEFT JOIN relay_events original ON original.workspace = e.workspace AND original.id = e.delivery_id
        WHERE e.state IN ('queued', 'sending') AND e.next_run_at <= statement_timestamp()
        ORDER BY e.next_run_at, e.id
        FOR UPDATE OF e SKIP LOCKED
        LIMIT 1
      `);
      const event = rows[0];
      if (!event) return;

      if (event.state === 'sending') {
        await client.query(`
          UPDATE relay_attempts SET finished_at = clock_timestamp(), outcome = 'lease_expired'
          WHERE event_id = $1 AND number = $2
        `, [event.id, event.attempt]);

        if (event.attempt === MAX_ATTEMPTS) {
          await client.query(`
            UPDATE relay_events SET state = 'dead', next_run_at = NULL,
              finished_at = clock_timestamp() WHERE id = $1
          `, [event.id]);
          return;
        }
      }

      const attempt = event.attempt + 1;
      await client.query(`
        UPDATE relay_events
        SET state = 'sending', attempt_count = $2,
            next_run_at = clock_timestamp() + $3::integer * interval '1 millisecond'
        WHERE id = $1
      `, [event.id, attempt, leaseMs]);
      await client.query(
        'INSERT INTO relay_attempts (event_id, number) VALUES ($1, $2)',
        [event.id, attempt],
      );
      return { ...event, attempt };
    });
  }

  finish(event: ClaimedEvent, outcome: DeliveryOutcome, retryDelayMs: number): Promise<EventState | undefined> {
    const retryable = outcome.kind === 'retryable_http' || outcome.kind === 'timeout' ||
      outcome.kind === 'network_error';
    const state = outcome.kind === 'delivered'
      ? 'delivered'
      : retryable && event.attempt < MAX_ATTEMPTS ? 'queued' : 'dead';

    return this.db.transaction(async (client) => {
      // The attempt number fences out stale workers after lease expiry.
      const result = await client.query(`
        UPDATE relay_events
        SET state = $3,
            next_run_at = CASE WHEN $3 = 'queued'
              THEN clock_timestamp() + $4::integer * interval '1 millisecond' END,
            finished_at = CASE WHEN $3 <> 'queued' THEN clock_timestamp() END
        WHERE id = $1 AND attempt_count = $2 AND state = 'sending'
          AND next_run_at > clock_timestamp()
      `, [event.id, event.attempt, state, retryDelayMs]);
      if (!result.rowCount) return;

      await client.query(`
        UPDATE relay_attempts SET finished_at = clock_timestamp(), outcome = $3, http_status = $4
        WHERE event_id = $1 AND number = $2
      `, [event.id, event.attempt, outcome.kind, outcome.status ?? null]);
      return state;
    });
  }
}
