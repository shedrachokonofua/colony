import { createRequire } from "node:module";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type SQLQueryBindings =
  | string
  | number
  | bigint
  | Buffer
  | Uint8Array
  | null
  | undefined;

/** Open options: `readOnly` refuses to create or mutate the database file. */
export interface DatabaseOptions {
  readonly readOnly?: boolean;
}

// Resolve Database implementation at runtime: bun:sqlite when running under
// Bun (e.g. `bun test`), node:sqlite when running under Node+tsx (Playwright
// webServer: `npx tsx apps/colonyd/e2e/fake-colonyd.ts`).
let DatabaseImpl: unknown;

try {
  const bunSqlite = createRequire(import.meta.url)("bun:sqlite");
  const BunSqliteDatabase = bunSqlite.Database as new (
    path: string,
    options?: { readonly?: boolean },
  ) => unknown;
  // `new Fn(...)` returning an object passes the instance through, keeping
  // the full bun:sqlite surface while normalizing the open options.
  DatabaseImpl = function bunDatabase(path: string, options?: DatabaseOptions) {
    return options?.readOnly
      ? new BunSqliteDatabase(path, { readonly: true })
      : new BunSqliteDatabase(path);
  };
} catch {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: Record<string, unknown>,
    ) => unknown;
  };

  function extractNamedParams(sql: string): Set<string> {
    const set = new Set<string>();
    for (const m of sql.matchAll(/[@$:]([a-zA-Z0-9_]+)/g)) set.add(m[1]);
    return set;
  }

  function filterNamedParams(sql: string, arg: unknown): unknown {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
    const obj = arg as Record<string, unknown>;
    const placeholderNames = extractNamedParams(sql);
    if (placeholderNames.size === 0) {
      // SQL has no named placeholders — passing any named object would throw
      // "Unknown named parameter". Return undefined so node:sqlite treats it
      // as no bindings rather than an unknown binding.
      const hasAtKeys = Object.keys(obj).some((k) => k.startsWith("@"));
      const hasNamedKeys = Object.keys(obj).length > 0;
      if (hasAtKeys || hasNamedKeys) {
        // If the caller passed named bindings but SQL expects none, drop them.
        // Callers that pass positional args will not hit this path.
        return undefined;
      }
      return arg;
    }
    // Bun callers prefix keys with `@` via named() helper; node:sqlite accepts
    // both bare and `@`-prefixed keys. Filter to only placeholders present in SQL
    // so extra keys (e.g. listAudit passing both scopeId and taskId when only
    // one is used) do not throw.
    const filtered: Record<string, unknown> = {};
    let kept = 0;
    for (const [k, v] of Object.entries(obj)) {
      const bare =
        k.startsWith("@") || k.startsWith(":") || k.startsWith("$")
          ? k.slice(1)
          : k;
      if (placeholderNames.has(bare)) {
        filtered[k] = v;
        kept++;
      } else if (placeholderNames.has(k)) {
        filtered[k] = v;
        kept++;
      }
    }
    // If none of the keys matched but the object looks like positional args
    // (numeric keys), return original.
    if (kept === 0 && placeholderNames.size > 0) {
      // No overlap — maybe the caller used bare keys without @.
      // Try mapping bare keys to filtered.
      return filtered;
    }
    // If filtered removed extras, return filtered; if empty and SQL expects none
    // the caller will get undefined behaviour, so return undefined to mean no bind.
    if (
      kept === 0 &&
      Object.keys(obj).length > 0 &&
      placeholderNames.size === 0
    ) {
      return undefined;
    }
    return kept > 0 || Object.keys(obj).length === 0 ? filtered : obj;
  }

  class NodeDatabase {
    private readonly inner: InstanceType<typeof DatabaseSync>;

    constructor(path: string, options: DatabaseOptions = {}) {
      if (options.readOnly) {
        // Read-only opens must never create the file.
        this.inner = new DatabaseSync(path, {
          readOnly: true,
        }) as InstanceType<typeof DatabaseSync>;
        return;
      }
      // Store constructor already ensures the parent dir exists; be defensive.
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        // ignore
      }
      // node:sqlite DatabaseSync creates the file if it does not exist.
      this.inner = new DatabaseSync(path) as InstanceType<typeof DatabaseSync>;
    }

    exec(sql: string): void {
      (this.inner as { exec: (s: string) => void }).exec(sql);
    }

    prepare(sql: string): {
      run: (...args: unknown[]) => {
        changes: number;
        lastInsertRowid: unknown;
      };
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    } {
      const stmt = (
        this.inner as {
          prepare: (s: string) => {
            run: (...a: unknown[]) => {
              changes: number;
              lastInsertRowid: unknown;
            };
            get: (...a: unknown[]) => unknown;
            all: (...a: unknown[]) => unknown[];
          };
        }
      ).prepare(sql);
      return {
        run: (...args: unknown[]) => {
          if (args.length === 1) {
            const filtered = filterNamedParams(sql, args[0]);
            if (filtered === undefined) return stmt.run();
            return stmt.run(filtered as never);
          }
          return stmt.run(...args);
        },
        get: (...args: unknown[]) => {
          if (args.length === 1) {
            const filtered = filterNamedParams(sql, args[0]);
            if (filtered === undefined) return stmt.get();
            return stmt.get(filtered as never);
          }
          return stmt.get(...args);
        },
        all: (...args: unknown[]) => {
          if (args.length === 1) {
            const filtered = filterNamedParams(sql, args[0]);
            if (filtered === undefined) return stmt.all();
            return stmt.all(filtered as never);
          }
          if (args.length === 0) return stmt.all();
          return stmt.all(...args);
        },
      };
    }

    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
      const db = this.inner as { exec: (s: string) => void };
      const wrapped = (...args: unknown[]): unknown => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = (fn as (...a: unknown[]) => unknown)(...args);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // ignore rollback errors
          }
          throw err;
        }
      };
      return wrapped as unknown as T;
    }

    close(): void {
      (this.inner as { close: () => void }).close();
    }
  }

  DatabaseImpl = NodeDatabase;
}

export const Database = DatabaseImpl as new (
  path: string,
  options?: DatabaseOptions,
) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number; lastInsertRowid: unknown };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
  close(): void;
};
