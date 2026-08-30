// <plan-card>: the architect's plan, its replan-request history, the
// approve/replan HITL controls, and live architect runs. Ported from
// renderPlanCard (app.js). Events-up: colony-open-reader (Expand plan),
// colony-toggle {key:"planOpen"}, colony-confirm {kind:"approve-plan"},
// colony-select-task {taskId:"plan:<i>"} per plan task row, and
// colony-feedback for the replan textarea.
import { ColonyElement, classMap, html, nothing, repeat } from "../base.js";
import { rel } from "../rel-time.js";
import "./run-feed.js";
import "./run-line.js";

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

function parseAuditDetail(raw) {
  if (!raw) return {};
  try {
    const detail = JSON.parse(raw);
    return detail && typeof detail === "object" ? detail : {};
  } catch {
    return {};
  }
}

export function planMarkdown(scope, plan) {
  const title = scope.title || scope.goal;
  const parts = [`# Plan — ${title}`, "", plan.summary || ""];
  if (Array.isArray(plan.acceptance) && plan.acceptance.length) {
    parts.push("", "## Acceptance criteria");
    for (const a of plan.acceptance) {
      parts.push(`- ${a.description}`, "", "```", a.command, "```");
    }
  }
  (plan.tasks || []).forEach((task, index) => {
    const deps = (task.depends_on || []).length
      ? ` (depends on ${task.depends_on.join(", ")})`
      : "";
    parts.push("", `## Task ${index}: ${task.title}${deps}`, "", task.spec || "");
  });
  return parts.join("\n");
}

export class PlanCard extends ColonyElement {
  static properties = {
    scope: { type: Object },
    detail: { type: Object },
    audit: { type: Array },
    planOpen: { type: Boolean },
    scopeRunEvents: { type: Object },
    config: { type: Object },
  };

  constructor() {
    super();
    this.scope = null;
    this.detail = null;
    this.audit = [];
    this.planOpen = false;
    this.scopeRunEvents = null;
    this.config = null;
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  render() {
    const scope = this.scope;
    const detail = this.detail;
    if (!scope) return nothing;
    const plan = parsePlan(scope.plan_json);
    const architectRuns = (detail?.runs || []).filter(
      (run) => run.kind === "architect",
    );
    const replanRequests = (this.audit ?? []).flatMap((row) => {
      if (row.action !== "plan.replan_requested") return [];
      const feedback = parseAuditDetail(row.detail_json).feedback;
      return typeof feedback === "string" && feedback.trim()
        ? [{ ...row, feedback }]
        : [];
    });
    if (!plan && !architectRuns.length) return nothing;
    const summary = plan
      ? plan.summary || "Ready for approval."
      : scope.status === "planning"
        ? "Architect is drawing the plan."
        : "";
    const approvable = scope.status === "planning" && plan;
    return html`<aside class="card">
      <p class="card-head">Plan</p>
      <div class="card-body">
        ${summary
          ? html`<p
              class=${classMap({
                "plan-summary": true,
                "is-open": this.planOpen,
              })}
            >
              ${summary}
            </p>`
          : nothing}
        ${plan
          ? html`<button
              class="goal-toggle"
              @click=${() =>
                this.#emit("colony-open-reader", {
                  title: "Plan",
                  markdown: planMarkdown(scope, plan),
                })}
            >
              Expand plan
            </button>`
          : summary.length > 360
            ? html`<button
                class="goal-toggle"
                @click=${() => this.#emit("colony-toggle", { key: "planOpen" })}
              >
                ${this.planOpen ? "Show less" : "Show more"}
              </button>`
            : nothing}
        ${replanRequests.length
          ? html`<section
              class="plan-history"
              aria-label="Replan request history"
            >
              <p class="plan-history-title">
                Replan requests <span>${replanRequests.length}</span>
              </p>
              <ol>
                ${repeat(
                  replanRequests,
                  (row) => row.id,
                  (row) =>
                    html`<li>
                      <p class="plan-history-meta">
                        <span>${rel(row.at)}</span><span>${row.actor}</span>
                      </p>
                      <p>${row.feedback}</p>
                    </li>`,
                )}
              </ol>
            </section>`
          : nothing}
        ${approvable
          ? html`<div class="plan-actions">
                <button
                  class="btn btn-solid"
                  @click=${() =>
                    this.#emit("colony-confirm", { kind: "approve-plan" })}
                >
                  Approve plan
                </button>
                ${this.#planTaskList(plan)}
              </div>
              <form
                class="feedback"
                @submit=${(event) => {
                  event.preventDefault();
                  this.#emit("colony-feedback", {
                    path: `/scopes/${scope.id}/replan`,
                    body: {
                      feedback: String(
                        new FormData(event.target).get("feedback") ?? "",
                      ),
                    },
                  });
                }}
              >
                <textarea
                  name="feedback"
                  required
                  placeholder="What should the architect change? Rejecting re-plans with this feedback."
                ></textarea>
                <button class="btn" type="submit">Request replan</button>
              </form>`
          : nothing}
        ${architectRuns.length
          ? html`<div class="runs runs-inline">
              ${architectRuns.map(
                (run) =>
                  html`<run-line .run=${run} .config=${this.config}></run-line>${run.status === "running"
                    ? html`<run-feed
                        .feed=${this.scopeRunEvents}
                        .run=${run}
                      ></run-feed>`
                    : nothing}`,
              )}
            </div>`
          : nothing}
      </div>
    </aside>`;
  }

  #planTaskList(plan) {
    return html`<ol class="plan-tasks">
      ${plan.tasks.map(
        (task, index) =>
          html`<li>
            <button
              class="plan-task"
              @click=${() =>
                this.#emit("colony-select-task", { taskId: `plan:${index}` })}
            >
              ${task.title}
            </button>
          </li>`,
      )}
    </ol>`;
  }
}

customElements.define("plan-card", PlanCard);