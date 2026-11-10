ALTER TABLE relay_events
    ADD COLUMN replay_of uuid REFERENCES relay_events (id),
    ADD COLUMN delivery_id uuid REFERENCES relay_events (id),
    ADD CONSTRAINT relay_events_replay_identity
        CHECK ((replay_of IS NULL) = (delivery_id IS NULL));

CREATE UNIQUE INDEX relay_events_replay_of ON relay_events (replay_of);
CREATE INDEX relay_events_workspace_history ON relay_events (workspace, created_at DESC, id DESC);
