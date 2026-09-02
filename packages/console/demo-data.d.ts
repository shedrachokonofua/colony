export const DEMO_PROJECT_COUNT: number;
export const DEMO_SCOPES_IN_PROJECT: number;
export const DEMO_SHA_A: string;
export const DEMO_SHA_B: string;
export const DEMO_GATE_STARTED: string;

export interface DemoStatusCounts {
  draft: number;
  planning: number;
  active: number;
  validating: number;
  blocked: number;
  done: number;
  abandoned: number;
}

export interface DemoScope {
  id: string;
  goal: string;
  title: string;
  project_name: string;
  status: string;
  provider_repo_path: string;
  default_branch: string;
  plan_json: null;
  acceptance_json: null;
  blocked_reason: null;
  created_at: string;
  updated_at: string;
}

export interface DemoProject {
  name: string;
  context_doc: string | null;
  created_at: string;
  updated_at: string;
  scope_count: number;
  status_counts: DemoStatusCounts;
  last_activity_at: string | null;
  file_count: number;
  file_bytes: number;
  repositories: Array<{ repo_id: string; repo_path: string }>;
}

/** One GET /projects/:name/running row, as the demo world builds it. */
export interface DemoRunningEntry {
  scope_id: string;
  scope_title: string | null;
  task_id: string;
  task_title: string | null;
  task_state: string;
  attempt: number;
  run: {
    id: string;
    scope_id: string;
    task_id: string;
    kind: string;
    status: string;
    model_id: string | null;
    head_sha: string | null;
    error: string | null;
    evidence_json: string | null;
    started_at: string;
    finished_at: string | null;
  } | null;
}

export interface DemoFile {
  id: string;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  updated_at: string;
}

export function buildFillerProjects(now: number): Array<{
  name: string;
  context_doc: null;
  created_at: string;
  updated_at: string;
  scope_count: 0;
  status_counts: DemoStatusCounts;
  last_activity_at: null;
  file_count: 0;
  file_bytes: 0;
  repositories: never[];
}>;

export function buildDemoScopes(now: number): DemoScope[];

export function buildDemoProject(
  now: number,
  scopes: readonly DemoScope[],
  files: readonly { byte_size: number }[],
): DemoProject;

export function buildEmptyProject(now: number): {
  name: string;
  context_doc: null;
  created_at: string;
  updated_at: string;
  scope_count: 0;
  status_counts: DemoStatusCounts;
  last_activity_at: null;
  file_count: 0;
  file_bytes: 0;
  repositories: never[];
};

export function buildDemoFiles(now: number): DemoFile[];

export function buildDemoDetail(now: number): {
  scope: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
  deps: Array<{ task_id: string; depends_on_task_id: string }>;
  runs: Array<Record<string, unknown>>;
};

/**
 * The demo project's Running-tab rows, plus the detail payloads of the
 * scopes that own them so a row click can select its task offline.
 */
export function buildDemoRunning(
  now: number,
  scopes: readonly DemoScope[],
): {
  entries: DemoRunningEntry[];
  details: Record<
    string,
    {
      scope: DemoScope;
      tasks: Array<Record<string, unknown>>;
      deps: Array<{ task_id: string; depends_on_task_id: string }>;
      runs: Array<Record<string, unknown>>;
    }
  >;
};

export function buildDemoRunEvents(now: number): Array<{
  id: number;
  run_id: string;
  at: string;
  event: string;
  detail_json: string;
}>;

export function buildDemoAudit(now: number): Array<{
  id: number;
  at: string;
  actor: string;
  action: string;
  detail_json: string;
}>;
