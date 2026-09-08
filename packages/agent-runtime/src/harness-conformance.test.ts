import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { RunAuditSink } from "./audit-sink.js";
import {
  HARNESS_CAPABILITIES,
  MAX_HARNESS_TURNS,
  parseDeployRoleChains,
  readPinnedVersions,
  roleModelChains,
  runHarnessConformance,
  writeConformanceTable,
  type ModelConformanceRow,
} from "./harness-conformance.js";

/**
 * The live sweep drives real models through the real LiteLLM route, so it is
 * gated behind COLONY_LIVE_GATEWAY. Without it the suite is skipped (green);
 * the pure helpers below are always exercised, because a parser bug would
 * otherwise only ever show up as a nightly with no rows.
 */
const LIVE = Boolean(process.env.COLONY_LIVE_GATEWAY);

const LIVE_TIMEOUT_MS = 30 * 60_000;

/** Table path the live run writes; the nightly job publishes it as an artifact. */
const TABLE_PATH = join(process.cwd(), "harness-conformance-table.md");

const DEPLOY_YAML = `
providers:
  openai_compatible:
    api: openai-completions
    base_url: https://litellm.home.shdr.ch/v1
agents:
  # A comment with a colon: model: decoy
  developer:
    provider: openai_compatible
    model: hy4-preview
    fallback_models:
      [
        muse-spark,
        gemini-3.8-flash,
      ]
    thinking_level: high
  reviewer:
    provider: openai_compatible
    model: grok-4.6
    fallback_models:
      - qwen3.8-max
      - kimi-k3
  architect:
    provider: openai_compatible
    model: 'muse-spark'
    fallback_models: []
  memory_consolidator:
    provider: openai_compatible
    model: muse-spark
`;

describe("harness conformance config parsing", () => {
  it("reads each role's model and fallback chain", () => {
    const chains = parseDeployRoleChains(DEPLOY_YAML);
    expect(chains.developer).toEqual({
      model: "hy4-preview",
      fallbackModels: ["muse-spark", "gemini-3.8-flash"],
    });
    expect(chains.reviewer).toEqual({
      model: "grok-4.6",
      fallbackModels: ["qwen3.8-max", "kimi-k3"],
    });
    // Quoted and empty forms must parse the same way as the bare ones.
    expect(chains.architect).toEqual({
      model: "muse-spark",
      fallbackModels: [],
    });
    expect(chains.memory_consolidator).toEqual({
      model: "muse-spark",
      fallbackModels: [],
    });
  });

  it("ignores comments and keys outside the agents block", () => {
    const chains = parseDeployRoleChains(DEPLOY_YAML);
    // "providers" is a top-level key with no model, so it must not appear as
    // a role with an empty chain.
    expect(chains.providers).toBeUndefined();
    expect(chains.developer?.model).toBe("hy4-preview");
  });

  it("keeps role order and drops duplicates", () => {
    const chains = parseDeployRoleChains(DEPLOY_YAML);
    const byRole = roleModelChains(chains, [
      "developer",
      "reviewer",
      "memory_consolidator",
    ]);
    expect(byRole.map((entry) => entry.role)).toEqual([
      "developer",
      "reviewer",
      "memory_consolidator",
    ]);
    expect(byRole[0]?.models).toEqual([
      "hy4-preview",
      "muse-spark",
      "gemini-3.8-flash",
    ]);
  });

  it("reports an empty chain for a role the config does not define", () => {
    expect(roleModelChains({}, ["developer"])).toEqual([
      { role: "developer", models: [] },
    ]);
  });
});

describe("harness conformance pinned versions", () => {
  it("reads bun and node-with-v from colony-versions.json", async () => {
    const versions = await readPinnedVersions();
    expect(versions.bun).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(versions.nodeWithV).toMatch(/^v[0-9]+/);
  });
});

