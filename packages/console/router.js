// Route parsing for the console's hash-based URLs. Every reader decodes
// `location.hash` at call time so paint-after-navigation sees the new route.
import { parseProjectTab } from "./project-helpers.js";

export const PROJECT_ROUTE = /^project\/([^/?]+)/;
export const FILES_ROUTE = /^project\/([^/?]+)\/files(?:$|\?)/;
// Create route, optionally carrying a query (e.g. #/new?project=X).
export const NEW_ROUTE = /^new(?:$|\?)/;
export const NEW_PROJECT_ROUTE = /^new-project(?:$|\?)/;

export function routeScopeId() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (
    !hash ||
    hash.startsWith("?") ||
    NEW_ROUTE.test(hash) ||
    NEW_PROJECT_ROUTE.test(hash) ||
    PROJECT_ROUTE.test(hash)
  )
    return null;
  const id = hash.split("?")[0];
  return id || null;
}

export function routeIsNew() {
  return NEW_ROUTE.test(location.hash.replace(/^#\/?/, ""));
}

export function routeIsNewProject() {
  return NEW_PROJECT_ROUTE.test(location.hash.replace(/^#\/?/, ""));
}

export function routeIsManageFiles() {
  return FILES_ROUTE.test(location.hash.replace(/^#\/?/, ""));
}

export function routeProjectFilesName() {
  const match = location.hash.replace(/^#\/?/, "").match(FILES_ROUTE);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Decoded project name from `#/project/<name>`, or null on any other route. */
export function routeProjectName() {
  const match = location.hash.replace(/^#\/?/, "").match(PROJECT_ROUTE);
  return match ? decodeURIComponent(match[1]) : null;
}

/** @param {string} name */
export function projectHref(name) {
  return `#/project/${encodeURIComponent(name)}`;
}

/** @param {string} name */
export function projectFilesHref(name) {
  return `#/project/${encodeURIComponent(name)}/files`;
}

/** The `?project=` query of the current hash route, or null when absent. */
export function hashQueryProject() {
  const q = location.hash.split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get("project");
}

/**
 * The project page's tab (`?tab=`), decoded at call time so a paint right
 * after a hashchange sees the new tab. Unknown or absent values read as
 * "scopes".
 */
export function hashQueryTab() {
  return parseProjectTab(location.hash);
}
