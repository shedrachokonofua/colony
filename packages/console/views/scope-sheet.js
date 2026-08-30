// <scope-sheet>: the full scope view — header, DAG card, the three column
// cards, the task drawer, and the scope-level run feed. Ported from the
// monolith's renderSheet (app.js). Property-down: detail, audit,
// selectedTaskId, drawerOpen, goalOpen, planOpen, runEvents, scopeRunEvents,
// error. Events-up: the T5 catalog (colony-toggle, colony-select-task,
// colony-close-drawer, colony-open-reader, colony-close-reader,
// colony-confirm, colony-task-action, colony-abandon, colony-feedback) which
// the shell's handleEvent routes.
import { ColonyElement, html, nothing } from "../base.js";
import { rel } from "../rel-time.js";
import "../elements/activity-card.js";
import "../elements/goal-card.js";
import "../elements/plan-card.js";
import "../elements/task-dag.js";
import "../elements/task-drawer.js";
import "../elements/validation-card.js";

function scopeTitle(scope) {
  if (!scope) return "";
  if (scope.title) return scope.title;
  return scope.goal.length > 72
    ? `${scope.goal.slice(0, 72).trimEnd()}…`
    : scope.goal;
}

function latestValidateRun(detail) {
  const runs = (detail?.runs || []).filter((run) => run.kind === "validate");
  return runs
    .slice()
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    .pop();
}

/** The monolith's waitingOnYou (app.js): the banner line for the sheet. */
function waitingOnYou(scope, tasks, detail) {
  if (!scope) return "";
  if (scope.status === "planning" && scope.plan_json) {
    return "Plan is waiting for your approval.";
  }
  if (scope.status === "planning") return "Architect is drawing the plan.";
  if (scope.status === "validating") {
    const latest = latestValidateRun(detail);
    if (latest?.status === "failed") {
      return "Validation failed — fix the goal on the default branch, then run validation again.";
    }
    if (latest?.status === "running") {
      return "Validating the goal on the default branch — running acceptance criteria against a fresh checkout.";
    }
    return "Waiting for validation to start.";
  }
  if (scope.status === "blocked") {
    return scope.blocked_reason || "Scope is blocked.";
  }
  if (scope.approvals === "manual") {
    const awaiting = (tasks || []).filter(
      (task) => task.state === "mr_open" && !task.merge_approved_sha,
    );
    if (awaiting.length === 1) {
      return `Merge request !${awaiting[0].mr_iid} is waiting for your approval.`;
    }
    if (awaiting.length > 1) {
      return `${awaiting.length} merge requests are waiting for your approval.`;
    }
  }
  const blocked = (tasks || []).filter((task) => task.state === "blocked");
  if (blocked.length === 1) {
    return `${blocked[0].title} is blocked.`;
  }
  if (blocked.length > 1) return `${blocked.length} tasks are blocked.`;
  return "";
}

export class ScopeSheet extends ColonyElement {
  static properties = {
    detail: { type: Object },
    audit: { type: Array },
    selectedTaskId: { type: String },
    drawerOpen: { type: Boolean },
    goalOpen: { type: Boolean },
    planOpen: { type: Boolean },
    runEvents: { type: Object },
    scopeRunEvents: { type: Object },
    error: { type: String },
    config: { type: Object },
    // The shell's armed confirm kind (merge/stop/cancel/abandon…); the
    // abandon button renders its Confirm step while it matches.
    confirm: { type: String },
  };

  constructor() {
    super();
    this.detail = null;
    this.audit = [];
    this.selectedTaskId = null;
    this.drawerOpen = false;
    this.goalOpen = false;
    this.planOpen = false;
    this.runEvents = null;
    this.scopeRunEvents = null;
    this.error = "";
    this.config = null;
    this.confirm = null;
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  #abandonVisible(scope) {
    return Boolean(scope) && !["done", "abandoned"].includes(scope.status);
  }

