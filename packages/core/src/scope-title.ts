/**
 * Backfill-only (migration 10). A scope always has a title. Untitled scopes (API, CLI, operator scripts)
 * used to render their goal's first line verbatim on every surface -
 * markdown heading marks included, truncated mid-word. The first non-empty
 * line of the goal, stripped of heading marks, capped at 120 chars.
 */
export function titleFromGoal(goal: string): string {
  const first = goal
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const stripped = (first ?? "Untitled scope").replace(/^#+\s*/, "").trim();
  return stripped.length > 120
    ? `${stripped.slice(0, 117).trimEnd()}...`
    : stripped;
}