describe("writeConformanceTable", () => {
  const rows: ModelConformanceRow[] = [
    {
      model: "m1",
      role: "developer",
      capability: "read",
      pass: true,
      turns: 6,
    },
    {
      model: "m1",
      role: "developer",
      capability: "grep",
      pass: true,
      turns: 6,
    },
    {
      model: "m1",
      role: "developer",
      capability: "edit",
      pass: false,
      turns: 6,
    },
    {
      model: "m1",
      role: "developer",
      capability: "write",
      pass: true,
      turns: 6,
    },
    {
      model: "m1",
      role: "developer",
      capability: "bash",
      pass: true,
      turns: 6,
    },
    {
      model: "m1",
      role: "developer",
      capability: "submit",
      pass: true,
      turns: 6,
    },
    { model: "m2", role: "reviewer", capability: "read", pass: true, turns: 9 },
    { model: "m2", role: "reviewer", capability: "grep", pass: true, turns: 9 },
    { model: "m2", role: "reviewer", capability: "edit", pass: true, turns: 9 },
    {
      model: "m2",
      role: "reviewer",
      capability: "write",
      pass: true,
      turns: 9,
    },
    { model: "m2", role: "reviewer", capability: "bash", pass: true, turns: 9 },
    {
      model: "m2",
      role: "reviewer",
      capability: "submit",
      pass: false,
      turns: 9,
    },
  ];

  it("renders one column per model x role and one row per capability", () => {
    const table = writeConformanceTable(rows);
    const lines = table.trimEnd().split("\n");
    expect(lines[0]).toContain("`m1 (developer)`");
    expect(lines[0]).toContain("`m2 (reviewer)`");
    for (const capability of HARNESS_CAPABILITIES) {
      expect(table).toContain(`| ${capability} `);
    }
    // m1 fails edit, m2 fails submit: the two failure cells must be visible.
    const editRow = lines.find((line) => line.startsWith("| edit "));
    const submitRow = lines.find((line) => line.startsWith("| submit "));
    expect(editRow?.split("|")[2]?.trim()).toBe("FAIL");
    expect(editRow?.split("|")[3]?.trim()).toBe("PASS");
    expect(submitRow?.split("|")[3]?.trim()).toBe("FAIL");
  });

  it("gives a model measured under two roles its own column each", () => {
    // muse-spark leads the architect chain and falls back for the developer,
    // and the two rows carry different results. Collapsing them into one
    // column would report whichever row landed last.
    const shared: ModelConformanceRow[] = HARNESS_CAPABILITIES.map(
      (capability) => ({
        model: "muse-spark",
        role: "architect",
        capability,
        pass: true,
        turns: 7,
      }),
    ).concat(
      HARNESS_CAPABILITIES.map((capability) => ({
        model: "muse-spark",
        role: "developer",
        capability,
        pass: false,
        turns: 12,
      })),
    );
    const table = writeConformanceTable(shared);
    expect(table).toContain("`muse-spark (architect)`");
    expect(table).toContain("`muse-spark (developer)`");
    const readRow = table
      .trimEnd()
      .split("\n")
      .find((line) => line.startsWith("| read "));
    expect(readRow?.split("|")[2]?.trim()).toBe("PASS");
    expect(readRow?.split("|")[3]?.trim()).toBe("FAIL");
  });

  it("carries the turn count of each mini-task", () => {
    const table = writeConformanceTable(rows);
    const turnsRow = table
      .split("\n")
      .find((line) => line.startsWith("| turns "));
    expect(turnsRow).toBe("| turns | 6 | 9 |");
  });

  it("renders an empty table for no rows without throwing", () => {
    expect(writeConformanceTable([])).toContain("| capability |");
  });
});

/**
 * An in-memory audit sink: the seam the sweep is required to use, checked
 * here so a caller that drops the event or the artifact is caught offline.
 */
function recordingSink(): {
  events: { event: string; detail: Record<string, unknown> }[];
  artifacts: { key: string; data: Uint8Array; contentType: string }[];
  sink: RunAuditSink;
} {
  const events: { event: string; detail: Record<string, unknown> }[] = [];
  const artifacts: { key: string; data: Uint8Array; contentType: string }[] =
    [];
  return {
    events,
    artifacts,
    sink: {
      appendEvent: (_runId, event, detail) => {
        events.push({ event, detail });
      },
      putArtifact: async (_runId, _kind, key, data, contentType) => {
        artifacts.push({ key, data, contentType });
        return { ref: `mem://${key}`, bytes: data.byteLength, sha256: "sha" };
      },
    },
  };
}

