/**
 * The merge gate's built-in static analysis step: semgrep with the rules the
 * sandbox image vendors (docker/sandbox/Dockerfile), high severity only, and
 * diff-aware against the target branch so findings that already exist on
 * `main` never block an unrelated change. It is colonyd-owned rather than a
 * `colony.gate.yaml` command because per-repo configuration can be deleted
 * by the same agent that wrote the bug. `--disable-nosem` keeps inline
 * `nosemgrep` comments from switching it off for the same reason.
 */

export interface SastFinding {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

export type SastOutcome =
  | { readonly kind: "clean" }
  | {
      readonly kind: "findings";
      readonly total: number;
      readonly findings: readonly SastFinding[];
    }
  /** semgrep itself failed: a platform problem, never the change's fault. */
  | { readonly kind: "tool_failed"; readonly detail: string };

/** Prefix of the one summary line the command prints. */
export const SAST_RESULT_MARKER = "COLONY_SAST_RESULT ";

const MAX_FINDINGS = 20;
const MAX_MESSAGE_CHARS = 300;

// Runs inside the sandbox with node on PATH. It reduces semgrep's JSON
// (unbounded) to one bounded line; no single quotes, it sits in '...'.
const SUMMARIZE = [
  'const fs = require("node:fs");',
  "const [file, status] = process.argv.slice(1);",
  "let out;",
  "try {",
  '  const report = JSON.parse(fs.readFileSync(file, "utf8"));',
  "  const results = Array.isArray(report.results) ? report.results : [];",
  "  out = {",
  "    status: Number(status),",
  "    total: results.length,",
  "    errors: Array.isArray(report.errors) ? report.errors.length : 0,",
  `    findings: results.slice(0, ${MAX_FINDINGS}).map((r) => ({`,
  "      rule: String(r.check_id),",
  "      path: String(r.path),",
  "      line: Number(r.start && r.start.line) || 0,",
  `      message: String((r.extra && r.extra.message) || "").slice(0, ${MAX_MESSAGE_CHARS}),`,
  "    })),",
  "  };",
  "} catch (e) {",
  "  out = { status: Number(status), error: String(e && e.message) };",
  "}",
  `console.log(${JSON.stringify(SAST_RESULT_MARKER)} + JSON.stringify(out));`,
].join(" ");

export function buildSastCommand(
  baselineSha: string,
  rulesDir: string,
): string {
  if (!/^[0-9a-f]{40}$/.test(baselineSha)) {
    throw new Error(`invalid SAST baseline commit: ${baselineSha}`);
  }
  return [
    'out="$TMPDIR/colony-semgrep.json"',
    [
      "semgrep scan",
      `--config ${shellQuote(rulesDir)}`,
      "--severity ERROR",
      `--baseline-commit ${baselineSha}`,
      "--disable-nosem",
      "--metrics off",
      "--disable-version-check",
      "--json --quiet",
      "--timeout 30 --jobs 2",
      '> "$out"',
    ].join(" "),
    "status=$?",
    `node -e '${SUMMARIZE}' "$out" "$status"`,
  ].join("\n");
}

/** Interpret the command's output; anything unexpected is a tool failure. */
export function parseSastOutput(output: string): SastOutcome {
  const line = output
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(SAST_RESULT_MARKER));
  if (!line) {
    return { kind: "tool_failed", detail: "semgrep produced no result line" };
  }
  let summary: {
    status?: unknown;
    total?: unknown;
    error?: unknown;
    findings?: unknown;
  };
  try {
    summary = JSON.parse(line.slice(SAST_RESULT_MARKER.length));
  } catch {
    return { kind: "tool_failed", detail: "semgrep result line is not JSON" };
  }
  // Without --error semgrep exits 0 with or without findings; any other
  // status (or an unreadable report) means the scan did not happen.
  if (summary.status !== 0 || typeof summary.error === "string") {
    return {
      kind: "tool_failed",
      detail: `semgrep exited ${String(summary.status)}${
        typeof summary.error === "string" ? `: ${summary.error}` : ""
      }`,
    };
  }
  const total = typeof summary.total === "number" ? summary.total : 0;
  if (total === 0) return { kind: "clean" };
  const findings = Array.isArray(summary.findings)
    ? (summary.findings as SastFinding[])
    : [];
  return { kind: "findings", total, findings };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
