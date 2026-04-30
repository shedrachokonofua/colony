import type { TaskGraphRepository } from "@colony/db";
import type { ProviderAdapter } from "@colony/provider";
import { revokeTaskAgentToken } from "./task-agent-tokens.js";

export interface SweepOrphanTaskAgentTokensDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerAdapter: ProviderAdapter;
}

export interface SweepOrphanTaskAgentTokensInput {
  readonly limit?: number;
}

export interface SweepOrphanTaskAgentTokensResult {
  readonly scanned: number;
  readonly revoked: number;
  readonly failed: number;
}

export function createSweepOrphanTaskAgentTokens(
  deps: SweepOrphanTaskAgentTokensDependencies,
) {
  return async function sweepOrphanTaskAgentTokens(
    input: SweepOrphanTaskAgentTokensInput = {},
  ): Promise<SweepOrphanTaskAgentTokensResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const records = (
      await deps.repo.listActiveTaskAgentTokens({
        states: ["closed", "merged"],
      })
    ).slice(0, limit);
    let revoked = 0;
    let failed = 0;
    for (const record of records) {
      const task = await deps.repo.getTask(record.task_id);
      if (!task) {
        failed += 1;
        continue;
      }
      const result = await revokeTaskAgentToken(deps, {
        task,
        project: { id: record.provider_project_id },
        reason: "orphan_token_sweep",
      });
      if (result.revoked) {
        revoked += 1;
      } else if (result.reason === "failed") {
        failed += 1;
      }
    }
    return { scanned: records.length, revoked, failed };
  };
}
