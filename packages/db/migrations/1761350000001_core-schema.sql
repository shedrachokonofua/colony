-- Initial colony schema (COL-0.6).
--
-- Mirrors the entities in packages/domain/src/entities.ts. Enum-like columns
-- are stored as text with CHECK constraints rather than Postgres ENUM types,
-- so we can add states without an ALTER TYPE roundtrip and so the column type
-- stays a plain text on the wire.
--
-- ID columns are text. Domain types (packages/domain/src/ids.ts) are branded
-- strings; the application supplies the IDs. Scopes / tasks have format
-- constraints; other entities accept any non-empty string and the app
-- generates UUIDs or similar.
--
-- Audit-log insert-only enforcement is in the next migration so the table
-- exists before the GRANT/REVOKE runs.

-- ---------------------------------------------------------------------------
-- scopes
-- ---------------------------------------------------------------------------
CREATE TABLE scopes (
  id            text PRIMARY KEY CHECK (id ~ '^col-[a-z0-9]{4,}$'),
  title         text NOT NULL,
  description   text NOT NULL,
  state         text NOT NULL CHECK (state IN (
                  'draft', 'decomposition_proposed', 'decomposition_approved',
                  'active', 'scope_review_requested', 'scope_review_approved',
                  'closed', 'blocked', 'conflict', 'canceled'
                )),
  state_version integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scopes_state_idx ON scopes (state);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
CREATE TABLE tasks (
  id                  text PRIMARY KEY CHECK (id ~ '^col-[a-z0-9]{4,}\.[0-9]+$'),
  scope_id            text NOT NULL REFERENCES scopes (id) ON DELETE RESTRICT,
  title               text NOT NULL,
  description         text NOT NULL,
  acceptance_criteria text[] NOT NULL DEFAULT '{}',
  non_goals           text[] NOT NULL DEFAULT '{}',
  state               text NOT NULL CHECK (state IN (
                        'created', 'ready', 'claimed', 'in_progress',
                        'review_requested', 'changes_requested', 'merge_ready',
                        'merged', 'closed', 'blocked', 'conflict', 'failed',
                        'canceled', 'pending_sync'
                      )),
  state_version       integer NOT NULL DEFAULT 0,
  claim_version       integer NOT NULL DEFAULT 0,
  assignee            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- (scope_id, state) backs ready_tasks(scope_id) and per-scope state queries.
CREATE INDEX tasks_scope_state_idx ON tasks (scope_id, state);
-- (state) backs cross-scope readiness scans and metrics.
CREATE INDEX tasks_state_idx ON tasks (state);
-- assignee lookups for "what is this actor doing right now".
CREATE INDEX tasks_assignee_idx ON tasks (assignee) WHERE assignee IS NOT NULL;

-- ---------------------------------------------------------------------------
-- task_dependencies
-- ---------------------------------------------------------------------------
CREATE TABLE task_dependencies (
  id           text PRIMARY KEY,
  from_task_id text NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  to_task_id   text NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  kind         text NOT NULL CHECK (kind IN (
                 'blocks', 'parent_child', 'related',
                 'discovered_from', 'duplicates', 'supersedes'
               )),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_dependencies_no_self_loop CHECK (from_task_id <> to_task_id),
  CONSTRAINT task_dependencies_unique UNIQUE (from_task_id, to_task_id, kind)
);
-- ready_tasks: "tasks with no open blocking deps" walks to_task_id.
CREATE INDEX task_dependencies_to_kind_idx
  ON task_dependencies (to_task_id, kind);
CREATE INDEX task_dependencies_from_kind_idx
  ON task_dependencies (from_task_id, kind);

-- ---------------------------------------------------------------------------
-- artifacts (referenced by reviews, approvals, agent_runs)
-- ---------------------------------------------------------------------------
CREATE TABLE artifacts (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN (
                'issue', 'epic', 'mr', 'pr', 'commit', 'branch',
                'pipeline', 'comment', 'release'
              )),
  scope_id    text REFERENCES scopes (id) ON DELETE RESTRICT,
  task_id     text REFERENCES tasks (id) ON DELETE RESTRICT,
  provider    text NOT NULL,
  provider_id text NOT NULL,
  uri         text NOT NULL,
  hash        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX artifacts_provider_lookup_idx
  ON artifacts (provider, kind, provider_id);
CREATE INDEX artifacts_scope_idx
  ON artifacts (scope_id) WHERE scope_id IS NOT NULL;
CREATE INDEX artifacts_task_idx
  ON artifacts (task_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- assignments
-- ---------------------------------------------------------------------------
CREATE TABLE assignments (
  id          text PRIMARY KEY,
  task_id     text NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  assignee    text NOT NULL,
  role        text NOT NULL CHECK (role IN (
                'human', 'architect', 'supervisor', 'developer', 'reviewer',
                'integrator', 'memory_consolidator'
              )),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
-- "current assignment" is the row where released_at IS NULL.
CREATE INDEX assignments_task_active_idx
  ON assignments (task_id) WHERE released_at IS NULL;
CREATE INDEX assignments_task_history_idx
  ON assignments (task_id, assigned_at DESC);

-- ---------------------------------------------------------------------------
-- gates
-- ---------------------------------------------------------------------------
CREATE TABLE gates (
  id                 text PRIMARY KEY,
  scope_id           text NOT NULL REFERENCES scopes (id) ON DELETE RESTRICT,
  task_id            text REFERENCES tasks (id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN (
                       'spec_dag', 'mr_pr', 'scope_close', 'release_deploy'
                     )),
  status             text NOT NULL CHECK (status IN (
                       'pending', 'open', 'blocked', 'closed'
                     )),
  required_approvals text[] NOT NULL DEFAULT '{}',
  opened_at          timestamptz,
  closed_at          timestamptz
);
CREATE INDEX gates_scope_status_idx ON gates (scope_id, status);
CREATE INDEX gates_task_status_idx
  ON gates (task_id, status) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- reviews
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id            text PRIMARY KEY,
  task_id       text NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  artifact_id   text REFERENCES artifacts (id) ON DELETE RESTRICT,
  reviewer      text NOT NULL,
  result        text CHECK (result IN (
                  'approved', 'changes_requested', 'blocked', 'escalate'
                )),
  envelope_hash text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX reviews_task_idx ON reviews (task_id, requested_at DESC);
CREATE INDEX reviews_open_idx
  ON reviews (task_id) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- approvals
-- ---------------------------------------------------------------------------
CREATE TABLE approvals (
  id                   text PRIMARY KEY,
  artifact_id          text NOT NULL REFERENCES artifacts (id) ON DELETE RESTRICT,
  actor                text NOT NULL,
  commit_sha           text,
  pipeline_id          text,
  approved_at          timestamptz NOT NULL DEFAULT now(),
  invalidated_at       timestamptz,
  invalidation_reason  text
);
-- Active approvals on an artifact (gate evaluation).
CREATE INDEX approvals_artifact_active_idx
  ON approvals (artifact_id) WHERE invalidated_at IS NULL;
CREATE INDEX approvals_artifact_history_idx
  ON approvals (artifact_id, approved_at DESC);
CREATE INDEX approvals_actor_idx ON approvals (actor, approved_at DESC);

-- ---------------------------------------------------------------------------
-- agent_runs
-- ---------------------------------------------------------------------------
CREATE TABLE agent_runs (
  id            text PRIMARY KEY,
  task_id       text REFERENCES tasks (id) ON DELETE RESTRICT,
  review_id     text REFERENCES reviews (id) ON DELETE RESTRICT,
  role          text NOT NULL CHECK (role IN (
                  'human', 'architect', 'supervisor', 'developer', 'reviewer',
                  'integrator', 'memory_consolidator'
                )),
  sandbox_id    text,
  packet_hash   text NOT NULL,
  envelope_hash text,
  status        text NOT NULL CHECK (status IN (
                  'queued', 'running', 'succeeded', 'failed',
                  'canceled', 'envelope_rejected'
                )),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT agent_runs_target CHECK (
    (task_id IS NOT NULL) OR (review_id IS NOT NULL)
  )
);
CREATE INDEX agent_runs_task_idx
  ON agent_runs (task_id, started_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX agent_runs_review_idx
  ON agent_runs (review_id, started_at DESC) WHERE review_id IS NOT NULL;
CREATE INDEX agent_runs_status_idx ON agent_runs (status, started_at DESC);

-- ---------------------------------------------------------------------------
-- events (append-only timeline; not insert-only at the role level — agents
-- and Supervisor activities both write through the writer role)
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id          text PRIMARY KEY,
  scope_id    text REFERENCES scopes (id) ON DELETE RESTRICT,
  task_id     text REFERENCES tasks (id) ON DELETE RESTRICT,
  kind        text NOT NULL,
  actor       text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_scope_idx
  ON events (scope_id, recorded_at DESC) WHERE scope_id IS NOT NULL;
CREATE INDEX events_task_idx
  ON events (task_id, recorded_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX events_kind_idx ON events (kind, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- audit_log (insert-only at the role level — see next migration)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              text PRIMARY KEY,
  scope_id        text REFERENCES scopes (id) ON DELETE RESTRICT,
  task_id         text REFERENCES tasks (id) ON DELETE RESTRICT,
  actor           text NOT NULL,
  action          text NOT NULL,
  capability      text,
  target_kind     text,
  target_id       text,
  previous_state  text,
  new_state       text,
  reason          text,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_scope_idx
  ON audit_log (scope_id, recorded_at DESC) WHERE scope_id IS NOT NULL;
CREATE INDEX audit_log_task_idx
  ON audit_log (task_id, recorded_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX audit_log_actor_idx ON audit_log (actor, recorded_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- provider_mirrors (Colony ID <-> provider ID translation)
-- ---------------------------------------------------------------------------
CREATE TABLE provider_mirrors (
  id                    text PRIMARY KEY,
  colony_id             text NOT NULL,
  entity_kind           text NOT NULL CHECK (entity_kind IN (
                          'scope', 'task', 'mr_pr', 'comment',
                          'branch', 'commit', 'pipeline', 'user'
                        )),
  provider              text NOT NULL,
  provider_id           text NOT NULL,
  source_version        text,
  projected_at          timestamptz,
  freshness_ttl_seconds integer,
  CONSTRAINT provider_mirrors_provider_unique UNIQUE (provider, entity_kind, provider_id)
);
CREATE INDEX provider_mirrors_colony_idx
  ON provider_mirrors (colony_id, entity_kind, provider);

-- ---------------------------------------------------------------------------
-- policies
-- ---------------------------------------------------------------------------
CREATE TABLE policies (
  id                  text PRIMARY KEY,
  scope               text NOT NULL CHECK (scope IN (
                        'global', 'project', 'scope', 'task'
                      )),
  target_id           text,
  version             integer NOT NULL DEFAULT 1,
  protected_paths     text[] NOT NULL DEFAULT '{}',
  security_labels     text[] NOT NULL DEFAULT '{}',
  always_human_review boolean NOT NULL DEFAULT false,
  review_loop_cap     integer NOT NULL DEFAULT 3,
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policies_target_idx
  ON policies (scope, target_id, version DESC);

-- ---------------------------------------------------------------------------
-- capability_grants
-- ---------------------------------------------------------------------------
CREATE TABLE capability_grants (
  id          text PRIMARY KEY,
  actor       text NOT NULL,
  role        text NOT NULL CHECK (role IN (
                'human', 'architect', 'supervisor', 'developer', 'reviewer',
                'integrator', 'memory_consolidator'
              )),
  capability  text NOT NULL,
  scope_id    text REFERENCES scopes (id) ON DELETE RESTRICT,
  task_id     text REFERENCES tasks (id) ON DELETE RESTRICT,
  granted_by  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
CREATE INDEX capability_grants_actor_capability_idx
  ON capability_grants (actor, capability);
CREATE INDEX capability_grants_scope_idx
  ON capability_grants (scope_id) WHERE scope_id IS NOT NULL;
CREATE INDEX capability_grants_task_idx
  ON capability_grants (task_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- provider_identities (actor <-> provider user mapping)
-- ---------------------------------------------------------------------------
CREATE TABLE provider_identities (
  actor            text NOT NULL,
  provider         text NOT NULL,
  provider_user_id text NOT NULL,
  role             text NOT NULL CHECK (role IN (
                     'human', 'architect', 'supervisor', 'developer',
                     'reviewer', 'integrator', 'memory_consolidator'
                   )),
  is_bot           boolean NOT NULL DEFAULT false,
  PRIMARY KEY (actor, provider)
);
CREATE UNIQUE INDEX provider_identities_provider_user_idx
  ON provider_identities (provider, provider_user_id);
