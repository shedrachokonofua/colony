import { describe, expect, it } from "bun:test";
import { graphModel, layoutDag } from "./dag.js";

describe("layoutDag", () => {
  const chainNodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const chainEdges = [
    { task_id: "b", depends_on_task_id: "a" },
    { task_id: "c", depends_on_task_id: "b" },
  ];

  it("chain: every node lands in pos with one column per level", () => {
    const { pos, width, height } = layoutDag(chainNodes, chainEdges);
    expect(pos.size).toBe(3);
    expect(pos.get("a")).toEqual({ x: 16, y: 16, w: 224, h: 76 });
    expect(pos.get("b")?.x).toBe(16 + 264);
    expect(pos.get("c")?.x).toBe(16 + 2 * 264);
    expect(width).toBe(16 * 2 + 3 * 264 - (264 - 224));
    expect(height).toBe(16 * 2 + 1 * 96);
  });

  it("diamond: dependencies spread branches across rows, joins shift a column", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const edges = [
      { task_id: "b", depends_on_task_id: "a" },
      { task_id: "c", depends_on_task_id: "a" },
      { task_id: "d", depends_on_task_id: "b" },
      { task_id: "d", depends_on_task_id: "c" },
    ];
    const { pos } = layoutDag(nodes, edges);
    const a = pos.get("a");
    const b = pos.get("b");
    const c = pos.get("c");
    const d = pos.get("d");
    expect(a?.x).toBe(16);
    expect(b?.x).toBe(a!.x + 264);
    expect(c?.x).toBe(b!.x);
    expect(d?.x).toBe(b!.x + 264);
    // b and c share a column, so they must not overlap.
    expect(b!.y).not.toBe(c!.y);
    expect(Math.abs(b!.y - c!.y)).toBeGreaterThanOrEqual(76);
    expect(d!.y).toBe(a!.y);
  });

  it("independent nodes stack in the first column without overlapping", () => {
    const { pos, height } = layoutDag([{ id: "x" }, { id: "y" }], []);
    expect(pos.get("x")?.y).toBe(16);
    expect(pos.get("y")?.y).toBe(16 + 96);
    expect(height).toBe(16 * 2 + 2 * 96);
  });

  it("edges pointing outside the graph are ignored, cycles do not hang", () => {
    const nodes = [{ id: "a" }, { id: "b" }];
    const edges = [
      { task_id: "a", depends_on_task_id: "ghost" },
      { task_id: "b", depends_on_task_id: "a" },
      { task_id: "a", depends_on_task_id: "b" },
    ];
    const { pos } = layoutDag(nodes, edges);
    expect(pos.size).toBe(2);
    expect(pos.get("a")).toBeDefined();
    expect(pos.get("b")).toBeDefined();
  });

  it("empty graph still yields a drawable canvas", () => {
    const { pos, width, height } = layoutDag([], []);
    expect(pos.size).toBe(0);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});

describe("graphModel", () => {
  it("maps task rows and deps straight through when tasks exist", () => {
    const detail = {
      tasks: [
        { id: "t1", title: "First", state: "merged" },
        { id: "t2", title: "Second", state: "queued" },
      ],
      deps: [{ task_id: "t2", depends_on_task_id: "t1" }],
      scope: { plan_json: null },
    };
    expect(graphModel(detail)).toEqual({
      nodes: [
        { id: "t1", title: "First", state: "merged", proposed: false },
        { id: "t2", title: "Second", state: "queued", proposed: false },
      ],
      edges: detail.deps,
    });
  });

  it("falls back to plan nodes with plan:<index> ids when there are no tasks", () => {
    const plan = {
      tasks: [
        { title: "Alpha", depends_on: [] },
        { title: "Beta", depends_on: [0] },
      ],
    };
    const model = graphModel({
      tasks: [],
      deps: [],
      scope: { plan_json: JSON.stringify(plan) },
    });
    expect(model.nodes).toEqual([
      { id: "plan:0", title: "Alpha", state: "queued", proposed: true },
      { id: "plan:1", title: "Beta", state: "queued", proposed: true },
    ]);
    expect(model.edges).toEqual([
      { task_id: "plan:1", depends_on_task_id: "plan:0" },
    ]);
  });

  it("returns an empty model for null detail or an unparseable plan", () => {
    expect(graphModel(null)).toEqual({ nodes: [], edges: [] });
    expect(graphModel(undefined)).toEqual({ nodes: [], edges: [] });
    expect(
      graphModel({ tasks: [], deps: [], scope: { plan_json: "{oops" } }),
    ).toEqual({ nodes: [], edges: [] });
    expect(
      graphModel({ tasks: [], deps: [], scope: { plan_json: null } }),
    ).toEqual({ nodes: [], edges: [] });
  });

  it("layout of the model positions every returned node", () => {
    const detail = {
      tasks: [
        { id: "t1", title: "First", state: "merged" },
        { id: "t2", title: "Second", state: "mr_open" },
      ],
      deps: [{ task_id: "t2", depends_on_task_id: "t1" }],
      scope: { plan_json: null },
    };
    const { nodes, edges } = graphModel(detail);
    const { pos } = layoutDag(nodes, edges);
    expect(pos.size).toBe(nodes.length);
    for (const node of nodes) expect(pos.get(node.id)).toBeDefined();
  });
});
