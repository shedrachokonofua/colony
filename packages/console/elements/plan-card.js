// <plan-card>: the architect's plan, its replan-request history, the
// approve/replan HITL controls, and live architect runs. Ported from
// renderPlanCard (app.js). Events-up: colony-open-reader (Expand plan),
// colony-toggle {key:"planOpen"}, colony-confirm {kind:"approve-plan"},
// colony-select-task {taskId:"plan:<i>"} per plan task row, and
// colony-feedback for the replan textarea.
import { ColonyElement, classMap, html, nothing, repeat } from "../base.js";
import { parsePlan } from "../dag.js";
import { rel } from "../rel-time.js";
import "./run-feed.js";
import "./run-line.js";

/** @param {string | null | undefined} raw @returns {{ [key: string]: any }} */
function parseAuditDetail(raw) {
  if (!raw) return {};
  try {
    const detail = JSON.parse(raw);
    return detail && typeof detail === "object" ? detail : {};
  } catch {
    return {};
  }
}

/**
 * The plan as the reader renders it: title line per task, acceptance block.
 * @param {Record<string, any>} scope
 * @param {import("../dag.js").Plan} plan
 */
export function planMarkdown(scope, plan) {
  const title = scope.title || scope.goal;
  const parts = [`# Plan — ${title}`, "", plan.summary || ""];
  if (Array.isArray(plan.requirements) && plan.requirements.length) {
    parts.push("", "## Requirements");
    for (const r of plan.requirements) {
      const via = (r.tasks ?? []).length
        ? ` — tasks ${(r.tasks ?? []).join(", ")}`
        : "";
      parts.push(`- **${r.id ?? ""}** ${r.text ?? ""}${via}`);
    }
  }
  if (Array.isArray(plan.journey) && plan.journey.length) {
    parts.push("", "## Journey");
    for (const step of plan.journey) {
      parts.push(
        `- after task ${step.after_task ?? "?"}: ${step.working_state ?? ""}`,
      );
    }
  }
  if (Array.isArray(plan.acceptance) && plan.acceptance.length) {
    parts.push("", "## Acceptance criteria");
    for (const a of plan.acceptance) {
      parts.push(`- ${a.description ?? ""}`, "", "```", a.command ?? "", "```");
    }
  }
  (plan.tasks || []).forEach(
    (
      /** @type {import("../dag.js").PlanTask} */ task,
      /** @type {number} */ index,
    ) => {
      const deps = (task.depends_on ?? []).length
        ? ` (depends on ${(task.depends_on ?? []).join(", ")})`
        : "";
      parts.push(
        "",
        `## Task ${index}: ${task.title}${deps}`,
        "",
        task.spec || "",
      );
      if (Array.isArray(task.files) && task.files.length) {
        parts.push("", "**Files**", "", ...task.files.map((f) => `- \`${f}\``));
      }
      if (Array.isArray(task.evidence) && task.evidence.length) {
        parts.push("", "**Evidence**", "", "```", ...task.evidence, "```");
      }
    },
  );
  return parts.join("\n");
}

export const PLAN_REVIEW_CAP_REASON =
  /^plan review rejected \d+ consecutive times$/;

/**
 * @param {Record<string, any> | null | undefined} scope
 * @param {import("../dag.js").Plan | null} plan
 */
