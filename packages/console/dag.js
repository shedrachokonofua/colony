// Task-graph layout: longest-path column assignment plus a fixed-box grid,
// and the graph model that maps a project detail (or its plan) onto it.

export function layoutDag(nodes, edges) {
  const ids = nodes.map((node) => node.id);
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (incoming.has(edge.task_id)) {
      incoming.get(edge.task_id).push(edge.depends_on_task_id);
    }
  }
  const level = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (level.has(id)) return level.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const preds = (incoming.get(id) || []).filter((pred) => ids.includes(pred));
    const depth = preds.length ? Math.max(...preds.map(depthOf)) + 1 : 0;
    visiting.delete(id);
    level.set(id, depth);
    return depth;
  };
  ids.forEach(depthOf);
  const columns = [];
  for (const id of ids) {
    const depth = level.get(id) || 0;
    (columns[depth] ||= []).push(id);
  }
  const colW = 264;
  const rowH = 96;
  const padX = 16;
  const padY = 16;
  const w = 224;
  const h = 76;
  const pos = new Map();
  columns.forEach((column, x) => {
    column.forEach((id, y) => {
      pos.set(id, { x: padX + x * colW, y: padY + y * rowH, w, h });
    });
  });
  const width = padX * 2 + Math.max(columns.length, 1) * colW - (colW - w);
  const height =
    padY * 2 + Math.max(1, ...columns.map((column) => column.length)) * rowH;
  return { pos, width, height };
}

export function graphModel(detail) {
  if (!detail) return { nodes: [], edges: [] };
  if (detail.tasks.length) {
    return {
      nodes: detail.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        state: task.state,
        proposed: false,
      })),
      edges: detail.deps,
    };
  }
  const plan = parsePlan(detail.scope.plan_json);
  if (!plan) return { nodes: [], edges: [] };
  return {
    nodes: plan.tasks.map((task, index) => ({
      id: `plan:${index}`,
      title: task.title,
      state: "queued",
      proposed: true,
    })),
    edges: plan.tasks.flatMap((task, index) =>
      (task.depends_on || []).map((dep) => ({
        task_id: `plan:${index}`,
        depends_on_task_id: `plan:${dep}`,
      })),
    ),
  };
}

function parsePlan(raw) {
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw);
    if (!plan || !Array.isArray(plan.tasks)) return null;
    return plan;
  } catch {
    return null;
  }
}