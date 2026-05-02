-- COL-3.5.6: durable per-task planning gate artifacts.

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_state_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_state_check CHECK (state IN (
    'created', 'ready', 'claimed', 'plan_proposed', 'plan_review',
    'in_progress', 'review_requested', 'changes_requested', 'merge_ready',
    'merged', 'closed', 'blocked', 'conflict', 'failed', 'canceled',
    'pending_sync'
  ));

ALTER TABLE tasks
  ADD COLUMN developer_plan_envelope jsonb,
  ADD COLUMN developer_plan_hash text,
  ADD COLUMN plan_review_envelope jsonb,
  ADD COLUMN plan_review_hash text,
  ADD COLUMN plan_review_result text;

CREATE INDEX tasks_plan_gate_idx
  ON tasks (state, plan_review_result)
  WHERE state IN ('plan_proposed', 'plan_review', 'in_progress');
