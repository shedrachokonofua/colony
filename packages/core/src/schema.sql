PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  context_doc TEXT,                        -- operator-authored markdown (optional)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS scopes (
  id TEXT PRIMARY KEY,                       -- col-<8 hex>
  goal TEXT NOT NULL,
  title TEXT,                                -- short board label (optional)
  project_name TEXT,                         -- owning project (see projects table)
  approvals TEXT NOT NULL DEFAULT 'auto',    -- 'auto' | 'manual'
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','planning','active','validating','blocked','done','abandoned')),
  provider_repo_id TEXT NOT NULL,            -- GitLab numeric repo id as string
  provider_repo_path TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  plan_json TEXT,                            -- architect proposal awaiting approval (hitl gated)
  plan_feedback TEXT,                        -- operator replan feedback for the next architect run
  acceptance_json TEXT,                      -- operator acceptance criteria for scope validation
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                       -- <scope_id>.<n>
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  title TEXT NOT NULL,
  spec TEXT NOT NULL,                        -- markdown packet body from architect
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','mr_open','merged','blocked','canceled')),
  state_version INTEGER NOT NULL DEFAULT 0,  -- optimistic concurrency, bump on every state write
  branch TEXT,                               -- colony/<task_id>
  mr_iid INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,                        -- ISO; dispatch only when <= now
  blocked_reason TEXT,
  merge_approved_sha TEXT,                   -- operator-approved MR head (manual approvals)
  human_feedback TEXT,                       -- operator review feedback for the next attempt
  cost_prediction_json TEXT,                 -- TaskCostPrediction v1 blob from offline runs-history heuristic
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,                       -- uuid
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  task_id TEXT REFERENCES tasks(id),         -- NULL for architect / scope-level runs
  kind TEXT NOT NULL CHECK (kind IN ('architect','implement','merge_gate','review','validate')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','canceled')),
  lease_expires_at TEXT NOT NULL,
  base_sha TEXT,
  head_sha TEXT,
  workspace_path TEXT,
  envelope_json TEXT,                        -- validated agent envelope
  evidence_json TEXT,                        -- commands, exit codes, gate results, artifacts
  token_id TEXT,                             -- provider access-token id; crash-reap revoke
  model_id TEXT,                             -- LLM model the run started with (nullable)
  trace_id TEXT,                             -- run root span's trace id; links spans to the run
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status) WHERE status='running';

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('webhook','poll')),
  dedup_key TEXT NOT NULL UNIQUE,            -- X-Gitlab-Event-UUID or sha256(body); poll: '<kind>:<iid>:<fetched-at>'
  task_id TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT NOT NULL,                       -- 'svc:colonyd' | 'human:<id>' | 'agent:<run_id>'
  action TEXT NOT NULL,                      -- e.g. 'task.transition', 'run.start', 'gate.fail', 'mr.merged'
  scope_id TEXT, task_id TEXT, run_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event TEXT NOT NULL,                       -- e.g. 'pi_tool_call', 'run_limit_exceeded'
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS run_artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, key TEXT NOT NULL, ref TEXT NOT NULL, sha256 TEXT, bytes INTEGER, content_type TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TRIGGER IF NOT EXISTS run_artifacts_no_update BEFORE UPDATE ON run_artifacts
  BEGIN SELECT RAISE(ABORT,'run_artifacts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS run_artifacts_no_delete BEFORE DELETE ON run_artifacts
  BEGIN SELECT RAISE(ABORT,'run_artifacts is append-only'); END;
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id, id);

CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('text/plain','text/markdown')),
  content TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_name, filename)
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_name, filename);
