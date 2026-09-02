/** @param {import("./duration.d.ts").DurationRun} run @param {number} nowMs */
export function runDurationMs(run, nowMs) {
  const started = run.started_at;
  if (started == null || started === "") return null;
  const start = Date.parse(started);
  if (Number.isNaN(start)) return null;
  let end;
  if (run.finished_at) {
    const parsed = Date.parse(run.finished_at);
    end = Number.isNaN(parsed) ? nowMs : parsed;
  } else {
    end = nowMs;
  }
  if (typeof end !== "number" || Number.isNaN(end)) return null;
  const diff = end - start;
  if (diff < 0) return 0;
  return diff;
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** @param {number} ms */
function formatVerbose(ms) {
  if (ms < 1000) return "less than 1 second";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    const parts = [`${h} hour${h === 1 ? "" : "s"}`];
    if (m > 0) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
    // seconds are dropped for hour+ durations (compact format does as well)
    return parts.join(" ");
  }
  if (totalSec < 60) return `${s} second${s === 1 ? "" : "s"}`;
  if (s === 0) return `${m} minute${m === 1 ? "" : "s"}`;
  return `${m} minute${m === 1 ? "" : "s"} ${s} second${s === 1 ? "" : "s"}`;
}

/**
 * @param {import("./duration.d.ts").DurationRun} run
 * @param {number} nowMs
 */
export function durationAriaLabel(run, nowMs) {
  const ms = runDurationMs(run, nowMs);
  const started = run.started_at;
  const finished = run.finished_at;
  const durationText = ms === null ? "unknown duration" : formatVerbose(ms);
  if (finished) {
    return `ran for ${durationText}, started ${started}, finished ${finished}`;
  }
  return `running for ${durationText}, started ${started}`;
}

/** @param {number} ms */
function toIsoDuration(ms) {
  if (ms < 1000) return "PT0S";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let out = "PT";
  if (h > 0) out += `${h}H`;
  if (m > 0) out += `${m}M`;
  if (s > 0 || out === "PT") out += `${s}S`;
  return out;
}

/** @param {number} ms */
export function isoDuration(ms) {
  return toIsoDuration(ms);
}

/**
 * A 1s clock whose callback is bound after construction: the consumer owns
 * what a tick does, and `onTick` may be replaced between runs while the
 * interval keeps its identity.
 *
 * @param {{ intervalMs?: number, setIntervalFn?: typeof setInterval, clearIntervalFn?: typeof clearInterval }} [options]
 */
export function createRunTicker({
  intervalMs = 1000,
  setIntervalFn,
  clearIntervalFn,
} = {}) {
  const setFn = setIntervalFn ?? globalThis.setInterval.bind(globalThis);
  const clearFn = clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);
  let id = /** @type {ReturnType<typeof setInterval> | null} */ (null);
  let callback = /** @type {() => void} */ (() => {});
  return {
    /** @param {() => void} fn */
    onTick(fn) {
      callback = fn;
    },
    start() {
      if (id !== null) return;
      id = setFn(() => callback(), intervalMs);
    },
    stop() {
      if (id === null) return;
      clearFn(id);
      id = null;
    },
    running() {
      return id !== null;
    },
  };
}
