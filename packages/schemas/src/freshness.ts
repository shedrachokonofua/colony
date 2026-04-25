import { z } from "zod";

export const FRESHNESS_FIELDS = [
  "packet_hash",
  "task_graph_version",
  "provider_event_ts",
  "commit_sha",
  "policy_version",
  "memory_bundle_version",
] as const;

export type FreshnessField = (typeof FRESHNESS_FIELDS)[number];

export const freshnessSchema = z
  .object({
    packet_hash: z.string().min(1),
    task_graph_version: z.string().min(1),
    provider_event_ts: z.iso.datetime({ offset: true }),
    commit_sha: z.string().min(1),
    policy_version: z.string().min(1),
    memory_bundle_version: z.string().min(1),
  })
  .strict()
  .meta({
    title: "Freshness",
    description:
      "Freshness metadata required on every state-affecting envelope. Each field pins the agent run to a specific provider event, repo commit, policy version, memory bundle, Task Graph state version, and packet hash so the Supervisor can reject stale outputs.",
  });

export type Freshness = z.infer<typeof freshnessSchema>;
