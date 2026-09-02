/** One demo scope row (buildDemoScopes / buildDemoDetail). */
export interface DemoScope {
  id: string;
  goal: string;
  title?: string | null;
  project_name: string | null;
  status: string;
  provider_repo_path: string;
  default_branch: string;
  plan_json: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  approvals?: string;
  mr_iid?: number | null;
  context_doc?: string;
}

/** One GET /projects/:name/running row, as the demo world serves it. */
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

/** One demo project row (buildDemoProject / buildFillerProjects). */
export interface DemoProject {
  name: string;
  context_doc: string | null;
  status_counts: Record<string, number>;
  scope_count: number;
  file_count: number;
  repositories: Array<{ repo_id: string; repo_path: string }>;
  created_at: string;
  updated_at: string;
}

export const DEMO: boolean;
export const DEMO_READS: RegExp;
export const demoContextStore: Map<string, string | null>;
export const demoFileStore: Map<string, Array<Record<string, unknown>>>;

/** The assembled offline world the demo shell reads in demo mode. */
export function demoWorld(): {
  config: {
    gitlab_base_url: string;
    review_mode: string;
    hitl_mode: string;
    trace_ui_base_url: string | null;
  };
  project: DemoProject;
  projects: DemoProject[];
  files: Array<Record<string, unknown>>;
  scopes: DemoScope[];
  /** The primary demo scope's full detail: scope, tasks, deps, runs. */
  detail: {
    scope: DemoScope;
    tasks: Array<Record<string, unknown>>;
    deps: Array<Record<string, unknown>>;
    runs: Array<Record<string, unknown>>;
  };
  /** The Running tab's rows for the demo project. */
  running: DemoRunningEntry[];
  /**
   * Detail payloads for the scopes owning a Running-tab row, so activating a
   * row offline lands on a sheet that actually contains the task.
   */
  runningDetails: Record<
    string,
    {
      scope: DemoScope;
      tasks: Array<Record<string, unknown>>;
      deps: Array<Record<string, unknown>>;
      runs: Array<Record<string, unknown>>;
    }
  >;
  runEvents: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
};
