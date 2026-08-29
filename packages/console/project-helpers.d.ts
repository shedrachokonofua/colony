export const PROJECT_CARDS_GRID_DESKTOP: string;
export const PROJECT_CARDS_GRID_MOBILE: string;

export function repoSummaryText(
  repositories: { repo_id: string; repo_path: string }[] | null | undefined,
): string;

export function knowledgeText(
  context_doc: string | null | undefined,
  file_count: number | null | undefined,
): string;

export function resolveComposerProject(
  fixedProject: string | null | undefined,
  formValue: string | null | undefined,
): string;

export function buildNewProjectPayload(
  name: string,
  context_doc: string,
): { name: string; context_doc?: string } | null;
