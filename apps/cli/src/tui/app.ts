import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { ApiError, type ColonyClient } from "../client.js";
import { iterPages, toCursorPage } from "../cursor.js";
import {
  renderFrame,
  type ScopeRow,
  type TaskRow,
  type TuiState,
} from "./frame.js";
import { summarize } from "../commands/logs.js";

export interface TuiApp {
  start(): Promise<void>;
  stop(): void;
}

export interface TuiClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CreateTuiAppOptions {
  client: ColonyClient;
  clock: TuiClock;
  out: (s: string) => void;
  in?: () => string | null;
  cols: number;
  rows: number;
  editor?: (prompt: string) => Promise<string | null>;
  confirm?: (q: string) => Promise<boolean>;
}

interface ScopesResponse {
  scopes: {
    id: string;
    title: string | null;
    status: string;
  }[];
}

interface ScopeDetailResponse {
  scope: {
    id: string;
    title: string | null;
    status: string;
  };
  tasks: {
    id: string;
    title: string;
    state: string;
    attempt: number;
    mr_iid: number | null;
  }[];
  runs: {
    id: string;
    kind: string;
    task_id: string | null;
    model_id: string | null;
    status: string;
    started_at: string;
    finished_at: string | null;
  }[];
}

interface EventPage {
  events: {
    id: number;
    run_id: string;
    at: string;
    event: string;
    detail_json: string;
  }[];
  has_more: boolean;
  oldest_id: number | null;
  newest_id: number | null;
}

const POLL_CADENCE_MS = 1500;
const MAX_FEED_LINES = 200;

