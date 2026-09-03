/**
 * Structured fault contract for finished runs.
 *
 * Every terminal failure carries a `Fault`: which layer broke
 * (the LLM, the harness SDK, the sandbox, a provider like GitLab or the
 * gateway, colonyd itself) and a layer-local code. Written to
 * `runs.fault_json` at finishRun time and to the `run.finished` audit
 * detail; notifications/classify reads `detail.fault.layer` from that
 * audit object.
 */

/** The six fault layers, as a readonly array. */
export const FAULT_LAYERS = [
  "model",
  "harness",
  "sandbox",
  "provider",
  "colonyd",
  "unknown",
] as const;

export type FaultLayer = (typeof FAULT_LAYERS)[number];

/** A structured failure classification for a finished run. */
export interface Fault {
  layer: FaultLayer;
  code: string;
  detail?: string;
  backfilled?: boolean;
}

export function isModelFault(f: Fault | null | undefined): boolean {
  return f?.layer === "model";
}

/** Parse a `fault_json` string, or null when missing/invalid. */
export function parseFault(raw: string | null | undefined): Fault | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const { layer, code, detail, backfilled } = parsed as Record<
      string,
      unknown
    >;
    if (typeof layer !== "string" || !isFaultLayer(layer)) return null;
    if (typeof code !== "string" || code.length === 0) return null;
    if (detail !== undefined && typeof detail !== "string") return null;
    if (backfilled !== undefined && typeof backfilled !== "boolean") {
      return null;
    }
    const fault: Fault = { layer, code };
    if (detail !== undefined) fault.detail = detail;
    if (backfilled !== undefined) fault.backfilled = backfilled;
    return fault;
  } catch {
    return null;
  }
}

function isFaultLayer(value: string): value is FaultLayer {
  return (FAULT_LAYERS as readonly string[]).includes(value);
}

// One-time inline copy of the old INFRA_FAILURE regex (apps/colonyd
// run-classification.ts), partitioned by the layer at fault so the v13
// backfill can map historical error strings onto the fault contract.

const COLONYD_FAULT_RE =
  /^process_restart$|reaping \d+ startup-orphaned|^liveness_watchdog_|^zero_output_stall$/i;

const PROVIDER_FAULT_RE =
  /\b(?:429|50[234])\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|Unable to connect|GitLab (?:GET|POST|PUT) .* timed out/i;

const SANDBOX_FAULT_RE =
  /^workspace_lost$|workspace_provision_failed|workspace_transfer_failed|EACCES|EROFS|RBAC: denied creating|timed out .* waiting for (?:backing pod of )?Sandbox CR|Sandbox CR .* failed:|sandboxes\.agents\.x-k8s\.io .{0,120}? not found/i;

const HARNESS_FAULT_RE =
  /Agent "Main" was replaced during session initialization/i;

/**
 * Map a historical run error string onto the fault contract for the v13
 * backfill, or null when the error is not an infra failure (it stays
 * unclassified — most such runs are model faults).
 */
export function classifyBackfillFromError(
  err: string | null | undefined,
): Fault | null {
  if (typeof err !== "string" || err.length === 0) return null;
  if (COLONYD_FAULT_RE.test(err)) {
    if (/^process_restart$/i.test(err)) {
      return { layer: "colonyd", code: "process_restart" };
    }
    if (/reaping \d+ startup-orphaned/i.test(err)) {
      return { layer: "colonyd", code: "startup_orphaned" };
    }
    if (/^liveness_watchdog_/i.test(err)) {
      return { layer: "colonyd", code: "watchdog" };
    }
    return { layer: "colonyd", code: "zero_output_stall" };
  }
  if (PROVIDER_FAULT_RE.test(err)) {
    if (/\b429\b/.test(err)) return { layer: "provider", code: "rate_limit" };
    if (/\b50[234]\b/.test(err)) {
      return { layer: "provider", code: "upstream_5xx" };
    }
    if (/GitLab (?:GET|POST|PUT) .* timed out/i.test(err)) {
      return { layer: "provider", code: "gitlab_timeout" };
    }
    if (/\bECONN(RESET|REFUSED)\b|Unable to connect/i.test(err)) {
      return { layer: "provider", code: "connection" };
    }
    if (/ETIMEDOUT/.test(err)) return { layer: "provider", code: "timeout" };
    return { layer: "provider", code: "fetch_failed" };
  }
  if (SANDBOX_FAULT_RE.test(err)) {
    if (/^workspace_lost$/i.test(err)) {
      return { layer: "sandbox", code: "workspace_lost" };
    }
    if (/workspace_provision_failed|workspace_transfer_failed/i.test(err)) {
      return { layer: "sandbox", code: "workspace_transfer_failed" };
    }
    if (/\bEACCES\b|\bEROFS\b/i.test(err)) {
      return { layer: "sandbox", code: "filesystem" };
    }
    return { layer: "sandbox", code: "sandbox_cr" };
  }
  if (HARNESS_FAULT_RE.test(err)) {
    return { layer: "harness", code: "session_init_replaced" };
  }
  return null;
}
