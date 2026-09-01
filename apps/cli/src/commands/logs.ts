import { ApiError, type ColonyClient } from "../client.js";
import type { ParsedCommand } from "../args.js";
import { iterPages, toCursorPage } from "../cursor.js";
import type { RunDetail } from "./run.js";

export interface RunEvent {
  id: number;
  run_id: string;
  at: string;
  event: string;
  detail_json: string;
}

interface EventPage {
  events: RunEvent[];
  has_more: boolean;
  oldest_id: number | null;
  newest_id: number | null;
}

export const POLL_INTERVAL_MS = 2000;

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export interface LogsIo {
  json: boolean;
  isTty: boolean;
  /** Injected so tests drive polling without real waiting. */
  sleep?: Sleep;
}

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: LogsIo,
): Promise<number> {
  const id = cmd.positional[0];
  const follow = cmd.flags.follow === true || cmd.flags.f === true;
  const sleep = io.sleep ?? defaultSleep;

  const seen = new Set<number>();
  let lastId = 0;

  const print = (events: RunEvent[]): void => {
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (event.id > lastId) lastId = event.id;
      if (io.json) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        process.stdout.write(
          `#${event.id} ${event.event} ${summarize(event.detail_json)}\n`,
        );
      }
    }
  };

  if (follow) {
    // Replay the run's history oldest-first through the cursor helper, so -f
    // opens on the whole backlog instead of just the newest window.
    const history: RunEvent[] = [];
    for await (const events of iterPages<RunEvent>(async (beforeId) =>
      toCursorPage(
        await client.get<EventPage>(`/runs/${encodeURIComponent(id)}/events`, {
          before_id: beforeId,
          limit: 100,
        }),
      ),
    )) {
      history.push(...events);
    }
    history.sort((a, b) => a.id - b.id);
    print(history);
  } else {
    const first = await client.get<EventPage>(
      `/runs/${encodeURIComponent(id)}/events`,
      { limit: 100 },
    );
    print(first.events);
    return 0;
  }

  for (;;) {
    const status = await client.get<RunDetail>(
      `/runs/${encodeURIComponent(id)}`,
    );
    if (status.status !== "running") return 0;
    await sleep(POLL_INTERVAL_MS);
    let res: EventPage;
    try {
      res = await client.get<EventPage>(
        `/runs/${encodeURIComponent(id)}/events`,
        { limit: 100 },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        process.stderr.write(`logs: ${err.message}; retrying\n`);
        continue;
      }
      throw err;
    }
    print(res.events.filter((event) => event.id > lastId));
  }
}

export function summarize(detailJson: string): string {
  if (!detailJson) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailJson);
  } catch {
    return detailJson;
  }
  if (typeof parsed !== "object" || parsed === null) return String(parsed);
  const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 3);
  return entries.map(([key, value]) => `${key}=${brief(value)}`).join(" ");
}

function brief(value: unknown): string {
  if (typeof value === "string")
    return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  if (value === null || typeof value !== "object") return String(value);
  const json = JSON.stringify(value);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
}
