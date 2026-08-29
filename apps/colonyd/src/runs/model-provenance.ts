import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunEvent } from "@colony/core";

/**
 * Model provenance for Colony-authored Git history.
 *
 * Every implementation commit on a Colony task branch carries a canonical
 * `Colony-Models:` Git trailer listing the stable, sorted, deduplicated model
 * IDs actually used by the implement runs that contributed to that branch —
 * including model-fallback destinations recorded in run events. The merge
 * commit message carries an aggregate role-qualified line
 * (`architect=...; implement=...; review=...`). One boring parser/formatter
 * is shared by the branch-amend and merge paths so both stay byte-identical.
 *
 * Model IDs are opaque strings (provider/model ids); they never contain
 * credentials or provider secrets.
 */

/** Stable, sorted, deduplicated comma-joined model list. */
export function formatModelList(ids: Iterable<string>): string {
  return [...new Set(ids)]
    .filter((id) => id.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

/** Parse a comma-separated model list back into sorted, deduplicated ids. */
export function parseModelList(text: string): string[] {
  return formatModelList(
    text
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  )
    .split(", ")
    .filter(Boolean);
}

/** The canonical `Colony-Models:` trailer line for a set of model ids. */
export function formatColonyModelsTrailer(ids: Iterable<string>): string {
  const list = formatModelList(ids);
  return list ? `Colony-Models: ${list}` : "";
}

/** Extract the model ids from a `Colony-Models:` trailer in a message. */
export function parseColonyModelsTrailer(message: string): string[] {
  const ids: string[] = [];
  for (const line of message.split("\n")) {
    const match = /^Colony-Models:\s*(.*)$/i.exec(line.trim());
    if (match) ids.push(...parseModelList(match[1]!));
  }
  return formatModelList(ids).split(", ").filter(Boolean);
}

/**
 * Append a trailer line to a commit message, preserving the human
 * subject/body. Idempotent: an identical trailer is not duplicated. The
 * trailer is placed after a blank line so Git treats it as a trailer block.
 */
export function appendTrailer(message: string, trailer: string): string {
  if (!trailer) return message;
  const existing = parseColonyModelsTrailer(message);
  const incoming = parseColonyModelsTrailer(trailer);
  if (existing.length > 0 && existing.join(",") === incoming.join(",")) {
    return message;
  }
  // Strip any existing Colony-Models: lines before appending.
  const lines = message.split("\n");
  const kept = lines.filter((l) => !/^Colony-Models:/i.test(l.trim()));
  const body = kept.join("\n").replace(/\s+$/, "");
  return `${body}\n\n${trailer}\n`;
}

/**
 * Collect the model ids actually used by a set of runs: each run's recorded
 * `model_id` plus every model-fallback destination (`from`/`to`) recorded in
 * its run events. Deterministic: sorted, deduplicated.
 */
export function collectRunModelIds(
  runs: readonly Run[],
  listRunEvents: (runId: string) => readonly RunEvent[],
): string[] {
  const ids = new Set<string>();
  for (const run of runs) {
    if (run.model_id) ids.add(run.model_id);
    for (const event of listRunEvents(run.id)) {
      if (event.event !== "pi_model_fallback") continue;
      let detail: Record<string, unknown>;
      try {
        detail = JSON.parse(event.detail_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const key of ["from", "to"]) {
        const value = detail[key];
        if (typeof value === "string" && value) ids.add(value);
      }
    }
  }
  return formatModelList(ids).split(", ").filter(Boolean);
}

/**
 * The aggregate role-qualified provenance line for a scope/task merge commit
 * message: `Colony-Models: architect=...; implement=...; review=...`.
 * Deterministic non-model gates (merge_gate, validate) are excluded.
 */
export function buildMergeProvenanceLine(
  architect: readonly string[],
  implement: readonly string[],
  review: readonly string[],
): string {
  const parts: string[] = [];
  const arch = formatModelList(architect);
  const impl = formatModelList(implement);
  const rev = formatModelList(review);
  if (arch) parts.push(`architect=${arch}`);
  if (impl) parts.push(`implement=${impl}`);
  if (rev) parts.push(`review=${rev}`);
  return parts.length > 0 ? `Colony-Models: ${parts.join("; ")}` : "";
}

/**
 * Rewrite every commit on a Colony task branch (those not on the default
 * branch) to carry the `Colony-Models:` trailer, then force-push with a
 * lease so a concurrent push is never clobbered. Returns the new head SHA.
 *
 * Best-effort by contract: callers wrap this in try/catch and fall back to
 * the pre-amend head on any failure — a provenance normalization failure
 * must never fail the run. Never rewrites commits already merged (the
 * rewrite range is bounded to the task branch's own commits).
 */
export function amendBranchWithTrailer(input: {
  readonly cloneUrl: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly expectedHeadSha: string;
  readonly trailer: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-provenance-"));
  try {
    git(
      ["clone", "--quiet", "--branch", input.branch, input.cloneUrl, dir],
      tmpdir(),
    );
    const head = git(["rev-parse", "HEAD"], dir).trim();
    if (head !== input.expectedHeadSha) {
      throw new Error(
        `branch head ${head} != expected ${input.expectedHeadSha}; refusing to amend`,
      );
    }
    git(["fetch", "--quiet", "origin", input.defaultBranch], dir);

    const script = join(dir, "msg-filter.mjs");
    writeFileSync(
      script,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "const msg = readFileSync(0, 'utf8');",
        "const kept = msg.split('\\n').filter(l => !/^Colony-Models:/i.test(l.trim()));",
        "const body = kept.join('\\n').replace(/\\s+$/, '');",
        "const trailer = process.env.COLONY_MODELS_TRAILER ?? '';",
        "writeFileSync(1, trailer ? body + '\\n\\n' + trailer + '\\n' : body + '\\n');",
      ].join("\n"),
      "utf8",
    );

    git(
      [
        "filter-branch",
        "-f",
        "--msg-filter",
        `node ${script}`,
        `origin/${input.defaultBranch}..HEAD`,
      ],
      dir,
      { COLONY_MODELS_TRAILER: input.trailer },
    );
    const newHead = git(["rev-parse", "HEAD"], dir).trim();
    git(
      [
        "push",
        "--force-with-lease=refs/heads/" +
          input.branch +
          ":" +
          input.expectedHeadSha,
        "origin",
        `HEAD:refs/heads/${input.branch}`,
      ],
      dir,
    );
    return newHead;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env["GIT_AUTHOR_NAME"] || "colony",
      GIT_AUTHOR_EMAIL: process.env["GIT_AUTHOR_EMAIL"] || "colony@local",
      GIT_COMMITTER_NAME: process.env["GIT_COMMITTER_NAME"] || "colony",
      GIT_COMMITTER_EMAIL: process.env["GIT_COMMITTER_EMAIL"] || "colony@local",
      ...env,
    },
  });
}
