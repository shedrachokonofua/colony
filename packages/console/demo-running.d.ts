import type { DemoRunningEntry, DemoScope } from "./demo-data.d.ts";

/**
 * The demo project's Running-tab rows, plus the detail payloads of the
 * scopes that own them so a row click can select its task offline.
 */
export function buildDemoRunning(
  now: number,
  scopes: readonly DemoScope[],
): {
  entries: DemoRunningEntry[];
  details: Record<
    string,
    {
      scope: DemoScope;
      tasks: Array<Record<string, unknown>>;
      deps: Array<{ task_id: string; depends_on_task_id: string }>;
      runs: Array<Record<string, unknown>>;
    }
  >;
};
