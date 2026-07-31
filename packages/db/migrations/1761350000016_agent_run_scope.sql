-- COL-3.x: allow scope-level architect and decomposition reviewer runs.

ALTER TABLE agent_runs
  ADD COLUMN scope_id text REFERENCES scopes (id) ON DELETE RESTRICT;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_target;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_target CHECK (
    (scope_id IS NOT NULL) OR
    (task_id IS NOT NULL) OR
    (review_id IS NOT NULL)
  );

CREATE INDEX agent_runs_scope_idx
  ON agent_runs (scope_id, started_at DESC)
  WHERE scope_id IS NOT NULL;
