-- Phase 3 spec/DAG decomposition proposals (COL-3.0a).
--
-- Architect output is persisted before it is approved and before any task rows
-- are committed. The proposal row is the stable artifact the Reviewer and
-- human approval steps refer to by hash.

CREATE TABLE decomposition_proposals (
  id                     text PRIMARY KEY,
  scope_id               text NOT NULL REFERENCES scopes (id) ON DELETE RESTRICT,
  scope_state_version    integer NOT NULL,
  scope_brief_version    text NOT NULL,
  status                 text NOT NULL CHECK (status IN (
                           'proposed', 'review_approved',
                           'changes_requested', 'human_approved',
                           'committed'
                         )),
  proposed_tasks         jsonb NOT NULL,
  proposed_dependencies  jsonb NOT NULL,
  target_project_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  assumptions            text[] NOT NULL DEFAULT '{}',
  open_questions         text[] NOT NULL DEFAULT '{}',
  packet_hash            text NOT NULL,
  envelope_hash          text NOT NULL,
  envelope               jsonb NOT NULL,
  reviewer               text,
  reviewer_result        text CHECK (reviewer_result IN (
                           'approved', 'changes_requested',
                           'blocked', 'escalate'
                         )),
  reviewed_at            timestamptz,
  human_approved_by      text,
  human_approved_at      timestamptz,
  committed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decomposition_proposals_scope_envelope_unique
    UNIQUE (scope_id, envelope_hash)
);

CREATE INDEX decomposition_proposals_scope_status_idx
  ON decomposition_proposals (scope_id, status, created_at DESC);

GRANT SELECT ON decomposition_proposals TO colony_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON decomposition_proposals TO colony_writer;
