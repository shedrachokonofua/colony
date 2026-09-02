export interface DurationRun {
  started_at?: string | null;
  finished_at?: string | null;
}

export function runDurationMs(run: DurationRun, nowMs: number): number | null;

export function formatDuration(ms: number): string;

export function durationAriaLabel(run: DurationRun, nowMs: number): string;

export function isoDuration(ms: number): string;

export type Ticker = {
  onTick(fn: () => void): void;
  start(): void;
  stop(): void;
  running(): boolean;
};

export function createRunTicker(options?: {
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): Ticker;
