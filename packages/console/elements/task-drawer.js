// <task-drawer>: the operator's per-task panel, ported from the monolith's
// renderDrawer and renderPlanTaskDrawer (app.js). Property-down: task,
// scope, detail, runEvents, and config. Events-up: colony-task-action,
// colony-close-drawer, colony-open-reader, colony-feedback. A task id of
// `plan:<i>` selects the monolith's proposed-task drawer instead.
//
// Amend/feedback drafts are keyed by task id in a Map (defect 3): switching
// away stashes the texts under the old task's id, opening another task
// loads its own (or empty) texts, so a draft typed for task A can never
// surface under task B — and returning to A restores it.
import { ColonyElement, html, nothing, repeat } from "../base.js";
import {
  costPredictionLines,
  parseCostPrediction,
} from "../cost-prediction.js";
import { parsePlan } from "../dag.js";
import { renderTaskActions } from "./task-drawer-actions.js";
import "./run-feed.js";
import "./run-line.js";

/** @param {string | null | undefined} sha */
function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "—";
}

export class TaskDrawer extends ColonyElement {
  static properties = {
    task: { type: Object },
    scope: { type: Object },
    detail: { type: Object },
    runEvents: { type: Object },
    config: { type: Object },
    _amendDraft: { state: true },
    _feedbackDraft: { state: true },
    drafts: { type: Object },
    _drafts: { state: true },
    // The confirm kind the shell armed (merge/stop/cancel) renders the
    // drawer's two-step buttons; see #actionButtons.
    confirm: { type: String },
  };

  constructor() {
    super();
    /** @type {Record<string, any> | null} */
    this.task = null;
    /** @type {Record<string, any> | null} */
    this.scope = null;
    /** @type {Record<string, any> | null} */
    this.detail = null;
    /** @type {Record<string, any> | null} */
    this.runEvents = null;
    /** @type {import("../trace-link.js").TraceLinkConfig & Record<string, any> | null} */
    this.config = null;
    /** @type {string | null} */
    this.confirm = null;
    this._amendDraft = "";
    this._feedbackDraft = "";
    /** @type {Map<string, { amend: string, feedback: string }> | null} */
    this.drafts = null;
    /** @type {Map<string, { amend: string, feedback: string }>} */
    this._drafts = new Map();
  }

