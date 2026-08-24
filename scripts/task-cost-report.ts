#!/usr/bin/env bun
/**
 * Validate the files-touched vs session-wall-clock heuristic against a live
 * colonyd database, offline from the runs table alone.
 *
 *   COLONYD_DB_PATH=/var/lib/colonyd/colonyd.db bun run scripts/task-cost-report.ts
 *
 * Prints the usable sample count, the median ms-per-file across landed
 * attempts, and the file-count threshold implied by the implementer budget.
 * Exits non-zero when COLONYD_DB_PATH is unset.
 */
import {
  DEFAULT_IMPLEMENTER_BUDGET_MS,
  buildTaskCostModel,
} from "../packages/core/src/index.js";
import { Database } from "../packages/core/src/sqlite-compat.js";
import type { Run } from "../packages/core/src/store.js";

const dbPath = process.env.COLONYD_DB_PATH;
if (!dbPath) {
  console.error(
    "COLONYD_DB_PATH is required: point it at the colonyd SQLite database to analyze.\n" +
      "  COLONYD_DB_PATH=... bun run scripts/task-cost-report.ts",
  );
  process.exit(1);
}

const db = new Database(dbPath as string, { readOnly: true });
try {
  const runs = db
    .prepare(
      `SELECT * FROM runs WHERE status = 'succeeded' AND kind IN ('implement','merge_gate')`,
    )
    .all() as Run[];
  const model = buildTaskCostModel(runs);
  const thresholdFiles =
    model.ms_per_file > 0
      ? Math.floor(DEFAULT_IMPLEMENTER_BUDGET_MS / model.ms_per_file)
      : null;

  console.log(`database: ${dbPath}`);
  console.log(
    `samples (succeeded implement x merge-gate evidence): ${model.sample_size}`,
  );
  console.log(`median ms per touched file: ${model.ms_per_file.toFixed(0)}`);
  if (thresholdFiles === null) {
    console.log(
      `budget ${DEFAULT_IMPLEMENTER_BUDGET_MS} ms: no threshold yet (no samples or zero median)`,
    );
  } else {
    console.log(
      `budget ${DEFAULT_IMPLEMENTER_BUDGET_MS} ms implies ~${thresholdFiles} files per task before flagging`,
    );
  }
} finally {
  db.close();
}
