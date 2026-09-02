import { statusCode } from "../commands/scopes.js";
import { ansi } from "../render.js";

export interface ScopeRow {
  id: string;
  title: string;
  status: string;
}

export interface TaskRow {
  id: string;
  title: string;
  state: string;
  attempt: number;
  mrIid: number | null;
  model: string | null;
}

export interface TuiState {
  scopes: ScopeRow[];
  selectedScopeId: string | null;
  tasks: TaskRow[];
  selectedTaskIndex: number;
  feedLines: string[];
  statusLine: string;
  modal:
    | null
    | { kind: "abandon-confirm" }
    | { kind: "line-input"; prompt: string; buffer: string };
  lastAction: { ok: boolean; text: string } | null;
  focus?: "scopes" | "tasks";
}

const STATUS_GROUPS = [
  "draft",
  "planning",
  "active",
  "validating",
  "blocked",
  "done",
  "abandoned",
] as const;

/** Truncate a plain string to maxLen characters. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return maxLen > 1 ? s.slice(0, maxLen - 1) + "…" : s.slice(0, maxLen);
}

/** Pad or truncate string to exact width */
function fit(s: string, width: number): string {
  if (s.length > width) return s.slice(0, width);
  return s.padEnd(width);
}

/**
 * Pure frame renderer.
 * Returns exact frame string with ANSI clear and cursor home (\u001b[2J\u001b[H).
 */
export function renderFrame(
  state: TuiState,
  size: { cols: number; rows: number },
): string {
  const cols = Math.max(20, size.cols);
  const rows = Math.max(10, size.rows);

  const leftWidth = Math.max(20, Math.floor(cols * 0.35));
  const rightWidth = Math.max(20, cols - leftWidth - 1);
  const usableRows = rows - 1;

  const taskHeight = Math.max(3, Math.floor(usableRows * 0.45));
  const feedHeight = usableRows - taskHeight;

  // 1. Build Left Pane lines (grouped by status)
  const leftLines: string[] = [];
  const grouped: Record<string, ScopeRow[]> = {
    draft: [],
    planning: [],
    active: [],
    validating: [],
    blocked: [],
    done: [],
    abandoned: [],
  };

  for (const s of state.scopes) {
    if (grouped[s.status]) {
      grouped[s.status].push(s);
    } else {
      (grouped[s.status] = grouped[s.status] || []).push(s);
    }
  }

  for (const group of STATUS_GROUPS) {
    const scopes = grouped[group] ?? [];
    if (scopes.length === 0) continue;
    leftLines.push(`[${group.toUpperCase()}]`);
    for (const scope of scopes) {
      const isSelected = scope.id === state.selectedScopeId;
      const marker = isSelected ? ">" : " ";
      const prefix = `${marker} ${scope.id}  `;
      const titleWidth = Math.max(0, leftWidth - prefix.length);
      const title = truncate(scope.title || "(untitled)", titleWidth);
      leftLines.push(`${prefix}${title}`);
    }
  }

  // Any other status not in standard list
  for (const [group, scopes] of Object.entries(grouped)) {
    if (STATUS_GROUPS.includes(group as (typeof STATUS_GROUPS)[number]))
      continue;
    if (scopes.length === 0) continue;
    leftLines.push(`[${group.toUpperCase()}]`);
    for (const scope of scopes) {
      const isSelected = scope.id === state.selectedScopeId;
      const marker = isSelected ? ">" : " ";
      const prefix = `${marker} ${scope.id}  `;
      const titleWidth = Math.max(0, leftWidth - prefix.length);
      const title = truncate(scope.title || "(untitled)", titleWidth);
      leftLines.push(`${prefix}${title}`);
    }
  }

  // 2. Build Right Top Pane lines (task list)
  const taskLines: string[] = [];
  taskLines.push("TASKS");
  if (state.tasks.length === 0) {
    taskLines.push("  (no tasks)");
  } else {
    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i]!;
      const isSelected = i === state.selectedTaskIndex;
      const marker = isSelected ? ">" : " ";
      const mrStr = task.mrIid !== null ? `!${task.mrIid}` : "-";
      const modelStr = task.model ?? "-";
      const meta = `${marker} ${task.id}  ${task.state}  #${task.attempt}  ${mrStr}  ${modelStr}  `;
      const availTitle = Math.max(0, rightWidth - meta.length);
      const title = truncate(task.title, availTitle);
      taskLines.push(`${meta}${title}`);
    }
  }

  // 3. Build Right Bottom Pane lines (live feed tail)
  const feedPaneLines: string[] = [];
  feedPaneLines.push("LIVE FEED");
  const maxFeedItems = Math.max(0, feedHeight - 1);
  const tail = state.feedLines.slice(-maxFeedItems);
  for (const line of tail) {
    feedPaneLines.push(truncate(line, rightWidth));
  }

  // 4. Compose pane lines into rows
  const outRows: string[] = [];
  for (let r = 0; r < usableRows; r++) {
    const leftText = fit(leftLines[r] ?? "", leftWidth);
    let rightText = "";
    if (r < taskHeight) {
      rightText = fit(taskLines[r] ?? "", rightWidth);
    } else {
      const feedIdx = r - taskHeight;
      rightText = fit(feedPaneLines[feedIdx] ?? "", rightWidth);
    }
    outRows.push(`${leftText}│${rightText}`);
  }

  // 5. Status line / modal line (1 row)
  let statusText = "";
  if (state.modal?.kind === "abandon-confirm") {
    statusText = "Abandon scope? (y/N): ";
  } else if (state.modal?.kind === "line-input") {
    statusText = `${state.modal.prompt}${state.modal.buffer}`;
  } else {
    const hints =
      "q:quit  j/k:move  h/l:pane  a:approve  R:replan  A:abandon  r:retry  s:stop  u:unblock  m:merge";
    const last = state.lastAction
      ? `[${state.lastAction.ok ? "OK" : "ERR"}: ${state.lastAction.text}] `
      : "";
    statusText = truncate(`${last}${state.statusLine || hints}`, cols);
  }
  outRows.push(fit(statusText, cols));

  return `\u001b[2J\u001b[H${outRows.join("\n")}`;
}
