-- Multi-repo provider target model (COL-1.2b).
--
-- Introduces a registry of provider projects and many-to-many links from
-- scopes/tasks onto provider projects. Adds project context to
-- provider_mirrors so the same provider entity ID across two GitLab projects
-- maps to two distinct mirror rows.

-- ---------------------------------------------------------------------------
-- provider_projects
--
-- Authoritative registry for "this provider has project X at path P".
-- (provider, provider_id) is unique because the same path can be renamed and
-- (provider, path) is unique at any one point in time.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_projects (
  id              text PRIMARY KEY,
  provider        text NOT NULL,
  provider_id     text NOT NULL,
  path            text NOT NULL,
  default_branch  text NOT NULL DEFAULT 'main',
  visibility      text NOT NULL CHECK (visibility IN (
                    'private', 'internal', 'public'
                  )),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_projects_provider_id_unique
    UNIQUE (provider, provider_id),
  CONSTRAINT provider_projects_path_unique
    UNIQUE (provider, path)
);
CREATE INDEX provider_projects_provider_idx
  ON provider_projects (provider);

-- ---------------------------------------------------------------------------
-- scope_targets
--
-- Many provider projects per scope, each with a role describing the slice of
-- work that lives there (e.g. frontend / backend / docs). Exactly one row may
-- have role='primary' per scope — the partial unique index enforces that.
-- ---------------------------------------------------------------------------
CREATE TABLE scope_targets (
  id                  text PRIMARY KEY,
  scope_id            text NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  provider_project_id text NOT NULL
                       REFERENCES provider_projects (id) ON DELETE RESTRICT,
  role                text NOT NULL CHECK (role IN (
                        'primary', 'frontend', 'backend', 'data',
                        'infra', 'docs', 'shared'
                      )),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scope_targets_role_unique
    UNIQUE (scope_id, provider_project_id, role)
);
CREATE INDEX scope_targets_scope_idx ON scope_targets (scope_id);
CREATE INDEX scope_targets_project_idx ON scope_targets (provider_project_id);
CREATE UNIQUE INDEX scope_targets_primary_idx
  ON scope_targets (scope_id) WHERE role = 'primary';

-- ---------------------------------------------------------------------------
-- task_targets
--
-- Each task has exactly one primary provider project plus zero or more
-- secondary affected projects.
-- ---------------------------------------------------------------------------
CREATE TABLE task_targets (
  id                  text PRIMARY KEY,
  task_id             text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  provider_project_id text NOT NULL
                       REFERENCES provider_projects (id) ON DELETE RESTRICT,
  role                text NOT NULL CHECK (role IN ('primary', 'secondary')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_targets_project_unique UNIQUE (task_id, provider_project_id)
);
CREATE INDEX task_targets_task_idx ON task_targets (task_id);
CREATE INDEX task_targets_project_idx ON task_targets (provider_project_id);
CREATE UNIQUE INDEX task_targets_primary_idx
  ON task_targets (task_id) WHERE role = 'primary';

-- ---------------------------------------------------------------------------
-- provider_mirrors: add project context.
--
-- The original uniqueness constraint (provider, entity_kind, provider_id) is
-- too strict once we span multiple GitLab projects: GitLab issue iid 7 in
-- project A and project B would collide on `7`. Replace it with a unique
-- index that includes provider_project_id, treating a NULL project as a
-- distinct slot ("no project") so user/scope mirrors that legitimately have
-- no project still de-duplicate.
-- ---------------------------------------------------------------------------
ALTER TABLE provider_mirrors
  ADD COLUMN provider_project_id   text
    REFERENCES provider_projects (id) ON DELETE RESTRICT,
  ADD COLUMN provider_project_path text;

ALTER TABLE provider_mirrors
  DROP CONSTRAINT provider_mirrors_provider_unique;

CREATE UNIQUE INDEX provider_mirrors_provider_unique
  ON provider_mirrors (
    provider,
    entity_kind,
    provider_id,
    COALESCE(provider_project_id, '')
  );
CREATE INDEX provider_mirrors_project_idx
  ON provider_mirrors (provider_project_id)
  WHERE provider_project_id IS NOT NULL;
