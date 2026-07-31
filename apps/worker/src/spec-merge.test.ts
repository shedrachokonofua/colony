import { describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "@colony/provider";
import type { ProviderMirror, ProviderProject, ScopeId } from "@colony/domain";
import { createMergeSpecMergeRequest } from "./spec-merge.js";

const scope_id = "col-specmerge" as ScopeId;

function setup() {
  const adapter = new FakeProviderAdapter();
  const projectRef = { id: "fake-project", path: "colony/spec-merge" };
  const audits: Array<Record<string, unknown>> = [];
  let mergeCalls = 0;
  const originalMerge = adapter.mergeRequests.merge.bind(adapter.mergeRequests);
  adapter.mergeRequests.merge = (...args) => {
    mergeCalls += 1;
    return originalMerge(...args);
  };
  const project = {
    id: "db-project",
    provider: adapter.provider,
    provider_id: projectRef.id,
    path: projectRef.path,
    default_branch: "main",
    visibility: "private",
  } as ProviderProject;
  const mirror: ProviderMirror = {
    id: "mirror-1" as ProviderMirror["id"],
    colony_id: scope_id,
    entity_kind: "mr_pr",
    provider: adapter.provider,
    provider_id: "fake-project:mr-1",
    provider_project_id: project.id,
    provider_project_path: project.path,
  };
  const repo = {
    listDecompositionProposals: () =>
      Promise.resolve([
        {
          id: "proposal-1",
          envelope_hash: "env-hash",
          reviewer_result: "approved",
        },
      ]),
    writeAudit: (audit: Record<string, unknown>) => {
      audits.push(audit);
      return Promise.resolve("audit-1");
    },
  };
  const providerProjects = {
    listMirrorsForColony: () => Promise.resolve([mirror]),
    getProject: () => Promise.resolve(project),
    listScopeTargets: () => Promise.resolve([]),
  };
  const run = createMergeSpecMergeRequest({
    repo: repo as never,
    providerProjects: providerProjects as never,
    providerAdapter: adapter,
  });
  return { adapter, projectRef, run, audits, getMergeCalls: () => mergeCalls };
}

describe("mergeSpecMergeRequest", () => {
  it("merges an open spec MR and records the audit evidence", async () => {
    const { adapter, projectRef, run, audits, getMergeCalls } = setup();
    await adapter.mergeRequests.open(projectRef, {
      title: "[SPEC] merge",
      description: "proposal",
      source_branch: "colony/spec",
      target_branch: "main",
    });

    const result = await run({ scope_id, proposal_id: "proposal-1" });

    expect(result).toMatchObject({ merged: true, mr_id: "fake-project:mr-1" });
    expect(getMergeCalls()).toBe(1);
    expect(audits[0]).toMatchObject({
      action: "architect.spec_mr.merged",
      actor: "svc:supervisor",
      reason: "spec_mr_merged_after_dag_commit",
      evidence: { envelope_hash: "env-hash", reviewer_result: "approved" },
    });
  });

  it("is a no-op when the spec MR is already merged", async () => {
    const { adapter, projectRef, run, audits, getMergeCalls } = setup();
    await adapter.mergeRequests.open(projectRef, {
      title: "[SPEC] merge",
      description: "proposal",
      source_branch: "colony/spec",
      target_branch: "main",
    });
    await adapter.mergeRequests.merge(projectRef, "fake-project:mr-1");

    const result = await run({ scope_id, proposal_id: "proposal-1" });

    expect(result).toMatchObject({
      merged: true,
      mr_id: "fake-project:mr-1",
      already_merged: true,
    });
    expect(getMergeCalls()).toBe(1);
    expect(audits).toHaveLength(0);
  });
});
