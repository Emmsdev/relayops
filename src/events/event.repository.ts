import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database } from '../database';
import { ClaimedEvent, DeliveryOutcome, EventInput, EventState, LEASE_MS, MAX_ATTEMPTS } from './event.contract';

interface EventDetail {
  id: string;
  type: string;
  destination: string;
  state: EventState;
  attemptCount: number;
  createdAt: Date;
  finishedAt: Date | null;
  attempts: Array<{
    number: number;
    startedAt: string;
    finishedAt: string | null;
    outcome: DeliveryOutcome['kind'] | 'lease_expired' | null;
    httpStatus: number | null;
  }>;
}

type Acceptance = { id: string; createdAt: Date };
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

  async find(workspace: string, id: string) {
    const { rows } = await this.db.pool.query<EventDetail>(`
      SELECT e.id, e.event_type AS type, e.destination, e.state,
             e.attempt_count AS "attemptCount", e.created_at AS "createdAt",
             e.finished_at AS "finishedAt",
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
        SELECT id, workspace, event_type AS type, destination, payload, state,
               attempt_count AS attempt, created_at AS "createdAt"
        FROM relay_events
        WHERE state IN ('queued', 'sending') AND next_run_at <= statement_timestamp()
        ORDER BY next_run_at, id
        FOR UPDATE SKIP LOCKED
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
