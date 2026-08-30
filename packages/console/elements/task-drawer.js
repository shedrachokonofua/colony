// <task-drawer>: the operator's per-task panel, ported from the monolith's
// renderDrawer (app.js). Property-down: task, scope, runEvents, and the
// config needed for trace links. Events-up: colony-task-action,
// colony-close-drawer, colony-open-reader, colony-feedback.
//
// Amend/feedback drafts are keyed by task id in a Map (defect 3): switching
// away stashes the texts under the old task's id, opening another task
// loads its own (or empty) texts, so a draft typed for task A can never
// surface under task B — and returning to A restores it.
import { ColonyElement, html, nothing } from "../base.js";
import {
  costPredictionLines,
  parseCostPrediction,
} from "../cost-prediction.js";
import "./run-feed.js";
import "./run-line.js";

function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "—";
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

export class TaskDrawer extends ColonyElement {
  static properties = {
    task: { type: Object },
    scope: { type: Object },
    detail: { type: Object },
    runEvents: { type: Object },
    config: { type: Object },
    _amendDraft: { state: true },
    _feedbackDraft: { state: true },
    _drafts: { state: true },
    // The confirm kind the shell armed (merge/stop/cancel) renders the
    // drawer's two-step buttons; see taskActionButtons.
    confirm: { type: String },
  };

  constructor() {
    super();
    this.task = null;
    this.scope = null;
    this.detail = null;
    this.runEvents = null;
    this.config = null;
    this.confirm = null;
    this._amendDraft = "";
    this._feedbackDraft = "";
    this._drafts = new Map();
  }

  willUpdate(changed) {
    super.willUpdate(changed);
    if (changed.has("task")) {
      const old = changed.get("task");
      if (old?.id)
        this._drafts.set(old.id, {
          amend: this._amendDraft,
          feedback: this._feedbackDraft,
        });
      const saved = this.task?.id ? this._drafts.get(this.task.id) : undefined;
      this._amendDraft = saved?.amend ?? "";
      this._feedbackDraft = saved?.feedback ?? "";
    }
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  #action(action) {
    this.#emit("colony-task-action", { taskId: this.task.id, action });
  }

  #feedback(path, body) {
    this.#emit("colony-feedback", { path, body });
  }

  // Amend/feedback textareas are plain (not live()): lit only writes .value
  // when the binding changes, so keystrokes survive the 2.5s poll repaint.
  // The @input handlers keep the per-task drafts current for willUpdate's
  // stash; the submit forms read the DOM like the monolith's submitFeedback.
  #amendInput(event) {
    this._amendDraft = event.target.value;
  }

  #feedbackInput(event) {
    this._feedbackDraft = event.target.value;
  }

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
      ${this.#drawerHead(
        { state: "proposed" },
        `plan #${index}`,
      )}
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
    const runs = (this.detail?.runs || []).filter(
      (run) => run.task_id === task.id,
    );
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
          ${task.attempt ? `attempt ${task.attempt}` : "first attempt"}${retryWait}
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
              @submit=${(event) => {
                event.preventDefault();
                this.#feedback(`/tasks/${task.id}/request-changes`, {
                  feedback: String(
                    new FormData(event.target).get("feedback") ?? "",
                  ),
                });
              }}
            >
              <textarea
                name="feedback"
                required
                .value=${this._feedbackDraft}
                @input=${(e) => this.#feedbackInput(e)}
                placeholder="Feedback for the agent — requeues the task with your notes."
              ></textarea>
              <button class="btn" type="submit">Request changes</button>
            </form>`
          : nothing}
        ${!["merged", "canceled"].includes(task.state)
          ? html`<form
              class="feedback"
              @submit=${(event) => {
                event.preventDefault();
                this.#feedback(`/tasks/${task.id}/amend-spec`, {
                  feedback: String(
                    new FormData(event.target).get("feedback") ?? "",
                  ),
                });
              }}
            >
              <textarea
                name="feedback"
                required
                .value=${this._amendDraft}
                @input=${(e) => this.#amendInput(e)}
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
          ${runs.map(
            (run) => html`<run-line .run=${run} .config=${this.config}></run-line>
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

  #actionButtons(task) {
    const buttons = [];
    if (task.state === "blocked") {
      buttons.push(
        html`<button class="btn btn-solid" @click=${() => this.#action("unblock")}>
          Unblock
        </button>`,
      );
    }
    if (task.state === "mr_open" && this.detail?.scope?.approvals === "manual") {
      buttons.push(
        task.merge_approved_sha
          ? html`<button class="btn" disabled>
              Merge approved — gate pending
            </button>`
          : this.confirm === "merge"
            ? html`<button
                class="btn btn-solid"
                @click=${() => this.#action("approve-merge")}
              >
                Confirm merge approval
              </button>`
            : html`<button
                class="btn btn-solid"
                @click=${() => this.#emit("colony-confirm", { kind: "merge" })}
              >
                Approve merge
              </button>`,
      );
    }
    if (task.state === "running") {
      buttons.push(
        this.confirm === "stop"
          ? html`<button class="btn btn-solid" @click=${() => this.#action("stop")}>
              Confirm stop and retry
            </button>`
          : html`<button
              class="btn"
              @click=${() => this.#emit("colony-confirm", { kind: "stop" })}
            >
              Stop run and retry
            </button>`,
      );
    }
    if (task.state === "canceled") {
      buttons.push(
        html`<button class="btn btn-solid" @click=${() => this.#action("restore")}>
          Restore task
        </button>`,
      );
    }
    const waiting =
      task.state === "queued" &&
      task.next_retry_at &&
      Date.parse(task.next_retry_at) > Date.now();
    if (waiting) {
      buttons.push(
        html`<button class="btn" @click=${() => this.#action("retry")}>
          Run now — skip backoff
        </button>`,
      );
    }
    if (!["merged", "canceled"].includes(task.state)) {
      buttons.push(
        this.confirm === "cancel"
          ? html`<button class="btn btn-rev" @click=${() => this.#action("cancel")}>
              Confirm permanent cancel
            </button>`
          : html`<button
              class="btn btn-quiet"
              @click=${() => this.#emit("colony-confirm", { kind: "cancel" })}
            >
              Cancel task permanently
            </button>`,
      );
    }
    return buttons.length
      ? html`<div class="task-actions">${buttons}</div>`
      : nothing;
  }
}

customElements.define("task-drawer", TaskDrawer);