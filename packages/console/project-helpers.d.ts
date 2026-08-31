export const VALID_PROJECT_TABS: readonly string[];

export function parseProjectTab(hashOrQuery: string | null | undefined): string;

export function serializeProjectTabHref(
  currentHash: string | null | undefined,
  projectName: string,
  targetTab: string,
): string;

export interface RunningRowInput {
  scope_id?: string;
  scope_title?: string;
  task_id?: string;
  task_title?: string;
  task_state?: string;
  attempt?: number;
  run?: {
    id?: string;
    kind?: string;
    status?: string;
    model_id?: string | null;
    started_at?: string | null;
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

export function deriveRunningRow(
  entry: RunningRowInput | null | undefined,
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
