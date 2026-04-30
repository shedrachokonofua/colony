-- Per-task scoped provider access token metadata.
--
-- The token secret is deliberately not stored here. The supervisor stores only
-- the provider project/token identifiers needed to revoke the token after the
-- task is done or during orphan cleanup.

ALTER TABLE tasks
  ADD COLUMN agent_token_project_id text,
  ADD COLUMN agent_token_id text,
  ADD COLUMN agent_token_expires_at timestamptz,
  ADD COLUMN agent_token_revoked_at timestamptz;

CREATE INDEX tasks_active_agent_token_idx
  ON tasks (agent_token_project_id, agent_token_id)
  WHERE agent_token_id IS NOT NULL
    AND agent_token_project_id IS NOT NULL
    AND agent_token_revoked_at IS NULL;

CREATE INDEX tasks_terminal_agent_token_idx
  ON tasks (state, updated_at)
  WHERE agent_token_id IS NOT NULL
    AND agent_token_revoked_at IS NULL;
