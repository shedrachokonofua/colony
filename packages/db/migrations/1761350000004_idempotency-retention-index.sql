-- Time-based index for `DELETE FROM idempotency_keys WHERE created_at < $cutoff` retention jobs.
-- Retention: recommend deleting rows older than 7 days; no app TTL on read in COL-0.9.

CREATE INDEX idempotency_keys_created_at_idx
  ON idempotency_keys (created_at);
