import type { DemoRunningEntry } from "./demo-data.d.ts";

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

/**
 * The offline GET /operator/summary: the shape
 * apps/colonyd/src/operator-summary.ts serves, for one window.
 */
export function demoOperatorSummary(operatorWindow?: "24h" | "7d"): {
  window: "24h" | "7d";
  window_start: string;
  generated_at: string;
  waiting_on_you: {
    plan_approvals: Array<{ scope_id: string }>;
    awaiting_merge: Array<{
      scope_id: string;
      task_id: string;
      head_sha: string;
    }>;
    blocked_tasks: Array<{
      scope_id: string;
      task_id: string;
      blocked_reason: string | null;
      age: string | null;
    }>;
    blocked_scopes: Array<{
      scope_id: string;
      blocked_reason: string | null;
      age: string | null;
    }>;
  };
  live: Array<Record<string, unknown>>;
  metrics: Record<string, unknown>;
  unclassified: Array<Record<string, unknown>>;
  deploy: Record<string, unknown>;
};
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
