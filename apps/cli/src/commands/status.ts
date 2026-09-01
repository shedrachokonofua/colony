import { ApiError } from "../client.js";
import type { ColonyClient } from "../client.js";
import type { ParsedCommand } from "../args.js";
import {
  formatDuration,
  runDurationMs,
} from "../../../../packages/console/duration.js";
import { ansi, renderTable } from "../render.js";
import { statusCode, type ScopeRow } from "./scopes.js";
import type { RunsRow } from "./scope.js";

const SCOPE_STATUSES = [
  "draft",
  "planning",
  "active",
  "validating",
  "blocked",
  "done",
  "abandoned",
] as const;

/** At most 6 requests: health, ready, scopes, then one detail per active scope. */
const MAX_ACTIVE_SCOPES = 3;

export async function run(
  _cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const [health, ready, scopes] = await Promise.all([
    client.get<{ ok: boolean; service: string }>("/health"),
    readyState(client),
    client.get<{ scopes: ScopeRow[]; total: number }>("/scopes", {
      limit: 100,
      offset: 0,
    }),
  ]);

  const active = scopes.scopes
    .filter((scope) => scope.status === "active")
    .slice(0, MAX_ACTIVE_SCOPES);
  const running = await Promise.all(
    active.map(async (scope) => ({
      scope,
      runs: (
        await client.get<{ runs: RunsRow[] }>(
          `/scopes/${encodeURIComponent(scope.id)}`,
        )
      ).runs,
    })),
  );

  if (io.json) {
    process.stdout.write(
      `${JSON.stringify({ health, ready, scopes: scopes.scopes, running }, null, 2)}\n`,
    );
    return 0;
  }

  const tally = new Map<string, number>(SCOPE_STATUSES.map((s) => [s, 0]));
  for (const scope of scopes.scopes) {
    tally.set(scope.status, (tally.get(scope.status) ?? 0) + 1);
  }

  process.stdout.write(
    `server ${client.baseUrl}: health=${health.ok ? "ok" : "down"} ready=${ready.ok ? "yes" : "no (draining)"}\n`,
  );
  process.stdout.write(
    `${renderTable(
      ["status", "count"],
      SCOPE_STATUSES.map((s) => [
        ansi(io.isTty, statusCode(s), s),
        String(tally.get(s) ?? 0),
      ]),
    )}\n`,
  );

  const now = Date.now();
  const rows = running.flatMap(({ scope, runs }) =>
    runs
      .filter((r) => r.status === "running")
      .map((r) => {
        const ms = runDurationMs(r, now);
        return [
          r.id,
          scope.id,
          r.kind,
          r.model_id ?? "-",
          ms === null ? "-" : formatDuration(ms),
        ];
      }),
  );
  if (rows.length === 0) {
    process.stdout.write("\nno running runs\n");
    return 0;
  }
  process.stdout.write("\n");
  process.stdout.write(
    `${renderTable(["run", "scope", "kind", "model", "age"], rows)}\n`,
  );
  return 0;
}

/** /ready answers 503 while colonyd drains: not-ready, not a crash. */
async function readyState(client: ColonyClient): Promise<{ ok: boolean }> {
  try {
    return await client.get<{ ok: boolean }>("/ready");
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) return { ok: false };
    throw err;
  }
}
