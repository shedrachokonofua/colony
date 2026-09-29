import { describe, expect, it } from "bun:test";
import type { ArchitectDecompositionV2 } from "./envelopes/v2.js";
import { diffPlans, revisionPatchProblems } from "./plan-diff.js";

function plan(
  tasks: {
    title: string;
    spec?: string;
    depends_on?: number[];
    files?: string[];
  }[],
  extra: Partial<ArchitectDecompositionV2> = {},
): ArchitectDecompositionV2 {
  return {
    kind: "architect_decomposition",
    summary: "plan",
    requirements: [
      { id: "R1", text: "goal", tasks: tasks.map((_, index) => index) },
    ],
    journey: [{ after_task: tasks.length - 1, working_state: "goal" }],
    acceptance: [{ description: "goal", command: "true" }],
    tasks: tasks.map((task) => ({
      title: task.title,
      spec: task.spec ?? `Do ${task.title}.`,
      depends_on: task.depends_on ?? [],
      files: task.files ?? ["src/a.ts"],
      evidence: ["true"],
    })),
    ...extra,
  };
}

describe("diffPlans", () => {
  it("matches tasks by title and reads dependencies by title, not index", () => {
    const before = plan([
      { title: "A" },
      { title: "B", depends_on: [0] },
      { title: "Old" },
    ]);
    const after = plan([
      { title: "New" },
      { title: "A" },
      { title: "B", depends_on: [1], spec: "Do B properly." },
    ]);
    const changes = diffPlans(before, after);
    expect(changes.tasks).toEqual([
      { index: 0, title: "New", change: "new", fields: [] },
      { index: 1, title: "A", change: "unchanged", fields: [] },
      { index: 2, title: "B", change: "changed", fields: ["spec"] },
    ]);
    expect(changes.removed).toEqual(["Old"]);
    expect(changes.plan).toEqual([]);
  });
});

describe("revisionPatchProblems", () => {
  const rejected = plan([
    { title: "Schema" },
    { title: "Auth", depends_on: [0] },
    { title: "Search", depends_on: [0] },
  ]);
  // The review named Auth (task 1); findings without a task name none.
  const findings = [{ task: 1 }, {}];

  it("accepts a patch: flagged tasks change, new tasks appear, the rest stay put", () => {
    const revision = plan([
      { title: "Schema" },
      { title: "Auth", depends_on: [0], spec: "Do Auth with sessions." },
      { title: "Search", depends_on: [0] },
      { title: "Sessions", depends_on: [1] },
    ]);
    expect(revisionPatchProblems(rejected, findings, revision)).toEqual([]);
  });

  it("rejects a change to a task no finding named, and accepts it once declared", () => {
    const rewrite = plan([
      { title: "Schema", spec: "Do Schema, differently." },
      { title: "Auth", depends_on: [0] },
      { title: "Search", depends_on: [0], files: ["src/search.ts"] },
    ]);
    const problems = revisionPatchProblems(rejected, findings, rewrite);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('task "Schema" changed (spec)');
    expect(problems[1]).toContain('task "Search" changed (files)');

    const declared = {
      ...rewrite,
      unflagged_changes: [
        { task: "Schema", reason: "Auth's fix needs a sessions table." },
        { task: "Search", reason: "Search moves out of the shared module." },
      ],
    };
    expect(revisionPatchProblems(rejected, findings, declared)).toEqual([]);
  });

  it("treats removing or renaming an unflagged task as a change", () => {
    const renamed = plan([
      { title: "Schema" },
      { title: "Auth", depends_on: [0] },
      { title: "Keyword search", depends_on: [0] },
    ]);
    const problems = revisionPatchProblems(rejected, findings, renamed);
    expect(problems).toEqual([
      'task "Search" is gone although no finding named it: restore it, or list it in unflagged_changes with the reason',
    ]);
  });

  it("does not count dependency edges that follow from edits elsewhere", () => {
    // Auth is flagged and renamed; Search's edge to it changes as a result.
    const before = plan([
      { title: "Schema" },
      { title: "Auth", depends_on: [0] },
      { title: "Search", depends_on: [1] },
    ]);
    const after = plan([
      { title: "Schema" },
      { title: "Session auth", depends_on: [0] },
      { title: "Search", depends_on: [1] },
    ]);
    expect(revisionPatchProblems(before, [{ task: 1 }], after)).toEqual([]);
  });

  it("rejects declarations and disputes that name nothing in the review", () => {
    const revision = plan(
      [
        { title: "Schema" },
        { title: "Auth", depends_on: [0] },
        { title: "Search", depends_on: [0] },
      ],
      {
        unflagged_changes: [{ task: "Billing", reason: "cleanup" }],
        disputed_findings: [
          { finding: 2, evidence: "src/auth.ts:12 already verifies issuer" },
          { finding: 2, evidence: "again" },
          { finding: 3, evidence: "src/a.ts:1" },
        ],
      },
    );
    expect(revisionPatchProblems(rejected, findings, revision)).toEqual([
      'unflagged_changes names "Billing", which is not a task title of the rejected plan',
      "disputed_findings names finding 2 twice",
      "disputed_findings names finding 3, but the review had 2",
    ]);
  });
});
