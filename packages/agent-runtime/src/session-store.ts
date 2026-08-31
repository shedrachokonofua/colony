import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { FileSessionStorage, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type {
  SessionStorage,
  SessionStorageStat,
  WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

/**
 * Durable per-run session storage backed by the SDK's own file journal.
 *
 * The SDK's factories mint `<timestamp>_<id>.jsonl` names inside a session
 * dir, so a restart cannot find a run's transcript before knowing the
 * generated session id. Colony pins the path instead: every file the
 * manager touches is canonicalized onto `<dataDir>/sessions/<run_id>/session.jsonl`
 * at the `SessionStorage` seam — the same seam the SDK's Redis/SQL backends
 * extend. All publish semantics (atomic rewrites, the fixed-width title slot,
 * append writers) stay in the inherited `FileSessionStorage`.
 */

/** Per-run JSONL path: `<dataDir>/sessions/<run_id>/session.jsonl`. */
export function sessionFilePath(dataDir: string, runId: string): string {
  return join(resolve(dataDir), "sessions", runId, "session.jsonl");
}

/** Per-run session directory (holds the JSONL and its artifact sidecars). */
export function sessionRunDir(dataDir: string, runId: string): string {
  return dirname(sessionFilePath(dataDir, runId));
}

/**
 * A `FileSessionStorage` that folds every path the manager asks for onto one
 * pinned file. Path arguments are never interpreted: whatever internal name
 * the SDK mints, reads, writes, and renames land on the run's own file.
 */
class RunScopedSessionStorage extends FileSessionStorage {
  constructor(private readonly filePath: string) {
    super();
  }

  override ensureDirSync(): void {
    super.ensureDirSync(dirname(this.filePath));
  }

  override existsSync(): boolean {
    return super.existsSync(this.filePath);
  }

  override writeTextSync(_path: string, content: string): void {
    super.writeTextSync(this.filePath, content);
  }

  override async updateSessionTitle(
    _path: string,
    update: SessionTitleUpdate,
  ): Promise<void> {
    await super.updateSessionTitle(this.filePath, update);
  }

  override statSync(_path: string): SessionStorageStat {
    return super.statSync(this.filePath);
  }

  override listFilesSync(_dir: string, pattern: string): string[] {
    if (!super.existsSync(this.filePath)) return [];
    return new Bun.Glob(pattern).match(basename(this.filePath))
      ? [this.filePath]
      : [];
  }

  override async exists(): Promise<boolean> {
    return super.existsSync(this.filePath);
  }

  override async readText(): Promise<string> {
    return readFileSync(this.filePath, "utf8");
  }

  override async readTextSlices(
    _path: string,
    prefixBytes: number,
    suffixBytes: number,
  ): Promise<[string, string]> {
    const body = readFileSync(this.filePath);
    const prefix = body.subarray(0, Math.min(prefixBytes, body.length));
    const suffix =
      suffixBytes > 0
        ? body.subarray(Math.max(0, body.length - suffixBytes))
        : body.subarray(body.length);
    return [prefix.toString("utf8"), suffix.toString("utf8")];
  }

  override async writeText(_path: string, content: string): Promise<void> {
    await super.writeText(this.filePath, content);
  }

  override async writeTextAtomic(
    _path: string,
    content: string,
    options?: WriteTextAtomicOptions,
  ): Promise<void> {
    await super.writeTextAtomic(this.filePath, content, options);
  }

  override async rename(_path: string, _nextPath: string): Promise<void> {
    // Both endpoints canonicalize onto the one run file: nothing to move.
  }

  override async unlink(_path: string): Promise<void> {
    try {
      unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }

  override async deleteSessionWithArtifacts(
    sessionPath: string,
  ): Promise<void> {
    await this.unlink(sessionPath);
  }
}

/**
 * Create the durable session manager for one run. All of the run's session
 * state lands in `<dataDir>/sessions/<run_id>/session.jsonl` on the colonyd
 * volume — never the OS temp dir. If that file already holds a session
 * (daemon restart mid-run), the manager resumes it; otherwise a fresh session
 * starts, still written to the same pinned path.
 */
export async function createFileSessionManager(
  dataDir: string,
  runId: string,
  cwd?: string,
): Promise<SessionManager> {
  const file = sessionFilePath(dataDir, runId);
  mkdirSync(dirname(file), { recursive: true });
  // open() on a missing file starts a fresh session kept at that exact path;
  // create() cannot be used because it always mints a new timestamped name
  // and never resumes the run's existing journal.
  return SessionManager.open(
    file,
    undefined,
    new RunScopedSessionStorage(file),
    { initialCwd: cwd ?? dirname(file) },
  );
}

/**
 * Inspect a run's session JSONL without parsing the whole journal: `ok` only
 * when the file exists and its first line parses as a JSON object (the
 * header/title slot); `entries` counts the non-empty JSONL lines.
 */
export function readSessionHeader(
  dataDir: string,
  runId: string,
): { ok: boolean; entries: number } {
  let body: string;
  try {
    body = readFileSync(sessionFilePath(dataDir, runId), "utf8");
  } catch {
    return { ok: false, entries: 0 };
  }
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (first === undefined) return { ok: false, entries: 0 };
  try {
    const header = JSON.parse(first) as unknown;
    if (
      typeof header !== "object" ||
      header === null ||
      Array.isArray(header)
    ) {
      return { ok: false, entries: 0 };
    }
  } catch {
    return { ok: false, entries: 0 };
  }
  return { ok: true, entries: lines.length };
}