export function createTuiApp(deps: CreateTuiAppOptions): TuiApp {
  let running = false;
  let cols = deps.cols;
  let rows = deps.rows;

  const state: TuiState = {
    scopes: [],
    selectedScopeId: null,
    tasks: [],
    selectedTaskIndex: 0,
    feedLines: [],
    statusLine: "",
    modal: null,
    lastAction: null,
    focus: "scopes",
  };

  const seenEventIds = new Set<number>();
  let activeRunId: string | null = null;

  const editorLauncher =
    deps.editor ??
    (async (initialText: string): Promise<string | null> => {
      const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
      const tmpPath = join(
        tmpdir(),
        `colony-replan-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      writeFileSync(tmpPath, initialText, "utf8");

      // Temporarily exit raw mode for editor
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(editorCmd, [tmpPath], {
            stdio: "inherit",
          });
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`editor exited with code ${code}`));
          });
          child.on("error", reject);
        });

        const content = readFileSync(tmpPath, "utf8").trim();
        return content.length > 0 ? content : null;
      } catch {
        return null;
      } finally {
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(true);
        }
        try {
          unlinkSync(tmpPath);
        } catch {}
      }
    });

  const render = () => {
    const frame = renderFrame(state, { cols, rows });
    deps.out(frame);
  };

  const restore = () => {
    // Terminal restore sequence: show cursor, clear raw mode
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
      } catch {}
    }
    deps.out("\u001b[?25h");
  };

  const poll = async () => {
    try {
      const scopesRes = await deps.client.get<ScopesResponse>("/scopes", {
        limit: 100,
      });
      const scopes: ScopeRow[] = (scopesRes.scopes ?? []).map((s) => ({
        id: s.id,
        title: s.title ?? "(untitled)",
        status: s.status,
      }));
      state.scopes = scopes;

      // Select first scope if none selected or selected scope deleted
      if (scopes.length > 0) {
        if (
          !state.selectedScopeId ||
          !scopes.some((s) => s.id === state.selectedScopeId)
        ) {
          state.selectedScopeId = scopes[0]!.id;
        }
      } else {
        state.selectedScopeId = null;
      }

      if (state.selectedScopeId) {
        const detail = await deps.client.get<ScopeDetailResponse>(
          `/scopes/${encodeURIComponent(state.selectedScopeId)}`,
        );

        // Map task rows and resolve latest model for each task from runs
        const runs = detail.runs ?? [];
        const taskModels: Record<string, string> = {};
        for (const r of runs) {
          if (r.task_id && r.model_id && !taskModels[r.task_id]) {
            taskModels[r.task_id] = r.model_id;
          }
        }

        const tasks: TaskRow[] = (detail.tasks ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          attempt: t.attempt,
          mrIid: t.mr_iid,
          model: taskModels[t.id] ?? null,
        }));
        state.tasks = tasks;
        if (state.selectedTaskIndex >= tasks.length) {
          state.selectedTaskIndex = Math.max(0, tasks.length - 1);
        }

        // Identify newest running run for events
        const runningRuns = runs.filter((r) => r.status === "running");
        const newestRun = runningRuns[runningRuns.length - 1] ?? null;

        if (newestRun) {
          if (activeRunId !== newestRun.id) {
            // New active run
            activeRunId = newestRun.id;
            seenEventIds.clear();
            state.feedLines = [];

            // Cursor paginate to backfill
            const history: EventPage["events"] = [];
            for await (const events of iterPages<EventPage["events"][number]>(
              async (beforeId) =>
                toCursorPage(
                  await deps.client.get<EventPage>(
                    `/runs/${encodeURIComponent(newestRun.id)}/events`,
                    { before_id: beforeId, limit: 100 },
                  ),
                ),
            )) {
              history.push(...events);
            }
            history.sort((a, b) => a.id - b.id);
            for (const ev of history) {
              if (!seenEventIds.has(ev.id)) {
                seenEventIds.add(ev.id);
                state.feedLines.push(
                  `#${ev.id} ${ev.event} ${summarize(ev.detail_json)}`.trimEnd(),
                );
              }
            }
          } else {
            // Same running run, fetch latest events
            const eventRes = await deps.client.get<EventPage>(
              `/runs/${encodeURIComponent(newestRun.id)}/events`,
              { limit: 100 },
            );
            const events = eventRes.events ?? [];
            for (const ev of events) {
              if (!seenEventIds.has(ev.id)) {
                seenEventIds.add(ev.id);
                state.feedLines.push(
                  `#${ev.id} ${ev.event} ${summarize(ev.detail_json)}`.trimEnd(),
                );
              }
            }
          }
          if (state.feedLines.length > MAX_FEED_LINES) {
            state.feedLines = state.feedLines.slice(-MAX_FEED_LINES);
          }
        }
      } else {
        state.tasks = [];
        state.feedLines = [];
        activeRunId = null;
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      state.statusLine = msg;
      state.lastAction = { ok: false, text: msg };
    }
  };

  const flattenScopes = (): ScopeRow[] => {
    // Flatten grouped order: draft, planning, active, validating, blocked, done, abandoned
    const groups = [
      "draft",
      "planning",
      "active",
      "validating",
      "blocked",
      "done",
      "abandoned",
    ];
    const res: ScopeRow[] = [];
    for (const g of groups) {
      for (const s of state.scopes) {
        if (s.status === g) res.push(s);
      }
    }
    for (const s of state.scopes) {
      if (!groups.includes(s.status)) res.push(s);
    }
    return res;
  };

  const handleKey = async (ch: string) => {
    // 1. Handle modal state first
    if (state.modal?.kind === "abandon-confirm") {
      if (ch === "y" || ch === "Y") {
        state.modal = null;
        if (state.selectedScopeId) {
          try {
            await deps.client.post(
              `/scopes/${encodeURIComponent(state.selectedScopeId)}/abandon`,
            );
            state.lastAction = {
              ok: true,
              text: `Abandoned scope ${state.selectedScopeId}`,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            state.lastAction = { ok: false, text: msg };
          }
          await poll();
        }
      } else {
        state.modal = null;
        state.lastAction = { ok: false, text: "Abandon canceled" };
      }
      render();
      return;
    }

    if (state.modal?.kind === "line-input") {
      const modal = state.modal;
      if (ch === "\r" || ch === "\n") {
        state.modal = null;
        const sha = modal.buffer.trim();
        if (!sha) {
          state.lastAction = {
            ok: false,
            text: "Merge approval canceled (empty sha)",
          };
        } else {
          const task = state.tasks[state.selectedTaskIndex];
          if (task) {
            try {
              await deps.client.post(
                `/tasks/${encodeURIComponent(task.id)}/approve-merge`,
                { sha },
              );
              state.lastAction = {
                ok: true,
                text: `Approved merge for ${task.id} at ${sha}`,
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              state.lastAction = { ok: false, text: msg };
            }
            await poll();
          }
        }
      } else if (ch === "\u001b" || ch === "\u0003") {
        // ESC or Ctrl+C to cancel modal
        state.modal = null;
        state.lastAction = { ok: false, text: "Canceled input" };
      } else if (ch === "\u007f" || ch === "\b") {
        modal.buffer = modal.buffer.slice(0, -1);
      } else if (ch.length === 1 && ch >= " ") {
        modal.buffer += ch;
      }
      render();
      return;
    }

    // 2. Standard keys
    if (ch === "q" || ch === "\u0003") {
      stop();
      return;
    }

    if (ch === "h") {
      state.focus = "scopes";
      render();
      return;
    }
    if (ch === "l") {
      state.focus = "tasks";
      render();
      return;
    }

    // Arrow keys or j/k
    const isUp = ch === "k" || ch === "\u001b[A";
    const isDown = ch === "j" || ch === "\u001b[B";

    if (isUp || isDown) {
      if (state.focus === "tasks") {
        if (state.tasks.length > 0) {
          if (isUp) {
            state.selectedTaskIndex = Math.max(0, state.selectedTaskIndex - 1);
          } else {
            state.selectedTaskIndex = Math.min(
              state.tasks.length - 1,
              state.selectedTaskIndex + 1,
            );
          }
        }
      } else {
        const flat = flattenScopes();
        if (flat.length > 0) {
          const currentIndex = flat.findIndex(
            (s) => s.id === state.selectedScopeId,
          );
          let nextIndex = currentIndex;
          if (isUp) {
            nextIndex = Math.max(0, currentIndex - 1);
          } else {
            nextIndex = Math.min(flat.length - 1, currentIndex + 1);
          }
          if (flat[nextIndex]) {
            state.selectedScopeId = flat[nextIndex]!.id;
            state.selectedTaskIndex = 0;
            await poll();
          }
        }
      }
      render();
      return;
    }

    // Actions
    if (ch === "a") {
      // Approve plan (scope-level)
      if (state.selectedScopeId) {
        try {
          await deps.client.post(
            `/scopes/${encodeURIComponent(state.selectedScopeId)}/approve-plan`,
          );
          state.lastAction = {
            ok: true,
            text: `Approved plan for ${state.selectedScopeId}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.lastAction = { ok: false, text: msg };
        }
        await poll();
      }
      render();
      return;
    }

    if (ch === "R") {
      // Replan scope
      if (state.selectedScopeId) {
        const feedback = await editorLauncher("# Enter replan feedback:\n");
        if (feedback) {
          try {
            await deps.client.post(
              `/scopes/${encodeURIComponent(state.selectedScopeId)}/replan`,
              { feedback },
            );
            state.lastAction = {
              ok: true,
              text: `Replan requested for ${state.selectedScopeId}`,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            state.lastAction = { ok: false, text: msg };
          }
          await poll();
        } else {
          state.lastAction = { ok: false, text: "Replan canceled (empty)" };
        }
      }
      render();
      return;
    }

    if (ch === "A") {
      // Abandon confirm modal
      if (state.selectedScopeId) {
        state.modal = { kind: "abandon-confirm" };
      }
      render();
      return;
    }

    // Task-level actions
    const selectedTask = state.tasks[state.selectedTaskIndex];
    if (ch === "r") {
      if (selectedTask) {
        try {
          await deps.client.post(
            `/tasks/${encodeURIComponent(selectedTask.id)}/retry`,
          );
          state.lastAction = {
            ok: true,
            text: `Retried task ${selectedTask.id}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.lastAction = { ok: false, text: msg };
        }
        await poll();
      }
      render();
      return;
    }

    if (ch === "s") {
      if (selectedTask) {
        try {
          await deps.client.post(
            `/tasks/${encodeURIComponent(selectedTask.id)}/stop`,
          );
          state.lastAction = {
            ok: true,
            text: `Stopped task ${selectedTask.id}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.lastAction = { ok: false, text: msg };
        }
        await poll();
      }
      render();
      return;
    }

    if (ch === "u") {
      if (selectedTask) {
        try {
          await deps.client.post(
            `/tasks/${encodeURIComponent(selectedTask.id)}/unblock`,
          );
          state.lastAction = {
            ok: true,
            text: `Unblocked task ${selectedTask.id}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.lastAction = { ok: false, text: msg };
        }
        await poll();
      }
      render();
      return;
    }

    if (ch === "m") {
      if (selectedTask) {
        state.modal = {
          kind: "line-input",
          prompt: `Approve merge for ${selectedTask.id} (enter commit SHA): `,
          buffer: "",
        };
      }
      render();
      return;
    }
  };

  const stop = () => {
    if (!running) return;
    running = false;
    restore();
  };

  return {
    async start() {
      running = true;

      // Set raw mode if TTY
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      const sigHandler = () => {
        stop();
        process.exit(0);
      };
      process.on("SIGINT", sigHandler);
      process.on("SIGTERM", sigHandler);

      // Setup input handling
      let buffer = "";
      const onData = (data: Buffer | string) => {
        const str = data.toString();
        buffer += str;
        while (buffer.length > 0) {
          // Check escape sequences like \u001b[A, \u001b[B
          if (buffer.startsWith("\u001b[")) {
            if (buffer.length >= 3) {
              const seq = buffer.slice(0, 3);
              buffer = buffer.slice(3);
              void handleKey(seq);
            } else {
              break; // Wait for next char
            }
          } else {
            const ch = buffer[0]!;
            buffer = buffer.slice(1);
            void handleKey(ch);
          }
        }
      };

      if (!deps.in) {
        process.stdin.on("data", onData);
      }

      try {
        // Initial poll and render
        await poll();
        render();

        while (running) {
          if (deps.in) {
            const nextKey = deps.in();
            if (nextKey !== null) {
              await handleKey(nextKey);
            }
          }
          await deps.clock.sleep(POLL_CADENCE_MS);
          if (!running) break;
          await poll();
          render();
        }
      } finally {
        process.removeListener("SIGINT", sigHandler);
        process.removeListener("SIGTERM", sigHandler);
        if (!deps.in) {
          process.stdin.removeListener("data", onData);
        }
        restore();
      }
    },
    stop,
  };
}
