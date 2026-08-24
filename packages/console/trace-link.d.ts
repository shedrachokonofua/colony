export interface TraceLinkConfig {
  readonly trace_ui_base_url?: string | null;
}

export interface TraceLinkRun {
  readonly trace_id?: string | null;
}

export function traceHref(
  config: TraceLinkConfig,
  run: TraceLinkRun,
): string | null;