export function isCapBlockedWithPlan(scope, plan) {
  return Boolean(
    scope &&
      scope.status === "blocked" &&
      typeof scope.blocked_reason === "string" &&
      PLAN_REVIEW_CAP_REASON.test(scope.blocked_reason) &&
      plan,
  );
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
    /** @type {Record<string, any> | null} */
    this.scope = null;
    /** @type {Record<string, any> | null} */
    this.detail = null;
    /** @type {Array<Record<string, any>>} */
    this.audit = [];
    this.planOpen = false;
    /** @type {Record<string, any> | null} */
    this.scopeRunEvents = null;
    /** @type {import("../trace-link.js").TraceLinkConfig & Record<string, any> | null} */
    this.config = null;
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  render() {
    const scope = this.scope;
    const detail = this.detail;
    if (!scope) return nothing;
    const plan = parsePlan(scope.plan_json);
    const detailRuns = /** @type {any[]} */ (detail?.runs || []);
    // Plan reviews sit beside the architect runs: the verdict and its
    // findings are why a plan is waiting for you or went back for a replan.
    const architectRuns = detailRuns.filter(
      (run) => run.kind === "architect" || run.kind === "plan_review",
    );
    const replanRequests = (this.audit ?? []).flatMap((row) => {
      if (row.action !== "plan.replan_requested") return [];
      const feedback = parseAuditDetail(row.detail_json).feedback;
      return typeof feedback === "string" && feedback.trim()
        ? [
            /** @type {{ id: any, at: string, actor: string, feedback: string }} */ ({
              ...row,
              feedback,
            }),
          ]
        : [];
    });
    if (!plan && !architectRuns.length) return nothing;
    const summary = plan
      ? plan.summary || "Ready for approval."
      : scope.status === "planning"
        ? "Architect is drawing the plan."
        : "";
    const approvable = scope.status === "planning" && plan;
    const isCapBlocked = isCapBlockedWithPlan(scope, plan);
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
                    this.#emit("colony-task-action", {
                      path: `/scopes/${scope.id}/approve-plan`,
                    })}
                >
                  Approve plan
                </button>
                ${this.#planTaskList(plan)}
              </div>
              <form
                class="feedback"
                @submit=${
                  /** @param {SubmitEvent} event */ (event) => {
                    event.preventDefault();
                    this.#emit("colony-feedback", {
                      path: `/scopes/${scope.id}/replan`,
                      body: {
                        feedback: String(
                          new FormData(
                            /** @type {HTMLFormElement} */ (event.target),
                          ).get("feedback") ?? "",
                        ),
                      },
                    });
                  }
                }
              >
                <textarea
                  name="feedback"
                  required
                  placeholder="What should the architect change? Rejecting re-plans with this feedback."
                ></textarea>
                <button class="btn" type="submit">Request replan</button>
              </form>`
          : nothing}
        ${isCapBlocked
          ? html`<div class="plan-actions cap-actions">
                <button
                  class="btn btn-solid"
                  @click=${() =>
                    this.#emit("colony-task-action", {
                      path: `/scopes/${scope.id}/plan-review-continue`,
                    })}
                >
                  Continue
                </button>
                <button
                  class="btn"
                  @click=${() =>
                    this.#emit("colony-task-action", {
                      path: `/scopes/${scope.id}/plan-review-approve`,
                    })}
                >
                  Approve latest plan
                </button>
                <button
                  class="btn btn-danger"
                  @click=${() =>
                    this.#emit("colony-abandon", {
                      scopeId: scope.id,
                    })}
                >
                  Abandon
                </button>
                ${this.#planTaskList(plan)}
              </div>
              <form
                class="feedback"
                @submit=${
                  /** @param {SubmitEvent} event */ (event) => {
                    event.preventDefault();
                    this.#emit("colony-feedback", {
                      path: `/scopes/${scope.id}/plan-review-replan`,
                      body: {
                        feedback: String(
                          new FormData(
                            /** @type {HTMLFormElement} */ (event.target),
                          ).get("feedback") ?? "",
                        ),
                      },
                    });
                  }
                }
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
              ${repeat(
                architectRuns,
                (run) => run.id,
                (run) =>
                  html`<run-line .run=${run} .config=${this.config}></run-line
                    >${run.status === "running"
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

  /** @param {import("../dag.js").Plan | null} plan */
  #planTaskList(plan) {
    return html`<ol class="plan-tasks">
      ${
        /** @type {import("../dag.js").Plan} */ (plan).tasks.map(
          (
            /** @type {import("../dag.js").PlanTask} */ task,
            /** @type {number} */ index,
          ) =>
            html`<li>
              <button
                class="plan-task"
                @click=${() =>
                  this.#emit("colony-select-task", { taskId: `plan:${index}` })}
              >
                ${task.title}
              </button>
            </li>`,
        )
      }
    </ol>`;
  }
}

customElements.define("plan-card", PlanCard);
