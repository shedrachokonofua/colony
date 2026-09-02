// The shell's action handlers: one function per colony-* event the views
// bubble up. Each writes shell state through the same contract the data
// layer reads, so an action is "mutate state, then refresh" and nothing
// more; confirm's two-step arming and the demo/local branches ride the same
// functions their live counterparts use.
import {
  routeProjectFilesName,
  hashQueryProject,
  projectHref,
} from "./router.js";
import { DEMO, demoContextStore, demoFileStore } from "./demo.js";
import {
  buildNewProjectPayload,
  resolveComposerProject,
} from "./project-helpers.js";

/**
 * POST helper behind every mutation: clears any pending confirm, then api +
 * refresh. Errors surface through the shell's error banner.
 *
 * @param {import("./shell-data.js").ShellState} app
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 */
export async function mutate(app, path, body) {
  app.confirm = null;
  try {
    await app.api(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    await app._refresh();
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
  }
}

/** @param {import("./shell-data.js").ShellState} app @param {string | null | undefined} actor */
export function saveActor(app, actor) {
  const next = String(actor ?? "").trim();
  if (!next || next === app.actor) return;
  app.actor = next;
  try {
    localStorage.setItem("colony.actor", next);
  } catch {
    /* private mode: keep the actor for this page only */
  }
  void app._refresh();
}

/** @param {import("./shell-data.js").ShellState} app @param {string} taskId */
export function selectTask(app, taskId) {
  app.selectedTaskId = taskId;
  app.drawerOpen = true;
  app.confirm = null;
  app.runEvents = null;
  void app._refresh();
}

/** @param {import("./shell-data.js").ShellState} app */
export function closeDrawer(app) {
  app.drawerOpen = false;
  app.runEvents = null;
}

/** @param {import("./shell-data.js").ShellState} app @param {string} kind */
export function confirmAction(app, kind) {
  app.confirm = kind;
}

/**
 * Flip an open-state property by key — the catalog's single toggle route.
 *
 * @param {import("./shell-data.js").ShellState} app
 * @param {"goalOpen" | "planOpen" | "briefOpen" | "settingsOpen" | "showArchived"} key
 */
export function toggle(app, key) {
  // Showing archived rows must not leave the old page's rows on screen
  // while the refetch is in flight: repaint now, then refetch. Hiding
  // drops the page entirely so the stale archived rows never linger.
  app[key] = !app[key];
  if (key === "showArchived" && !app.showArchived) app.projectsPage = null;
  void app._refresh();
}

/**
 * @param {import("./shell-data.js").ShellState} app
 * @param {string | null | undefined} project
 * @param {string | null | undefined} context_doc
 */
export async function saveContext(app, project, context_doc) {
  const page = app.projectPage;
  const name = project ?? page?.name;
  if (!name) return;
  const doc = String(context_doc ?? "").trim() ? context_doc : null;
  /** @type {{ doc: string, status: string | null }} */
  const ctx = { doc: context_doc ?? "", status: "saving" };
  app.projectContext = ctx;
  if (DEMO) {
    // Demo brief editing is purely local state, never a network write.
    demoContextStore.set(name, doc ?? null);
    app.projectContext = { doc: context_doc ?? "", status: "saved" };
    return;
  }
  try {
    await app.api(`/projects/${encodeURIComponent(name)}/context`, {
      method: "PUT",
      body: JSON.stringify({ context_doc: doc }),
    });
    app.projectContext = { doc: context_doc ?? "", status: "saved" };
    await app._refresh();
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
    app.projectContext = { doc: context_doc ?? "", status: null };
  }
}

/** @param {import("./shell-data.js").ShellState} app @param {string} fileId */
export function confirmFile(app, fileId) {
  app.confirmFile = app.confirmFile === fileId ? null : fileId;
}

/** @param {import("./shell-data.js").ShellState} app @param {string} fileId */
export function toggleReplaceFile(app, fileId) {
  app.replaceFileId = app.replaceFileId === fileId ? null : fileId;
  app.confirmFile = null;
}

/**
 * The project name a file mutation targets, or null when the current route
 * is not manage-files (or demo mode already applied it locally).
 *
 * @param {import("./shell-data.js").ShellState} app
 * @param {string} fileId
 * @returns {Promise<string | null>}
 */
async function fileTarget(app, fileId) {
  const name = routeProjectFilesName();
  const page = app.filesPage;
  if (!name || !page?.project) return null;
  if (DEMO) {
    demoFileStore.set(
      name,
      (demoFileStore.get(name) ?? []).filter((f) => f.id !== fileId),
    );
    app.confirmFile = null;
    await app._refresh();
    return null;
  }
  return name;
}

/** @param {import("./shell-data.js").ShellState} app @param {{ fileId: string }} detail */
export async function deleteFile(app, { fileId }) {
  const name = await fileTarget(app, fileId);
  if (!name) return;
  try {
    await app.api(
      `/projects/${encodeURIComponent(name)}/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE" },
    );
    app.confirmFile = null;
    await app._refresh();
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
  }
}

/**
 * @param {import("./shell-data.js").ShellState} app
 * @param {{ fileId: string, content: string, media_type: string }} detail
 */
export async function replaceFile(app, { fileId, content, media_type }) {
  const page = app.filesPage;
  if (DEMO) {
    if (!page) return;
    const files = demoFileStore.get(page.name) ?? [];
    demoFileStore.set(
      page.name,
      files.map((f) =>
        f.id === fileId
          ? {
              ...f,
              media_type,
              byte_size: new TextEncoder().encode(content).length,
              updated_at: new Date().toISOString(),
            }
          : f,
      ),
    );
    app.replaceFileId = null;
    await app._refresh();
    return;
  }
  if (!page?.project) return;
  try {
    await app.api(
      `/projects/${encodeURIComponent(page.name)}/files/${encodeURIComponent(fileId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ media_type, content }),
      },
    );
    app.replaceFileId = null;
    await app._refresh();
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
  }
}

