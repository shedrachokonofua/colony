import { describe, expect, it, mock } from "bun:test";
import {
  createRunTicker,
  durationAriaLabel,
  formatDuration,
  isoDuration,
  runDurationMs,
} from "./duration.js";

describe("runDurationMs", () => {
  it("computes completed run (finished - started)", () => {
    const started_at = "2025-01-01T00:00:00.000Z";
    const finished_at = "2025-01-01T00:03:05.000Z";
    const run = { started_at, finished_at } as const;
    expect(runDurationMs(run, Date.now())).toBe(185_000);
  });

  it("computes active run with injected now", () => {
    const started_at = "2025-01-01T00:00:00.000Z";
    const start = Date.parse(started_at);
    const nowMs = start + 12_000;
    const run = { started_at, finished_at: null } as const;
    expect(runDurationMs(run as never, nowMs)).toBe(12_000);
  });

  it("returns null for missing started_at", () => {
    expect(
      runDurationMs({ started_at: null, finished_at: null } as never, 0),
    ).toBeNull();
    expect(runDurationMs({ finished_at: null } as never, 0)).toBeNull();
    expect(
      runDurationMs({ started_at: "", finished_at: null } as never, 0),
    ).toBeNull();
    expect(
      runDurationMs({ started_at: undefined, finished_at: null } as never, 0),
    ).toBeNull();
  });

  it("returns null for unparseable started_at", () => {
    expect(
      runDurationMs(
        { started_at: "not-a-date", finished_at: null } as never,
        0,
      ),
    ).toBeNull();
  });

  it("clamps negative elapsed to 0 (clock skew)", () => {
    const started_at = "2025-01-01T00:01:00.000Z";
    const finished_at = "2025-01-01T00:00:00.000Z";
    expect(runDurationMs({ started_at, finished_at } as never, 0)).toBe(0);
    const nowMs = Date.parse("2025-01-01T00:00:00.000Z");
    expect(
      runDurationMs({ started_at, finished_at: null } as never, nowMs),
    ).toBe(0);
  });
});

describe("formatDuration", () => {
  it("sub-second → <1s", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(500)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("seconds boundary", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("minute boundary with zero-padded seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(60_500)).toBe("1m 00s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(61_000)).toBe("1m 01s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("hour boundary with zero-padded minutes, seconds dropped", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    expect(formatDuration(3_660_000)).toBe("1h 01m");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
    expect(formatDuration(3_661_000)).toBe("1h 01m");
    expect(formatDuration(7_200_000)).toBe("2h 00m");
  });

  it("zero-padding keeps ticking width stable", () => {
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_600_000 + 2 * 60_000)).toBe("1h 02m");
  });
});

describe("isoDuration", () => {
  it("formats ISO 8601 duration", () => {
    expect(isoDuration(0)).toBe("PT0S");
    expect(isoDuration(500)).toBe("PT0S");
    expect(isoDuration(1000)).toBe("PT1S");
    expect(isoDuration(185_000)).toBe("PT3M5S");
    expect(isoDuration(3_720_000)).toBe("PT1H2M");
    expect(isoDuration(3_600_000)).toBe("PT1H");
  });
});

describe("durationAriaLabel", () => {
  it("preserves exact ISO timestamps for finished run", () => {
    const started_at = "2025-01-01T00:00:00.000Z";
    const finished_at = "2025-01-01T00:03:05.000Z";
    const label = durationAriaLabel({ started_at, finished_at } as never, 0);
    expect(label).toContain(`started ${started_at}`);
    expect(label).toContain(`finished ${finished_at}`);
    expect(label).toContain("ran for");
    expect(label).toContain("3 minutes 5 seconds");
  });

  it("preserves exact ISO timestamps for running run", () => {
    const started_at = "2025-01-01T00:00:00.000Z";
    const start = Date.parse(started_at);
    const nowMs = start + 12_000;
    const label = durationAriaLabel(
      { started_at, finished_at: null } as never,
      nowMs,
    );
    expect(label).toContain(`started ${started_at}`);
    expect(label).not.toContain("finished");
    expect(label).toContain("running for");
    expect(label).toContain("12 seconds");
  });

  it("keeps precise ISO text non-lossy", () => {
    const started_at = "2025-08-14T12:34:56.789Z";
    const finished_at = "2025-08-14T13:00:00.123Z";
    const label = durationAriaLabel({ started_at, finished_at } as never, 0);
    expect(label).toContain(started_at);
    expect(label).toContain(finished_at);
  });
});

