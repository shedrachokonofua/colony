// Pure helpers for the project surfaces: card text, dedupe, form payloads.

/** Connected repositories deduped by repo_path, preserving first-seen order. */
export function distinctRepos(repositories) {
  const seen = new Set();
  const out = [];
  for (const repo of repositories ?? []) {
    if (!repo?.repo_path || seen.has(repo.repo_path)) continue;
    seen.add(repo.repo_path);
    out.push(repo);
  }
  return out;
}

export function knowledgeText(context_doc, file_count) {
  const brief = context_doc ? "Brief" : "No brief";
  const n = file_count ?? 0;
  return `${brief} · ${n} reference file${n === 1 ? "" : "s"}`;
}

/** First non-heading paragraph of the brief, flattened to one plain line. */
export function projectDescription(context_doc) {
  const doc = String(context_doc ?? "");
  for (const block of doc.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (lines.length) return lines.join(" ");
  }
  return "";
}

export function repoSummaryText(repositories) {
  const repos = distinctRepos(repositories);
  if (repos.length === 0) return "No connected repositories";
  const count = repos.length;
  const shown = repos.slice(0, 2).map((r) => r.repo_path);
  const more = count > 2 ? ` +${count - 2} more` : "";
  return `${count} connected repo${count === 1 ? "" : "s"} · ${shown.join(" · ")}${more}`;
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
