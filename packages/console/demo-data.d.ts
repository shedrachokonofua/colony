export const DEMO_PROJECT_COUNT: number;
export const DEMO_SCOPES_IN_PROJECT: number;
export const DEMO_SHA_A: string;
export const DEMO_SHA_B: string;
export const DEMO_GATE_STARTED: string;

export function buildFillerProjects(now: number): Array<{
  name: string;
  context_doc: null;
  created_at: string;
  updated_at: string;
  scope_count: 0;
  status_counts: Record<string, number>;
  last_activity_at: null;
  file_count: 0;
  file_bytes: 0;
  repositories: never[];
}>;

export function buildDemoScopes(now: number): Array<{
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
}>;

export function buildDemoProject(
  now: number,
  scopes: ReturnType<typeof buildDemoScopes>,
  files: Array<{ byte_size: number }>,
): {
  name: string;
  context_doc: string | null;
  created_at: string;
  updated_at: string;
  scope_count: number;
  status_counts: Record<string, number>;
  last_activity_at: string | null;
  file_count: number;
  file_bytes: number;
  repositories: Array<{ repo_id: string; repo_path: string }>;
};

export function buildDemoDetail(now: number): {
  scope: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
  deps: Array<{ task_id: string; depends_on_task_id: string }>;
  runs: Array<Record<string, unknown>>;
};
