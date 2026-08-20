import { readFileSync } from "node:fs";
import { Database } from "./sqlite-compat.js";

/**
 * Schema lifecycle.
 *
 * - `schema.sql` is the COMPLETE current schema. A fresh database executes it
 *   and is stamped `LATEST_SCHEMA_VERSION` directly - it never replays
 *   migrations.
 * - An existing database replays every migration above its
 *   `PRAGMA user_version`, stamping after each. Migrations run exactly once.
 *
 * Adding a schema change means BOTH:
 *   1. edit `schema.sql` so fresh databases are born current, and
 *   2. append a `Migration` here with the next version number.
 * The parity test in store.test.ts fails if the two paths diverge.
 *
 * A migration is responsible for its own atomicity: single-statement
 * migrations are atomic already; multi-statement ones should use their own
 * transaction unless they must toggle `PRAGMA foreign_keys`, which is a no-op
 * inside a transaction.
 */

export const SCHEMA_SQL = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);

type Db = InstanceType<typeof Database>;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly apply: (db: Db) => void;
}

/** Idempotent ADD COLUMN for databases created before a column existed. */
function addColumn(db: Db, table: string, name: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN "${name}" ${type}`);
}

/**
 * Rebuild `table` from the current schema.sql DDL when its CHECK constraints
 * predate `needle` (a quoted enum value). SQLite cannot alter a CHECK in
 * place; this is the documented create-copy-drop-rename dance, FK-safe
 * because the final rename restores the name dependent tables reference.
 */
function rebuildForCheck(db: Db, table: string, needle: string): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  if (!row || row.sql.includes(`'${needle}'`)) return;

  const ddlMatch = SCHEMA_SQL.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`),
  );
  if (!ddlMatch) throw new Error(`${table} DDL not found in schema.sql`);
  const newDdl = ddlMatch[0].replace(
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    `CREATE TABLE ${table}_new (`,
  );

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(newDdl);
      const oldCols = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        dflt_value: string | null;
      }[];
      const newCols = new Set(
        (
          db.prepare(`PRAGMA table_info(${table}_new)`).all() as {
            name: string;
          }[]
        ).map((c) => c.name),
      );
      // Carry over columns the rebuilt DDL lacks (none once schema.sql is
      // kept complete, but a mid-flight legacy DB may surprise us).
      for (const col of oldCols) {
        if (newCols.has(col.name)) continue;
        const dflt =
          col.dflt_value === null ? "" : ` DEFAULT ${col.dflt_value}`;
        db.exec(
          `ALTER TABLE ${table}_new ADD COLUMN "${col.name}" ${col.type || "TEXT"}${dflt}`,
        );
      }
      const colList = oldCols.map((c) => `"${c.name}"`).join(", ");
      db.exec(
        `INSERT INTO ${table}_new (${colList}) SELECT ${colList} FROM ${table}`,
      );
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    })();
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `${table} rebuild broke foreign keys: ${JSON.stringify(violations[0])}`,
      );
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Every database that predates versioned migrations, reconciled by
 * inspection: columns added over the daemon's life, two CHECK-constraint
 * generations, and the short-lived `initiative` column. Runs once; new
 * schema changes get their own numbered migration, never edits here.
 */
function legacyReconcile(db: Db): void {
  // Pre-versioning daemons executed schema.sql on every boot, so auxiliary
  // tables (audit, run_events, ...) may be missing on the oldest DBs.
  // Everything is IF NOT EXISTS; existing tables are untouched.
  db.exec(SCHEMA_SQL);
  addColumn(db, "runs", "token_id", "TEXT");
  addColumn(db, "runs", "model_id", "TEXT");
  addColumn(db, "scopes", "title", "TEXT");
  addColumn(db, "scopes", "approvals", "TEXT NOT NULL DEFAULT 'auto'");
  addColumn(db, "tasks", "merge_approved_sha", "TEXT");
  addColumn(db, "scopes", "plan_feedback", "TEXT");
  addColumn(db, "tasks", "human_feedback", "TEXT");
  addColumn(db, "scopes", "acceptance_json", "TEXT");
  const scopeCols = db.prepare(`PRAGMA table_info(scopes)`).all() as {
    name: string;
  }[];
  if (scopeCols.some((c) => c.name === "initiative")) {
    db.exec(`ALTER TABLE scopes RENAME COLUMN initiative TO "group"`);
  } else {
    addColumn(db, "scopes", "group", "TEXT");
  }
  rebuildForCheck(db, "scopes", "validating");
  rebuildForCheck(db, "runs", "validate");
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "legacy-reconcile", apply: legacyReconcile },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Bring `db` to the current schema. Called once per open, before any query. */
export function migrate(db: Db): void {
  const { user_version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'`)
    .get();
  if (!exists) {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    return;
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= user_version) continue;
    migration.apply(db);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
}