/**
 * The ticker takes injectable timer functions, so its tests drive a manual
 * clock instead of patching globals: same contract, no runner-specific fake
 * timers.
 */
const MANUAL_INTERVAL_HANDLE = 42;

interface ManualTimers {
  readonly setIntervalFn: (fn: () => void) => number;
  readonly clearIntervalFn: (id: unknown) => void;
  tick(times?: number): void;
  readonly clearedId: unknown;
}

function manualTimers(): ManualTimers {
  let handler: (() => void) | undefined;
  let clearedId: unknown = null;
  const setIntervalFn = mock((fn: () => void): number => {
    handler = fn;
    return MANUAL_INTERVAL_HANDLE;
  });
  const clearIntervalFn = mock((id: unknown) => {
    clearedId = id;
    handler = undefined;
  });
  return {
    setIntervalFn,
    clearIntervalFn,
    tick(times = 1) {
      for (let index = 0; index < times; index += 1) handler?.();
    },
    get clearedId() {
      return clearedId;
    },
  };
}

function manualTicker(onTick = mock(() => {})) {
  const timers = manualTimers();
  const ticker = createRunTicker({
    intervalMs: 1000,
    setIntervalFn: timers.setIntervalFn as never,
    clearIntervalFn: timers.clearIntervalFn as never,
  });
  const unsubscribe = ticker.subscribe(onTick);
  return { timers, ticker, onTick, unsubscribe };
}

describe("createRunTicker", () => {
  it("fires each subscriber once per interval", () => {
    const { timers, ticker, onTick } = manualTicker();
    ticker.start();
    expect(onTick).not.toHaveBeenCalled();
    expect(timers.setIntervalFn).toHaveBeenCalledTimes(1);
    timers.tick();
    expect(onTick).toHaveBeenCalledTimes(1);
    timers.tick(2);
    expect(onTick).toHaveBeenCalledTimes(3);
    ticker.stop();
  });

  it("keeps every subscriber: a second binding cannot dislodge the first", () => {
    // The clock is shared (the shell's ticker and one per live surface), so
    // binding a second consumer must add to the first, never replace it —
    // a replaced callback freezes whoever bound it first.
    const { timers, ticker, onTick } = manualTicker();
    const second = mock(() => {});
    ticker.subscribe(second);
    ticker.start();
    timers.tick();
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    ticker.stop();
  });

  it("drops a subscriber on unsubscribe and leaves the others ticking", () => {
    const { timers, ticker, onTick, unsubscribe } = manualTicker();
    const second = mock(() => {});
    ticker.subscribe(second);
    ticker.start();
    unsubscribe();
    timers.tick();
    expect(onTick).toHaveBeenCalledTimes(0);
    expect(second).toHaveBeenCalledTimes(1);
    // Unsubscribing stops the callback, not the clock: the interval is the
    // shell's to stop.
    expect(ticker.running()).toBe(true);
    ticker.stop();
  });

  it("start is idempotent", () => {
    const { timers, ticker, onTick } = manualTicker();
    ticker.start();
    ticker.start();
    expect(timers.setIntervalFn).toHaveBeenCalledTimes(1);
    timers.tick();
    expect(onTick).toHaveBeenCalledTimes(1);
    ticker.stop();
  });

  it("stop is idempotent and clears the interval it created", () => {
    const { timers, ticker, onTick } = manualTicker();
    ticker.start();
    ticker.stop();
    ticker.stop();
    expect(timers.clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(timers.clearedId).toBe(MANUAL_INTERVAL_HANDLE);
    timers.tick(2);
    expect(onTick).toHaveBeenCalledTimes(0);
  });

  it("running() reflects state", () => {
    const { ticker } = manualTicker();
    expect(ticker.running()).toBe(false);
    ticker.start();
    expect(ticker.running()).toBe(true);
    ticker.stop();
    expect(ticker.running()).toBe(false);
  });
});