describe("harness conformance audit seam", () => {
  it("appends harness.conformance and stores the markdown table", async () => {
    const recorded = recordingSink();
    const root = await mkdtemp(join(tmpdir(), "colony-harness-audit-"));
    try {
      // A closed local base_url makes every mini-task fail fast, which is
      // exactly the "model cannot answer" shape the seam must still record.
      const rows = await runHarnessConformance({
        auditSink: recorded.sink,
        runId: "run-audit",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key",
        roles: ["developer"],
        requestTimeoutMs: 500,
        workspaceRoot: root,
      });
      // One row per capability per model in the developer chain, and a dead
      // route proves nothing: every capability must read as a failure.
      const chains = parseDeployRoleChains(
        await readFile(
          new URL("../../../config/colony.deploy.yaml", import.meta.url),
          "utf8",
        ),
      );
      const developerModels = roleModelChains(chains, ["developer"])[0]!.models;
      expect(developerModels.length).toBeGreaterThan(0);
      expect(rows.length).toBe(
        developerModels.length * HARNESS_CAPABILITIES.length,
      );
      expect(rows.every((row) => row.pass === false)).toBe(true);
      expect(
        rows.slice(0, HARNESS_CAPABILITIES.length).map((r) => r.capability),
      ).toEqual([...HARNESS_CAPABILITIES]);

      const event = recorded.events.find(
        (entry) => entry.event === "harness.conformance",
      );
      expect(event).toBeDefined();
      expect(event?.detail.rows).toEqual(rows);

      expect(recorded.artifacts.length).toBe(1);
      expect(recorded.artifacts[0]?.key).toBe("harness-conformance-table.md");
      expect(recorded.artifacts[0]?.contentType).toBe("text/markdown");
      const table = new TextDecoder().decode(recorded.artifacts[0]!.data);
      expect(table).toBe(writeConformanceTable(rows));
      expect(table).toContain("| capability |");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000); // budget is real time spent, not a race with it. // Each model in the chain gets one request against a closed port; the

  it("throws instead of reporting an empty table when no credential exists", async () => {
    const saved = process.env.COLONY_OPENAI_COMPATIBLE_API_KEY;
    delete process.env.COLONY_OPENAI_COMPATIBLE_API_KEY;
    try {
      await expect(
        runHarnessConformance({ roles: ["developer"] }),
      ).rejects.toThrow(/credential/);
    } finally {
      if (saved !== undefined) {
        process.env.COLONY_OPENAI_COMPATIBLE_API_KEY = saved;
      }
    }
  });
});

(LIVE ? describe : describe.skip)("harness conformance (live gateway)", () => {
  it(
    "every model in every role's chain drives the harness",
    async () => {
      const rows = await runHarnessConformance();
      const table = writeConformanceTable(rows);
      await Bun.write(TABLE_PATH, table);

      const failures = rows.filter((row) => !row.pass);
      for (const failure of failures) {
        console.error(
          `FAIL model=${failure.model} role=${failure.role} capability=${failure.capability}`,
        );
      }
      // A model that answers but never calls a capability is a finding, not
      // a skipped check: the sweep must have produced one row per capability.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.turns <= MAX_HARNESS_TURNS)).toBe(true);
      if (failures.length > 0) {
        throw new Error(
          `FAIL model=${failures[0]!.model} role=${failures[0]!.role} capability=${failures[0]!.capability}`,
        );
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "wrote harness-conformance-table.md for colonyd",
    async () => {
      const text = await readFile(TABLE_PATH, "utf8");
      expect(text).toContain("| capability |");
      // Every capability the harness defines is a row: a table missing one
      // would hide a whole class of model failure.
      for (const capability of HARNESS_CAPABILITIES) {
        expect(text).toContain(capability);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
