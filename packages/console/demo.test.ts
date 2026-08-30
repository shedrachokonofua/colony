// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";

// demo.js reads location.search at module top level; bun tests run without
// any location global, so seed one and pull demo.js in after it.
const realLocation = globalThis.location ?? {
  hash: "",
  search: "",
};
Object.defineProperty(globalThis, "location", {
  value: realLocation,
  configurable: true,
  writable: true,
});

const { DEMO, DEMO_READS, demoContextStore, demoFileStore, demoWorld } =
  await import("./demo.js");
const { DEMO_PROJECT_COUNT, DEMO_SCOPES_IN_PROJECT } =
  await import("./demo-data.js");

function withSearch(search: string) {
  Object.defineProperty(globalThis, "location", {
    value: { ...realLocation, search },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "location", {
    value: realLocation,
    configurable: true,
    writable: true,
  });
});

describe("DEMO_READS", () => {
  it("admits project reads and the list endpoints, rejects the rest", () => {
    // Bare "/projects" never resolves in demo mode (the homepage renders
    // straight from the demo world); the regex's [^/?]+ stops at the slash
    // of a pathless file write, so id-less "/projects/acme/files" stays a
    // read the world serves offline.
    for (const path of [
      "/projects?limit=25&offset=0",
      "/projects/Operator%20console",
      "/projects/Operator%20console/context",
      "/projects/Operator%20console/files",
      "/scopes?project=Operator%20console",
    ]) {
      expect(DEMO_READS.test(path)).toBe(true);
    }
    for (const path of [
      "/tasks",
      "/scopes",
      "/scopes/col-x/approve",
      "/projects",
      "/ui/config",
    ]) {
      expect(DEMO_READS.test(path)).toBe(false);
    }
  });
});

describe("demoWorld", () => {
  it("assembles every surface the console reads", () => {
    const world = demoWorld();
    expect(Object.keys(world).sort()).toEqual([
      "audit",
      "config",
      "detail",
      "files",
      "project",
      "projects",
      "runEvents",
      "scopes",
    ]);
    expect(world.config).toEqual({
      gitlab_base_url: "https://gitlab.home.shdr.ch",
      review_mode: "required",
      hitl_mode: "yolo",
      trace_ui_base_url: "https://traces.home.shdr.ch",
    });
  });

  it("pins the demo project as the last of the fillers plus one empty project", () => {
    const world = demoWorld();
    expect(world.projects).toHaveLength(DEMO_PROJECT_COUNT + 1);
    expect(world.project.name).toBe("Operator console");
    expect(world.projects.at(-2)?.name).toBe("Operator console");
    expect(world.projects.at(-1)?.name).toBe("Empty workspace");
    expect(world.project.scope_count).toBe(DEMO_SCOPES_IN_PROJECT);
    expect(world.files).toEqual(demoFileStore.get("Operator console"));
  });

  it("scopes pair the hand-authored rows with the generated pages", () => {
    const world = demoWorld();
    expect(world.scopes[0].id).toBe("col-a1b2c3d4");
    expect(world.scopes[1].id).toBe("col-0badc0de");
    expect(world.scopes).toHaveLength(2 + DEMO_SCOPES_IN_PROJECT);
    expect(world.detail.scope.id).toBe("col-a1b2c3d4");
    expect(world.detail.tasks).toHaveLength(3);
  });

  it("reflects brief edits stored in demoContextStore", () => {
    demoContextStore.set("Operator console", "Locally edited brief");
    try {
      const world = demoWorld();
      expect(world.project.context_doc).toBe("Locally edited brief");
    } finally {
      demoContextStore.delete("Operator console");
    }
    expect(demoWorld().project.context_doc).not.toBe("Locally edited brief");
  });

  it("runEvents feed the gate drawer, audit rows come along", () => {
    const world = demoWorld();
    expect(world.runEvents.every((e) => e.run_id === "run-gate-1")).toBe(true);
    expect(world.audit.map((a) => a.action)).toContain("mr.merged");
  });
});

describe("DEMO mode flag", () => {
  it("freezes the mode the page loaded with", async () => {
    // DEMO snapshots location.search at first import and never re-reads it.
    // Other suites in this process may have imported demo.js under their own
    // seeded location, so assert the freeze itself: flipping the search and
    // re-importing still yields the frozen value.
    withSearch(DEMO ? "" : "?demo=1");
    // Dynamic import on purpose: the test exercises the module-cache freeze.
    const again = await import("./demo.js");
    expect(again.DEMO).toBe(DEMO);
  });
});
