export function distinctRepos<T extends { repo_path?: string | null }>(
  repositories: T[] | null | undefined,
): T[];

export function knowledgeText(
  context_doc: string | null | undefined,
  file_count: number | null | undefined,
): string;

export function repoSummaryText(
  repositories:
    | Array<{ repo_path: string | null | undefined }>
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
