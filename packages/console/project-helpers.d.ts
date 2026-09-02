export type ProjectTab = "scopes" | "settings" | "running";

export const VALID_PROJECT_TABS: readonly ProjectTab[];

export function parseProjectTab(
  hashOrQuery: string | null | undefined,
): ProjectTab;

export function serializeProjectTabHref(
  currentHash: string | null | undefined,
  projectName: string,
  targetTab: string,
): string;

/** One GET /projects/:name/running entry, as the API serves it. */
export interface RunningEntry {
  scope_id: string;
  scope_title?: string | null;
  task_id: string;
  task_title?: string | null;
  task_state?: string | null;
  attempt?: number | null;
  run: {
    id: string;
    kind?: string | null;
    status?: string | null;
    model_id?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
  } | null;
}

export interface RunningRowInput {
  scope_id?: string;
  scope_title?: string | null;
  task_id?: string;
  task_title?: string | null;
  task_state?: string | null;
  attempt?: number | null;
  run?: {
    id?: string;
    kind?: string | null;
    status?: string | null;
    model_id?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
  } | null;
}

export interface DerivedRunningRow {
  scopeId: string;
  scopeTitle: string;
  taskId: string;
  taskTitle: string;
  taskState: string;
  attempt: number;
  attemptText: string;
  hasRun: boolean;
  runKind: string;
  runModel: string;
  startedAt: string | null;
  isRunning: boolean;
  run: RunningRowInput["run"];
}

/** A row the running surfaces key on: the API entry plus its derived fields. */
export interface RunningRow extends DerivedRunningRow {
  scopeId: string;
}

export function deriveRunningRow(
  entry: RunningEntry | RunningRowInput | null | undefined,
): DerivedRunningRow;

export function formatRunningEmptyTallies(
  taskStateCounts: Record<string, number> | null | undefined,
): string | null;

export function distinctRepos<
  T extends { repo_id?: string; repo_path?: string | null },
>(repositories: T[] | null | undefined): T[];

export function knowledgeText(
  context_doc: string | null | undefined,
  file_count: number | null | undefined,
): string;

export function projectDescription(
  context_doc: string | null | undefined,
): string;

export function repoSummaryText(
  repositories:
    | Array<{
        repo_id?: string;
        repo_path: string | null | undefined;
      }>
    | null
    | undefined,
): string;

export function resolveComposerProject(
  fixedProject: unknown,
  formValue: unknown,
): string;

export function buildNewProjectPayload(
  name: unknown,
  context_doc: unknown,
): { name: string; context_doc?: string } | null;
