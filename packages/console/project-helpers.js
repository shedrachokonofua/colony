// Pure helpers for the project surfaces: card text, dedupe, form payloads, tab routing, row models.

/** @typedef {"scopes" | "settings" | "running"} ProjectTab */

/** @type {readonly ProjectTab[]} */
export const VALID_PROJECT_TABS = ["scopes", "settings", "running"];

/**
 * Parse the tab from a hash query string or full hash, falling back to "scopes".
 * @param {string | null | undefined} hashOrQuery
 * @returns {ProjectTab}
 */
export function parseProjectTab(hashOrQuery) {
  if (!hashOrQuery) return "scopes";
  const queryStr = hashOrQuery.includes("?")
    ? hashOrQuery.split("?")[1]
    : hashOrQuery;
  const tab = new URLSearchParams(queryStr).get("tab");
  if (tab && VALID_PROJECT_TABS.includes(tab)) {
    return tab;
  }
  return "scopes";
}

/**
 * Build or update a project href (#/project/<name>?...) with the target tab,
 * preserving any other existing query parameters (like ?project=).
 * @param {string | null | undefined} currentHash
 * @param {string} projectName
 * @param {ProjectTab | string} targetTab
 */
export function serializeProjectTabHref(currentHash, projectName, targetTab) {
  const base = `#/project/${encodeURIComponent(projectName)}`;
  const qIndex = (currentHash || "").indexOf("?");
  const params = new URLSearchParams(
    qIndex >= 0 ? currentHash.slice(qIndex + 1) : "",
  );

  if (!targetTab || targetTab === "scopes") {
    params.delete("tab");
  } else if (VALID_PROJECT_TABS.includes(targetTab)) {
    params.set("tab", targetTab);
  }

  const queryStr = params.toString();
  return queryStr ? `${base}?${queryStr}` : base;
}

/**
 * A GET /projects/:name/running entry, as the API serves it.
 *
 * @typedef {{
 *   scope_id: string,
 *   scope_title?: string | null,
 *   task_id: string,
 *   task_title?: string | null,
 *   task_state?: string | null,
 *   attempt?: number | null,
 *   run: {
 *     id: string,
 *     kind?: string | null,
 *     status?: string | null,
 *     model_id?: string | null,
 *     started_at?: string | null,
 *     finished_at?: string | null,
 *   } | null,
 * }} RunningEntry
 */

/**
 * Derives presentation fields for a running-task entry.
 * @param {RunningEntry | null | undefined} entry
 */
export function deriveRunningRow(entry) {
  const scopeId = entry?.scope_id ?? "";
  const scopeTitle = entry?.scope_title || scopeId;
  const taskId = entry?.task_id ?? "";
  const taskTitle = entry?.task_title || taskId;
  const taskState = entry?.task_state ?? "queued";
  const attempt = Number.isFinite(entry?.attempt) ? Number(entry.attempt) : 0;
  const attemptText = `attempt ${attempt}`;

  const run = entry?.run ?? null;
  const hasRun = run !== null && typeof run === "object";
  const runKind = hasRun ? (run.kind ?? "") : "";
  const runModel = hasRun ? (run.model_id ?? "") : "";
  const startedAt = hasRun ? (run.started_at ?? null) : null;
  const isRunning = hasRun && run.status === "running";

  return {
    scopeId,
    scopeTitle,
    taskId,
    taskTitle,
    taskState,
    attempt,
    attemptText,
    hasRun,
    runKind,
    runModel,
    startedAt,
    isRunning,
    run,
  };
}

/**
 * Format the empty-state tally line for the Running tab.
 * e.g. "Nothing running right now." plus "N queued · N blocked" when task_state_counts is present.
 * @param {Record<string, number> | null | undefined} taskStateCounts
 * @returns {string | null}
 */
export function formatRunningEmptyTallies(taskStateCounts) {
  if (!taskStateCounts || typeof taskStateCounts !== "object") {
    return null;
  }
  const queued = Number(taskStateCounts.queued ?? 0);
  const blocked = Number(taskStateCounts.blocked ?? 0);
  return `${queued} queued · ${blocked} blocked`;
}

/**
 * Connected repositories deduped by repo_path, preserving first-seen order.
 * @template {{ repo_id?: string, repo_path?: string | null }} T
 * @param {T[] | null | undefined} repositories
 * @returns {T[]}
 */
export function distinctRepos(repositories) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {T[]} */
  const out = [];
  for (const repo of repositories ?? []) {
    if (!repo?.repo_path || seen.has(repo.repo_path)) continue;
    seen.add(repo.repo_path);
    out.push(repo);
  }
  return out;
}

/**
 * @param {string | null | undefined} context_doc
 * @param {number | null | undefined} file_count
 */
export function knowledgeText(context_doc, file_count) {
  const brief = context_doc ? "Brief" : "No brief";
  const n = file_count ?? 0;
  return `${brief} · ${n} reference file${n === 1 ? "" : "s"}`;
}

/**
 * First non-heading paragraph of the brief, flattened to one plain line.
 * @param {string | null | undefined} context_doc
 */
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

/**
 * @param {Array<{ repo_id?: string, repo_path: string | null | undefined }> | null | undefined} repositories
 */
export function repoSummaryText(repositories) {
  const repos = distinctRepos(repositories);
  if (repos.length === 0) return "No connected repositories";
  const count = repos.length;
  const shown = repos.slice(0, 2).map((r) => r.repo_path);
  const more = count > 2 ? ` +${count - 2} more` : "";
  return `${count} connected repo${count === 1 ? "" : "s"} · ${shown.join(" · ")}${more}`;
}

/** @param {unknown} fixedProject @param {unknown} formValue */
export function resolveComposerProject(fixedProject, formValue) {
  const fixed = fixedProject != null ? String(fixedProject).trim() : "";
  if (fixed) return fixed;
  return String(formValue ?? "").trim();
}

/** @param {unknown} name @param {unknown} context_doc */
export function buildNewProjectPayload(name, context_doc) {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) return null;
  const doc = String(context_doc ?? "").trim();
  // context_doc is only sent when non-empty, so the payload is built as a
  // typed Record rather than widened from a `{ name }` literal.
  /** @type {{ name: string, context_doc?: string }} */
  const body = { name: trimmedName };
  if (doc) body.context_doc = doc;
  return body;
}