  get #draftMap() {
    return this.drafts instanceof Map ? this.drafts : this._drafts;
  }

  /** @param {Map<string, unknown>} changed */
  willUpdate(changed) {
    super.willUpdate(changed);
    if (changed.has("task")) {
      const old = /** @type {Record<string, any> | undefined} */ (
        changed.get("task")
      );
      if (old?.id)
        this.#draftMap.set(old.id, {
          amend: this._amendDraft,
          feedback: this._feedbackDraft,
        });
      const saved = this.task?.id
        ? this.#draftMap.get(this.task.id)
        : undefined;
      this._amendDraft = saved?.amend ?? "";
      this._feedbackDraft = saved?.feedback ?? "";
    }
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  /** @param {string} action */
  #action(action) {
    this.#emit("colony-task-action", { taskId: this.task?.id, action });
  }

  /** @param {string} path @param {Record<string, unknown>} body */
  #feedback(path, body) {
    this.#emit("colony-feedback", { path, body });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.task?.id) {
      this.#draftMap.set(this.task.id, {
        amend: this._amendDraft,
        feedback: this._feedbackDraft,
      });
    }
  }

  // Amend/feedback textareas are plain (not live()): lit only writes .value
  // when the binding changes, so keystrokes survive the 2.5s poll repaint.
  // The @input handlers keep the per-task drafts current for willUpdate's
  // stash; the submit forms read the DOM like the monolith's submitFeedback.
  /** @param {InputEvent} event */
  #amendInput(event) {
    this._amendDraft = /** @type {HTMLTextAreaElement} */ (event.target).value;
  }

  /** @param {InputEvent} event */
  #feedbackInput(event) {
    this._feedbackDraft = /** @type {HTMLTextAreaElement} */ (
      event.target
    ).value;
  }

  /** @param {{ state?: string }} task @param {string} [label] */
  #drawerHead(task, label = "Task detail") {
    return html`<div class="drawer-head">
      <span class="chip" data-kind=${task.state}>${task.state}</span>
      <span class="mono drawer-id">${label}</span>
      <button
        class="btn btn-quiet drawer-close"
        @click=${() => this.#emit("colony-close-drawer")}
        aria-label="Close task detail"
      >
        ✕
      </button>
    </div>`;
  }

  #planDrawer() {
    const index = Number(String(this.#planTaskId()).slice(5));
    const plan = parsePlan(this.detail?.scope?.plan_json);
    const planTask = Number.isInteger(index) ? plan?.tasks?.[index] : null;
    if (!planTask) return nothing;
    const deps = (planTask.depends_on || []).length
      ? `depends on ${(planTask.depends_on || [])
          .map((d) => `#${d}`)
          .join(", ")}`
      : "no dependencies";
    return html`<aside class="drawer" role="dialog" aria-label="Planned task">
      ${this.#drawerHead({ state: "proposed" }, `plan #${index}`)}
      <div class="drawer-body">
        <p class="task-title">${planTask.title}</p>
        <p class="task-meta">${deps}</p>
        <pre class="spec spec-tall">${planTask.spec}</pre>
        <p class="note">
          This task is proposed — approve or reject the plan from the Plan card.
        </p>
      </div>
    </aside>`;
  }

  /** A selected `plan:<i>` id, or null for a real-task selection. */
  #planTaskId() {
    return this.task?.id?.startsWith("plan:") ? this.task.id : null;
  }

  render() {
    const task = this.task;
    const scope = this.scope;
    if (!task || !scope) return nothing;
    if (this.#planTaskId()) return this.#planDrawer();
    const detailRuns = /** @type {any[]} */ (this.detail?.runs || []);
    const runs = detailRuns.filter((run) => run.task_id === task.id);
    const sha = [...runs].reverse().find((run) => run.head_sha)?.head_sha;
    const base = String(this.config?.gitlab_base_url ?? "").replace(/\/$/, "");
    const mr =
      base && task.mr_iid
        ? `${base}/${scope.provider_repo_path}/-/merge_requests/${task.mr_iid}`
        : "";
    const commit =
      base && sha ? `${base}/${scope.provider_repo_path}/-/commit/${sha}` : "";
    const retryWait =
      task.next_retry_at && Date.parse(task.next_retry_at) > Date.now()
        ? ` · next attempt in ${Math.max(1, Math.round((Date.parse(task.next_retry_at) - Date.now()) / 60000))}m`
        : "";
    const liveRun = [...runs].reverse().find((run) => run.status === "running");
    return html`<aside class="drawer" role="dialog" aria-label="Task detail">
      ${this.#drawerHead(task, task.id)}
      <div class="drawer-body">
        <p class="task-title">${task.title}</p>
        <p class="task-meta">
          ${task.attempt
            ? `attempt ${task.attempt}`
            : "first attempt"}${retryWait}
        </p>
        ${task.blocked_reason
          ? html`<p class="wait-inline">${task.blocked_reason}</p>`
          : nothing}
        ${this.#costPrediction(task)}
        <div class="links">
          ${mr
            ? html`<a href=${mr}>Merge request !${task.mr_iid}</a>`
            : nothing}
          ${commit ? html`<a href=${commit}>${shortSha(sha)}</a>` : nothing}
          ${task.branch
            ? html`<span class="mono">${task.branch}</span>`
            : nothing}
        </div>
        <button
          class="goal-toggle"
          @click=${() =>
            this.#emit("colony-open-reader", {
              title: task.title,
              markdown: task.spec,
            })}
        >
          Expand spec
        </button>
        <pre class="spec">${task.spec}</pre>
        ${task.state === "mr_open"
          ? html`<form
              class="feedback"
              @submit=${
                /** @param {SubmitEvent} event */ (event) => {
                  event.preventDefault();
                  this.#feedback(`/tasks/${task.id}/request-changes`, {
                    feedback: String(
                      new FormData(
                        /** @type {HTMLFormElement} */ (event.target),
                      ).get("feedback") ?? "",
                    ),
                  });
                }
              }
            >
              <textarea
                name="feedback"
                required
                .value=${this._feedbackDraft}
                @input=${
                  /** @param {InputEvent} e */ (e) => this.#feedbackInput(e)
                }
                placeholder="Feedback for the agent — requeues the task with your notes."
              ></textarea>
              <button class="btn" type="submit">Request changes</button>
            </form>`
          : nothing}
        ${!["merged", "canceled"].includes(task.state)
          ? html`<form
              class="feedback"
              @submit=${
                /** @param {SubmitEvent} event */ (event) => {
                  event.preventDefault();
                  this.#feedback(`/tasks/${task.id}/amend-spec`, {
                    feedback: String(
                      new FormData(
                        /** @type {HTMLFormElement} */ (event.target),
                      ).get("feedback") ?? "",
                    ),
                  });
                }
              }
            >
              <textarea
                name="feedback"
                required
                .value=${this._amendDraft}
                @input=${
                  /** @param {InputEvent} e */ (e) => this.#amendInput(e)
                }
                placeholder="Amend the spec — authoritative for the implementer AND the reviewer."
              ></textarea>
              <button class="btn" type="submit">Amend spec</button>
            </form>`
          : nothing}
        ${this.#actionButtons(task)}
        <p class="card-head drawer-runs-head">Runs</p>
        <div class="runs">
          ${runs.length
            ? nothing
            : html`<p class="note">No runs on this task yet.</p>`}
          ${repeat(
            runs,
            (run) => run.id,
            (run) =>
              html`<run-line .run=${run} .config=${this.config}></run-line>
                ${run === liveRun
                  ? html`<run-feed
                      .feed=${this.runEvents}
                      .run=${run}
                    ></run-feed>`
                  : nothing}`,
          )}
        </div>
      </div>
    </aside>`;
  }

  /** @param {import("../cost-prediction.js").TaskWithCostPrediction & Record<string, any>} task */
  #costPrediction(task) {
    const prediction = parseCostPrediction(task);
    if (!prediction) return nothing;
    const lines = costPredictionLines(prediction);
    return html`<div class="cost-prediction">
      <p class="card-head cost-prediction-head">
        Size prediction
        ${prediction.flagged
          ? html`<span class="chip" data-kind="blocked">over budget</span>`
          : html`<span class="cost-prediction-ok">within budget</span>`}
      </p>
      <div class="cost-prediction-body">
        ${lines.map((line) => html`<p class="task-meta">${line}</p>`)}
      </div>
    </div>`;
  }

  /** @param {Record<string, any>} task */
  #actionButtons(task) {
    return renderTaskActions(task, {
      approvals: this.detail?.scope?.approvals,
      confirm: this.confirm,
      onAction: (action) => this.#action(action),
      onConfirm: (kind) => this.#emit("colony-confirm", { kind }),
    });
  }
}

customElements.define("task-drawer", TaskDrawer);