  /** The monolith's abandonButton (app.js): arm with a confirm, then emit
   * colony-abandon {scopeId} — the event the shell's _abandon listens for. */
  #abandonButton(scope) {
    if (!this.#abandonVisible(scope)) return nothing;
    return this.confirm === "abandon"
      ? html`<button
          class="btn btn-rev"
          @click=${() => this.#emit("colony-abandon", { scopeId: scope.id })}
        >
          Confirm abandon
        </button>`
      : html`<button
          class="btn btn-quiet"
          @click=${() => this.#emit("colony-confirm", { kind: "abandon" })}
        >
          Abandon scope
        </button>`;
  }

  #drawerTask(detail) {
    if (!detail || !this.selectedTaskId) return null;
    return detail.tasks.find((task) => task.id === this.selectedTaskId) || null;
  }

  render() {
    const detail = this.detail;
    const scope = detail?.scope;
    if (!scope) {
      return html`<p class="boot">Loading scope…</p>`;
    }
    const task = this.#drawerTask(detail);
    const wait = waitingOnYou(scope, detail.tasks, detail);
    const pathUrl = scope.provider_repo_path
      ? `${String(this.config?.gitlab_base_url ?? "").replace(/\/$/, "")}/${scope.provider_repo_path}`
      : "";
    const taskCount = detail.tasks.length;
    return html`<div class="sheet">
      <header class="sheet-head">
        <div class="sheet-head-main">
          <h1 class="goal">${scopeTitle(scope)}</h1>
          <p class="sheet-sub">
            <span class="mono">${scope.id}</span>
            ${pathUrl
              ? html`<a href=${pathUrl}>${scope.provider_repo_path}</a>`
              : html`<span>${scope.provider_repo_path}</span>`}
            ${scope.project_name
              ? html`<a
                  href=${`#/project/${encodeURIComponent(scope.project_name)}`}
                  >${scope.project_name}</a
                >`
              : nothing}
            <span>updated ${rel(scope.updated_at)}</span>
          </p>
        </div>
        <div class="sheet-head-side">
          <span class="chip" data-kind=${scope.status}>${scope.status}</span>
          ${scope.approvals === "manual"
            ? html`<span class="chip">manual approvals</span>`
            : nothing}
          ${this.#abandonButton(scope)}
        </div>
      </header>
      ${this.error
        ? html`<div class="banner banner-error" role="alert">${this.error}</div>`
        : nothing}
      ${wait ? html`<div class="banner banner-wait">${wait}</div>` : nothing}
      <section class="card dag-card" id="draw">
        <p class="card-head">
          Tasks${taskCount ? html` <span>${taskCount}</span>` : nothing}
        </p>
        <div class="card-body">
          <task-dag
            .detail=${detail}
            .selectedTaskId=${this.selectedTaskId}
          ></task-dag>
        </div>
      </section>
      <div class="sheet-cols">
        <div class="sheet-col">
          <goal-card
            .scope=${scope}
            .goalOpen=${this.goalOpen}
          ></goal-card>
          <activity-card .audit=${this.audit ?? []}></activity-card>
        </div>
        <div class="sheet-col">
          <plan-card
            .scope=${scope}
            .detail=${detail}
            .audit=${this.audit ?? []}
            .planOpen=${this.planOpen}
            .scopeRunEvents=${this.scopeRunEvents}
            .config=${this.config}
          ></plan-card>
        </div>
        <div class="sheet-col">
          <validation-card .scope=${scope} .detail=${detail}></validation-card>
        </div>
      </div>
      ${this.drawerOpen
        ? task
          ? html`<task-drawer
              .task=${task}
              .scope=${scope}
              .detail=${detail}
              .runEvents=${this.runEvents}
              .config=${this.config}
              .confirm=${this.confirm}
            ></task-drawer>`
          : nothing
        : nothing}
    </div>`;
  }
}

customElements.define("scope-sheet", ScopeSheet);