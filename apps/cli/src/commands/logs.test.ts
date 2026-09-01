import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args.js";
import {
  captureStdout,
  fakeClient,
  parseJsonOut,
  type Responder,
} from "../fakes.js";
import { run, type RunEvent } from "./logs.js";

const IO = { json: false, isTty: false, sleep: async () => {} };

function event(id: number, name: string, detail: unknown): RunEvent {
  return {
    id,
    run_id: "x",
    at: "2026-08-30T10:00:00.000Z",
    event: name,
    detail_json: JSON.stringify(detail),
  };
}

interface EventPageFixture {
  events: RunEvent[];
  has_more: boolean;
  oldest_id: number | null;
  newest_id: number | null;
}

/** One events page: `oldest` is the cursor for the next older page. */
function page(
  events: RunEvent[],
  has_more: boolean,
  oldest: number | null,
): EventPageFixture {
  return {
    events,
    has_more,
    oldest_id: oldest,
    newest_id: events.at(-1)?.id ?? null,
  };
}

/** Serve events page N for call N, recording the query each call carried. */
function pagedEvents(pages: EventPageFixture[]): {
  responder: Responder;
  queries: (Record<string, string | number | undefined> | undefined)[];
} {
  const queries: (Record<string, string | number | undefined> | undefined)[] =
    [];
  const responder: Responder = (call) => {
    queries.push(call.query);
    const page = pages[queries.length - 1];
    if (!page) throw new Error("events endpoint called too many times");
    return structuredClone(page);
  };
  return { responder, queries };
}

/** Answer `GET /runs/x` with the next status in the list, one per poll. */
function runProgression(statuses: string[]): {
  responder: Responder;
  polls: () => number;
} {
  let polls = 0;
  return {
    polls: () => polls,
    responder: () => {
      const status = statuses[polls];
      polls += 1;
      if (status === undefined)
        throw new Error("run endpoint polled too many times");
      return {
        id: "x",
        scope_id: "col-1",
        task_id: "t-1",
        kind: "code",
        model_id: "claude-opus-4",
        status,
        started_at: "2026-08-30T10:00:00.000Z",
        finished_at: null,
      };
    },
  };
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("logs", () => {
  it("fetches only the first events page and prints #id summary rows", async () => {
    const { responder, queries } = pagedEvents([
      {
        events: [
          event(3, "log", { line: "world" }),
          event(4, "run.finished", { ok: true }),
        ],
        has_more: true,
        oldest_id: 3,
        newest_id: 4,
      },
    ]);
    const { client, calls } = fakeClient({ "get /runs/x/events": responder });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["logs", "x"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    // One request: no backfill walk even though has_more was true.
    expect(calls.map((call) => call.path)).toEqual(["/runs/x/events"]);
    expect(queries[0]!.before_id).toBeUndefined();
    expect(queries[0]!.limit).toBe(100);
    expect(lines(out.text())).toEqual([
      "#3 log line=world",
      "#4 run.finished ok=true",
    ]);
  });

  it("asks for 100 events per page", async () => {
    const { responder } = pagedEvents([
      {
        events: [event(1, "log", {})],
        has_more: false,
        oldest_id: 1,
        newest_id: 1,
      },
    ]);
    const { client, calls } = fakeClient({ "get /runs/x/events": responder });
    const out = captureStdout();
    try {
      await run(parseArgs(["logs", "x"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toEqual({ before_id: undefined, limit: 100 });
    expect(calls[0]!.query!.limit).toBe(100);
  });

  it("follows without duplicating rows and stops once the run is no longer running", async () => {
    const { responder: eventsResponder, queries } = pagedEvents([
      // First page: nothing recorded yet.
      { events: [], has_more: false, oldest_id: null, newest_id: null },
      {
        events: [event(1, "log", { line: "a" })],
        has_more: false,
        oldest_id: 1,
        newest_id: 1,
      },
      // The server re-serves an event the previous poll already printed.
      {
        events: [
          event(2, "log", { line: "b" }),
          event(3, "log", { line: "c" }),
        ],
        has_more: false,
        oldest_id: 2,
        newest_id: 3,
      },
      {
        events: [event(3, "log", { line: "c" })],
        has_more: false,
        oldest_id: 3,
        newest_id: 3,
      },
    ]);
    const progression = runProgression([
      "running",
      "running",
      "running",
      "succeeded",
    ]);
    const { client, calls } = fakeClient({
      "get /runs/x/events": eventsResponder,
      "get /runs/x": progression.responder,
    });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["logs", "x", "-f"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    // One first page plus one page per poll; polling stops on "succeeded".
    expect(queries).toHaveLength(4);
    expect(progression.polls()).toBe(4);
    expect(calls.filter((call) => call.path === "/runs/x/events")).toHaveLength(
      4,
    );
    const printed = lines(out.text());
    expect(printed).toEqual([
      "#1 log line=a",
      "#2 log line=b",
      "#3 log line=c",
    ]);
    expect(new Set(printed).size).toBe(printed.length);
  });

  it("backfills older pages with the cursor helper before following", async () => {
    const queries: (Record<string, string | number | undefined> | undefined)[] =
      [];
    const responder: Responder = (call) => {
      queries.push(call.query);
      const before = call.query?.before_id;
      if (before === undefined)
        return page(
          [event(10, "log", { line: "j" }), event(11, "log", { line: "k" })],
          true,
          10,
        );
      if (before === 10)
        return page(
          [event(7, "log", { line: "g" }), event(8, "log", { line: "h" })],
          true,
          7,
        );
      if (before === 7)
        return page(
          [event(5, "log", { line: "e" }), event(6, "log", { line: "f" })],
          false,
          5,
        );
      throw new Error(`unexpected before_id ${String(before)}`);
    };
    const { client } = fakeClient({
      "get /runs/x/events": responder,
      "get /runs/x": runProgression(["succeeded"]).responder,
    });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["logs", "x", "-f"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    // The cursor walks backwards from the first page's oldest id until a page
    // reports has_more false.
    expect(queries.map((query) => query?.before_id)).toEqual([
      undefined,
      10,
      7,
    ]);
    // History prints oldest-first, so the stream reads chronologically.
    expect(lines(out.text())).toEqual([
      "#5 log line=e",
      "#6 log line=f",
      "#7 log line=g",
      "#8 log line=h",
      "#10 log line=j",
      "#11 log line=k",
    ]);
  });

  it("prints event objects as JSON lines with --json", async () => {
    const { responder } = pagedEvents([
      {
        events: [
          event(3, "run.started", { task: "ship" }),
          event(4, "log", { line: "hello" }),
        ],
        has_more: true,
        oldest_id: 3,
        newest_id: 4,
      },
    ]);
    const { client } = fakeClient({ "get /runs/x/events": responder });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["logs", "x", "--json"]), client, {
        ...IO,
        json: true,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    const parsed = lines(out.text()).map(
      (line) =>
        parseJsonOut(line) as {
          id: number;
          event: string;
          detail_json: string;
        },
    );
    expect(parsed.map((row) => row.id)).toEqual([3, 4]);
    expect(parsed[1]!.event).toBe("log");
    expect(JSON.parse(parsed[1]!.detail_json)).toEqual({ line: "hello" });
  });
});
