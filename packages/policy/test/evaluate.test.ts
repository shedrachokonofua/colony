import { describe, expect, it } from "vitest";
import type { Policy, ProviderIdentity } from "@colony/domain";
import { evaluate, evaluateAction } from "../src/evaluate.js";
import { requiredCapabilityForAction } from "../src/actions.js";

const nullPolicy: Policy | null = null;
const p: Policy = {
  id: "pol-1" as import("@colony/domain").PolicyId,
  scope: "global",
  version: 1,
  protected_paths: [],
  security_labels: [],
  always_human_review: false,
  review_loop_cap: 3,
  settings: {},
  created_at: "2020-01-01T00:00:00.000Z",
};

describe("evaluate", () => {
  it("denies when capability is not granted", () => {
    const r = evaluate({
      action: "task.claim",
      requiredCapability: "task.claim",
      granted: new Set(["graph.read"]),
      providerIdentity: null,
      effectivePolicy: nullPolicy,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/missing capability/);
  });

  it("denies graph.write for bot non-supervisor even when grant exists", () => {
    const devBot: ProviderIdentity = {
      actor: "a" as import("@colony/domain").ActorId,
      provider: "colony",
      provider_user_id: "1",
      role: "developer",
      is_bot: true,
    };
    const r = evaluateAction("scope.create", {
      granted: new Set<import("@colony/domain").Capability>([
        "graph.write",
        "graph.read",
      ]),
      providerIdentity: devBot,
      effectivePolicy: p,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toMatch(/graph\.write/);
    }
  });

  it("allows supervisor bot graph.write", () => {
    const sup: ProviderIdentity = {
      actor: "s" as import("@colony/domain").ActorId,
      provider: "colony",
      provider_user_id: "1",
      role: "supervisor",
      is_bot: true,
    };
    const r = evaluateAction("scope.create", {
      granted: new Set<import("@colony/domain").Capability>(["graph.write"]),
      providerIdentity: sup,
      effectivePolicy: p,
    });
    expect(r.allowed).toBe(true);
  });
});

describe("requiredCapabilityForAction", () => {
  it("maps reads to graph.read and writes to graph.write", () => {
    expect(requiredCapabilityForAction("scope.list")).toBe("graph.read");
    expect(requiredCapabilityForAction("scope.create")).toBe("graph.write");
    expect(requiredCapabilityForAction("task.claim")).toBe("task.claim");
    expect(requiredCapabilityForAction("provider.bootstrap")).toBe(
      "provider.admin.bootstrap",
    );
  });
});
