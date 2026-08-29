// Pure helpers for project surfaces — no DOM, no lit, usable from app.js and tests.
export const PROJECT_CARDS_GRID_DESKTOP = "repeat(2, minmax(0, 1fr))";
export const PROJECT_CARDS_GRID_MOBILE = "1fr";

export function repoSummaryText(repositories) {
  const repos = repositories ?? [];
  if (repos.length === 0) return "No connected repositories";
  const count = repos.length;
  const shown = repos.slice(0, 2).map((r) => r.repo_path);
  const more = count > 2 ? ` +${count - 2} more` : "";
  return `${count} connected repo${count === 1 ? "" : "s"} · ${shown.join(" · ")}${more}`;
}

export function knowledgeText(context_doc, file_count) {
  const brief = context_doc ? "Brief" : "No brief";
  const n = file_count ?? 0;
  return `${brief} · ${n} reference file${n === 1 ? "" : "s"}`;
}

export function resolveComposerProject(fixedProject, formValue) {
  const fixed = fixedProject != null ? String(fixedProject).trim() : "";
  if (fixed) return fixed;
  return String(formValue ?? "").trim();
}

export function buildNewProjectPayload(name, context_doc) {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) return null;
  const doc = String(context_doc ?? "").trim();
  const body = { name: trimmedName };
  if (doc) body.context_doc = doc;
  return body;
}
