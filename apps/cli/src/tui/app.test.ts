import { describe, expect, it } from "bun:test";
import { createTuiApp, type TuiClock } from "./app.js";
import { ApiError, type ColonyClient } from "../client.js";

class FakeClock implements TuiClock {
  currentTime = 1000;
  sleepCalls: number[] = [];

  now(): number {
    return this.currentTime;
  }

  async sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms);
    this.currentTime += ms;
  }
}

describe("createTuiApp", () => {
  it("polls >=3 cycles, fetches detail and events, and appends feed lines", async () => {
    const clock = new FakeClock();
    const calls: { method: string; path: string; query?: unknown }[] = [];
    const outWrites: string[] = [];

    let eventCycle = 1;

    const fakeClient: ColonyClient = {
      baseUrl: "http://localhost:4000",
      async get<T>(
        path: string,
        query?: Record<string, string | number | undefined>,
      ): Promise<T> {
        calls.push({ method: "GET", path, query });
        if (path === "/scopes") {
          return {
            scopes: [{ id: "col-1", title: "Scope 1", status: "active" }],
          } as unknown as T;
        }
        if (path === "/scopes/col-1") {
          return {
            scope: { id: "col-1", title: "Scope 1", status: "active" },
            tasks: [
              {
                id: "task-1",
                title: "Task 1",
                state: "running",
                attempt: 1,
                mr_iid: null,
              },
            ],
            runs: [
              {
                id: "run-1",
                kind: "implement",
                task_id: "task-1",
                model_id: "sonnet",
                status: "running",
                started_at: "2026-09-02T00:00:00Z",
                finished_at: null,
              },
            ],
          } as unknown as T;
        }
        if (path === "/runs/run-1/events") {
          if (eventCycle === 1) {
            return {
              events: [
                {
                  id: 1,
                  run_id: "run-1",
                  at: "2026-09-02T00:00:01Z",
                  event: "started",
                  detail_json: "{}",
                },
              ],
              has_more: false,
              oldest_id: 1,
              newest_id: 1,
            } as unknown as T;
          } else {
            return {
              events: [
                {
                  id: 2,
                  run_id: "run-1",
                  at: "2026-09-02T00:00:02Z",
                  event: "progress",
                  detail_json: '{"step":1}',
                },
              ],
              has_more: false,
              oldest_id: 2,
              newest_id: 2,
            } as unknown as T;
          }
        }
        throw new Error(`Unhandled get ${path}`);
      },
      async post<T>(_path: string, _body?: unknown): Promise<T> {
        throw new Error("Unhandled post");
      },
      async put<T>(_path: string, _body?: unknown): Promise<T> {
        throw new Error("Unhandled put");
      },
      async raw(_path: string): Promise<Response> {
        throw new Error("Unhandled raw");
      },
    };

    let cycles = 0;
    const inputs = [null, null, null, "q"];
    const inputFn = () => {
      cycles++;
      if (cycles === 2) eventCycle = 2;
      return inputs.shift() ?? null;
    };

    const app = createTuiApp({
      client: fakeClient,
      clock,
      out: (s) => outWrites.push(s),
      in: inputFn,
      cols: 80,
      rows: 24,
    });

    await app.start();

    // Verify polls hit GET /scopes, /scopes/col-1, and /runs/run-1/events
    expect(calls.some((c) => c.path === "/scopes")).toBe(true);
    expect(calls.some((c) => c.path === "/scopes/col-1")).toBe(true);
    expect(calls.some((c) => c.path === "/runs/run-1/events")).toBe(true);

    // Verify sleep was called at 1500 ms cadence >= 3 times
    expect(clock.sleepCalls.length).toBeGreaterThanOrEqual(3);
    expect(clock.sleepCalls[0]).toBe(1500);

    // Verify the latest frame output contains event #2
    const lastFrame =
      outWrites.filter((s) => s.includes("\u001b[2J")).pop() ?? "";
    expect(lastFrame).toContain("#2 progress");

    // Verify restore sequence written
    expect(outWrites).toContain("\u001b[?25h");
  });

  it("handles ApiError during poll without crashing and surfaces error in status", async () => {
    const clock = new FakeClock();
    let pollCount = 0;
    const outWrites: string[] = [];

    const fakeClient: ColonyClient = {
      baseUrl: "http://localhost:4000",
      async get<T>(path: string): Promise<T> {
        pollCount++;
        if (pollCount === 1) {
          throw new ApiError(500, "INTERNAL_ERROR", "Server exploded");
        }
        return { scopes: [] } as unknown as T;
      },
      async post<T>(): Promise<T> {
        throw new Error("post");
      },
      async put<T>(): Promise<T> {
        throw new Error("put");
      },
      async raw(): Promise<Response> {
        throw new Error("raw");
      },
    };

    let inputs = [null, "q"];
    const app = createTuiApp({
      client: fakeClient,
      clock,
      out: (s) => outWrites.push(s),
      in: () => inputs.shift() ?? null,
      cols: 80,
      rows: 24,
    });

    await app.start();

    const frames = outWrites.filter((s) => s.includes("\u001b[2J"));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toContain("INTERNAL_ERROR: Server exploded");
  });

  it("handles action keys: approve 'a', abandon modal 'A'/'n', retry 'r'", async () => {
    const clock = new FakeClock();
    const postCalls: { path: string; body?: unknown }[] = [];

    const fakeClient: ColonyClient = {
      baseUrl: "http://localhost:4000",
      async get<T>(path: string): Promise<T> {
        if (path === "/scopes") {
          return {
            scopes: [
              { id: "col-plan", title: "Planning Scope", status: "planning" },
            ],
          } as unknown as T;
        }
        if (path === "/scopes/col-plan") {
          return {
            scope: {
              id: "col-plan",
              title: "Planning Scope",
              status: "planning",
            },
            tasks: [
              {
                id: "task-10",
                title: "Task 10",
                state: "failed",
                attempt: 1,
                mr_iid: null,
              },
            ],
            runs: [],
          } as unknown as T;
        }
        throw new Error(`get ${path}`);
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        postCalls.push({ path, body });
        return {} as unknown as T;
      },
      async put<T>(): Promise<T> {
        throw new Error("put");
      },
      async raw(): Promise<Response> {
        throw new Error("raw");
      },
    };

    // Sequence of key presses:
    // 1. 'a' -> approve-plan
    // 2. 'A' -> open abandon modal
    // 3. 'n' -> cancel modal (no abandon POST)
    // 4. 'l' -> switch focus to tasks
    // 5. 'r' -> retry task-10
    // 6. 'q' -> quit
    const inputs = ["a", "A", "n", "l", "r", "q"];
    const outWrites: string[] = [];

    const app = createTuiApp({
      client: fakeClient,
      clock,
      out: (s) => outWrites.push(s),
      in: () => inputs.shift() ?? null,
      cols: 80,
      rows: 24,
    });

    await app.start();

    // Verify POST calls
    expect(postCalls).toEqual([
      { path: "/scopes/col-plan/approve-plan", body: undefined },
      { path: "/tasks/task-10/retry", body: undefined },
    ]);
  });
});
