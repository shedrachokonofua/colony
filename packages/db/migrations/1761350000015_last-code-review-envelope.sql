-- COL-3.5.7: persist latest code-review envelope for re-planning feedback.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS last_code_review_envelope jsonb,
  ADD COLUMN IF NOT EXISTS last_code_review_hash text;