/**
 * @param {import("./shell-data.js").ShellState} app
 * @param {{ filename: string, media_type: string, content: string }} detail
 */
export async function uploadFile(app, { filename, media_type, content }) {
  const page = app.filesPage;
  if (!page?.project) return;
  if (DEMO) {
    const files = demoFileStore.get(page.name) ?? [];
    demoFileStore.set(page.name, [
      ...files,
      {
        id: `demo-file-${Date.now()}`,
        filename,
        media_type,
        byte_size: new TextEncoder().encode(content).length,
        sha256: "d".repeat(64),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    await app._refresh();
    return;
  }
  try {
    await app.api(`/projects/${encodeURIComponent(page.name)}/files`, {
      method: "POST",
      body: JSON.stringify({ filename, media_type, content }),
    });
    await app._refresh();
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
  }
}

/** @param {import("./shell-data.js").ShellState} app @param {{ name: string, context_doc?: string }} detail */
export async function createProject(app, { name, context_doc }) {
  const payload = buildNewProjectPayload(name, context_doc);
  if (!payload) return;
  try {
    await app.api("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    app.newProjectDraft = null;
    app.navigate(projectHref(payload.name));
  } catch (err) {
    app.newProjectDraft = { name, context_doc };
    app.error = err instanceof Error ? err.message : String(err);
  }
}

/**
 * @param {import("./shell-data.js").ShellState} app
 * @param {{ goal: string, title?: string, project?: string | null, repo: { path: string }, approvals?: string }} detail
 */
export async function createScope(
  app,
  { goal, title, project, repo, approvals },
) {
  const trimmedGoal = String(goal ?? "").trim();
  const path = String(repo?.path ?? "").trim();
  if (!trimmedGoal || !path) return;
  // When the composer was opened from a project, the project is fixed: the
  // operator cannot silently change it.
  const fixedProject = resolveComposerProject(
    hashQueryProject(),
    project ?? null,
  );
  try {
    const scope = await app.api("/scopes", {
      method: "POST",
      body: JSON.stringify({
        goal: trimmedGoal,
        ...(title ? { title } : {}),
        approvals: approvals || "auto",
        repo: { path },
        ...(fixedProject ? { project: fixedProject } : {}),
      }),
    });
    app.navigate(`#/${scope.id}`);
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
  }
}

/** @param {import("./shell-data.js").ShellState} app @param {string} taskId @param {string} action */
export async function taskAction(app, taskId, action) {
  if (!taskId || !action) return;
  await mutate(app, `/tasks/${encodeURIComponent(taskId)}/${action}`);
}

/** @param {import("./shell-data.js").ShellState} app @param {string} scopeId */
export async function abandon(app, scopeId) {
  await mutate(app, `/scopes/${encodeURIComponent(scopeId)}/abandon`);
}

/** @param {import("./shell-data.js").ShellState} app @param {string} title @param {string} markdown */
export function openReader(app, title, markdown) {
  app.reader = { title, markdown };
}

/** @param {import("./shell-data.js").ShellState} app */
export function closeReader(app) {
  app.reader = null;
}

/** @param {import("./shell-data.js").ShellState} app @param {string} path @param {Record<string, unknown> | undefined} body */
export async function feedback(app, path, body) {
  const feedbackText = String(body?.feedback ?? "").trim();
  if (!feedbackText) return;
  await mutate(app, path, { feedback: feedbackText });
}
