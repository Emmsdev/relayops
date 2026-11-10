CREATE TABLE relay_events (
    id uuid PRIMARY KEY,
    workspace text NOT NULL,
    idempotency_key text NOT NULL,
    event_type text NOT NULL,
    destination text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'sending', 'delivered', 'dead')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    next_run_at timestamptz DEFAULT clock_timestamp(),
    finished_at timestamptz,
    UNIQUE (workspace, idempotency_key),
    CHECK (
        (state IN ('queued', 'sending') AND next_run_at IS NOT NULL AND finished_at IS NULL)
        OR
        (state IN ('delivered', 'dead') AND next_run_at IS NULL AND finished_at IS NOT NULL)
    )
);

CREATE INDEX relay_events_runnable ON relay_events (next_run_at, id)
    WHERE state IN ('queued', 'sending');

CREATE TABLE relay_attempts (
    event_id uuid NOT NULL REFERENCES relay_events (id),
    number integer NOT NULL CHECK (number BETWEEN 1 AND 5),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    outcome text CHECK (outcome IN (
        'delivered', 'retryable_http', 'permanent_http', 'timeout',
        'network_error', 'lease_expired', 'destination_missing'
    )),
    http_status smallint CHECK (http_status BETWEEN 100 AND 599),
    PRIMARY KEY (event_id, number),
    CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
