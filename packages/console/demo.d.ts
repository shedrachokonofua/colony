export const DEMO: boolean;
export const DEMO_READS: RegExp;
export const demoContextStore: Map<string, string | null>;
export const demoFileStore: Map<string, Array<Record<string, unknown>>>;

export function demoWorld(): {
  config: Record<string, unknown>;
  project: Record<string, unknown>;
  projects: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  scopes: Array<Record<string, unknown>>;
  detail: Record<string, unknown>;
  runEvents: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
};
