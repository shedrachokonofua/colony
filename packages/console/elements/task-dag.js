// <task-dag>: the scope's task dependency graph as an SVG. Ported from the
// monolith's renderDag (app.js): longest-path layout from ../dag.js, bezier
// edges with an arrow marker, and node boxes carrying title, state, live run
// label + duration, and the proposed flag while a plan is unapproved. Node
// hits dispatch colony-select-task on click and on Enter/Space. The host owns
// the drawer, so drawerOpen decides whether a selection is actually shown:
// closing the drawer un-highlights the node, as the monolith does. Hosts that
// keep no drawer leave it open and see the plain selection highlight.
import {
  ColonyElement,
  classMap,
  html,
  nothing,
  repeat,
  svg,
} from "../base.js";
import { graphModel, layoutDag } from "../dag.js";
import {
  createRunTicker,
  formatDuration,
  runDurationMs,
} from "../duration.js";
import { KIND_LABEL } from "../kind-label.js";

/**
 * The running run for one task, for the node's live label.
 * @param {import("../dag.js").DagDetail | null | undefined} detail
 * @param {string} taskId
 * @returns {any} the task's running run row, or undefined
 */
function liveRunFor(detail, taskId) {
  const runs = /** @type {any[]} */ (detail?.runs || []);
  return runs.find((run) => run.status === "running" && run.task_id === taskId);
}

/** Trailing serial of a task id (`#1`) or plan node (`#1` via `plan:1`). */
/** @param {import("../dag.js").DagNode} node */
function nodeTail(node) {
  return node.id.slice(node.id.lastIndexOf(node.proposed ? ":" : ".") + 1);
}

export class TaskDag extends ColonyElement {
  static properties = {
    detail: { type: Object },
    selectedTaskId: { type: String },
    drawerOpen: { type: Boolean },
    // Reactive, because the ticker's only job is to move it: a plain field
    // would advance the number behind the shell's back and never repaint.
    _now: { state: true },
  };

  #ticker = createRunTicker();
  /** @type {import("../duration.js").Unsubscribe | null} */
  #unsubscribe = null;

  constructor() {
    super();
    /** @type {import("../dag.js").DagDetail | null} */
    this.detail = null;
    /** @type {string | null} */
    this.selectedTaskId = null;
    this.drawerOpen = true;
    this._now = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#unsubscribe = this.#ticker.subscribe(() => {
      this._now = Date.now();
    });
    this.#syncTicker();
  }

  disconnectedCallback() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#ticker.stop();
    super.disconnectedCallback();
  }

  /** @param {Map<string, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    // A node's live label is the only reason to hold a 1s interval; a new
    // detail can start or end every run on the graph.
    if (changed.has("detail")) this.#syncTicker();
  }

  #syncTicker() {
    if (this.#hasLiveRun()) this.#ticker.start();
    else this.#ticker.stop();
  }

  /** @returns {boolean} */
  #hasLiveRun() {
    const runs = /** @type {any[]} */ (this.detail?.runs || []);
    return runs.some((run) => run.status === "running");
  }

  /** @param {string} taskId */
  #select(taskId) {
    this.dispatchEvent(
      new CustomEvent("colony-select-task", {
        bubbles: true,
        detail: { taskId },
      }),
    );
  }

  /** @param {KeyboardEvent} event @param {string} taskId */
  #keydown(event, taskId) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.#select(taskId);
  }

  render() {
    const detail = this.detail;
    const { nodes, edges } = graphModel(detail);
    if (!nodes.length) {
      const runs = /** @type {any[]} */ (detail?.runs || []);
      const runningPlan = runs.some(
        (run) => run.kind === "architect" && run.status === "running",
      );
      return html`<p class="note">
        ${runningPlan
          ? "Architect is drawing the plan."
          : "No tasks on this sheet yet."}
      </p>`;
    }
    const { pos, width, height } = layoutDag(nodes, edges);
    const now = this._now || Date.now();
    const edgeMarkup = repeat(
      edges,
      (edge) => `${edge.depends_on_task_id}->${edge.task_id}`,
      (edge) => {
        const from = pos.get(edge.depends_on_task_id);
        const to = pos.get(edge.task_id);
        if (!from || !to) return svg``;
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x - 3;
        const y2 = to.y + to.h / 2;
        const c = Math.max(30, (x2 - x1) * 0.45);
        return svg`<path class="edge dag-edge" marker-end="url(#arrow)"
          d="M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}" />`;
      },
    );
    const nodeMarkup = repeat(
      nodes,
      (node) => node.id,
      (node) => {
        const box = pos.get(node.id);
        if (!box) return svg``;
        const live = liveRunFor(detail, node.id);
        const selected = this.selectedTaskId === node.id && this.drawerOpen;
        return svg`<g
          class=${classMap({
            "g-node": true,
            node: true,
            "dag-node": true,
            "is-selected": selected,
            "is-live": Boolean(live),
          })}
          data-state=${node.state}>
          <rect
            class=${classMap({
              "node-box": true,
              "is-proposed": Boolean(node.proposed),
            })}
            x=${box.x} y=${box.y} width=${box.w} height=${box.h} />
          <rect class="node-bar" x=${box.x + 5} y=${box.y + 5} width="3" height=${box.h - 10} />
          <foreignObject x=${box.x} y=${box.y} width=${box.w} height=${box.h}>
            <div class="node-html dag-label" xmlns="http://www.w3.org/1999/xhtml">
              <span class="ntitle">${node.title}</span>
              <span class="nstate"
                >${node.state}${
                  live
                    ? ` · ${KIND_LABEL[live.kind] || live.kind}${(() => {
                        const ms = runDurationMs(live, now);
                        return ms === null ? "" : ` ${formatDuration(ms)}`;
                      })()}`
                    : ""
                }<span class="nid">#${nodeTail(node)}</span></span
              >
            </div>
          </foreignObject>
          <rect class="node-hit" tabindex="0" role="button"
            aria-label=${node.title}
            x=${box.x} y=${box.y} width=${box.w} height=${box.h}
            @click=${() => this.#select(node.id)}
            @keydown=${
              /** @param {KeyboardEvent} event */ (event) =>
                this.#keydown(event, node.id)
            } />
        </g>`;
      },
    );
    return html`<svg
      class="dag"
      width=${width}
      height=${height}
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Task dependency graph"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6.5"
          markerHeight="6.5"
          orient="auto-start-reverse"
        >
          <path class="edge-head" d="M0,0 L8,4 L0,8 z" />
        </marker>
      </defs>
      ${edgeMarkup}${nodeMarkup}
    </svg>`;
  }
}

customElements.define("task-dag", TaskDag);
