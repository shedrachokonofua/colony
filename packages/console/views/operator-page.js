// <operator-page>: the fleet-first Operator console — Waiting on you, Live
// (stalled first), Metrics (24h/7d), Unclassified faults, and Deploy.
//
// Property-down: the GET /operator/summary payload verbatim (the shell's
// operatorSummary), the active window, and the shell's error banner. Events-
// up: colony-navigate from every scope/task link and colony-operator-window
// {window} from the metrics toggle.
//
// The view recomputes nothing. Every count it prints is a field the server
// computed over the ONE window read that also produced the rows below it, so
// a number can never disagree with the list beside it. Nothing here fetches:
// the shell owns every read, and the window toggle is a refetch of that same
// route rather than a second dataset.
//
// Text is rendered as served. Fault details and blocked reasons arrive
// redacted from colonyd; this page never reads a stored error and never
// redacts client-side, so an unredacted string cannot reach the screen.
import { ColonyElement, html, nothing, repeat } from "../base.js";
import { rel } from "../rel-time.js";
import { formatDuration } from "../duration.js";
import { KIND_LABEL } from "../kind-label.js";

/** @typedef {"24h" | "7d"} OperatorWindow */

/** The two windows GET /operator/summary accepts; the API 400s on any other. */
export const OPERATOR_WINDOWS = /** @type {const} */ (["24h", "7d"]);

const WINDOW_LABEL = { "24h": "24 hours", "7d": "7 days" };

/** @param {string | undefined} window */
function windowLabel(window) {
  return window === "7d" ? WINDOW_LABEL["7d"] : WINDOW_LABEL["24h"];
}

/** @param {string} scopeId */
function scopeHref(scopeId) {
  return `#/${encodeURIComponent(scopeId)}`;
}

/**
 * The scope a task id belongs to. Task ids are `<scope>.<n>` (the store
 * mints them that way), and the unclassified row carries only the task —
 * so this is how its run link reaches the scope the operator can open.
 *
 * @param {string | null | undefined} taskId
 */
function scopeOfTask(taskId) {
  if (!taskId) return null;
  const dot = taskId.lastIndexOf(".");
  return dot > 0 ? taskId.slice(0, dot) : null;
}

/** @param {string | null | undefined} sha */
function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "—";
}

/**
 * `PT…S` age as a compact duration. The server sends the ISO-8601 form so
 * the wire stays unambiguous; an operator reads minutes, not seconds-since.
 *
 * @param {string | null | undefined} age
 */
export function ageLabel(age) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(age ?? ""));
  if (!match) return age ? String(age) : "—";
  const [, h, m, s] = match;
  const totalSec =
    Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return formatDuration(totalSec * 1000);
}

/** @param {string} kind */
function kindLabel(kind) {
  return KIND_LABEL[/** @type {keyof typeof KIND_LABEL} */ (kind)] ?? kind;
}

export class OperatorPage extends ColonyElement {
  static properties = {
    summary: { type: Object },
    window: { type: String },
    error: { type: String },
  };

  constructor() {
    super();
    /** @type {Record<string, any> | null} */
    this.summary = null;
    /** @type {OperatorWindow} */
    this.window = "24h";
    this.error = "";
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  /**
   * Every scope/task link routes through colony-navigate; modified clicks
   * keep the anchor so middle-click still opens a tab.
   *
   * @param {MouseEvent} event @param {string} href
   */
  #nav(event, href) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
    event.preventDefault();
    this.#emit("colony-navigate", { href });
  }

  /**
   * The one section-wide empty state. Copy names the section so the page
   * never reads as a blank column.
   *
   * @param {string} copy
   */
  #empty(copy) {
    return html`<p class="rack-empty operator-empty">${copy}</p>`;
  }

  // -- Waiting on you -----------------------------------------------------

  /** @param {Record<string, any>} waiting */
  #waiting(waiting) {
    const plans = waiting?.plan_approvals ?? [];
    const merges = waiting?.awaiting_merge ?? [];
    const tasks = waiting?.blocked_tasks ?? [];
    const scopes = waiting?.blocked_scopes ?? [];
    if (!plans.length && !merges.length && !tasks.length && !scopes.length) {
      return this.#empty("Nothing is waiting on you — the fleet is unblocked.");
    }
    return html`<div class="operator-groups">
      ${plans.length
        ? html`<div class="operator-group">
            <p class="operator-group-head">Plans to approve (${plans.length})</p>
            <ul class="operator-list">
              ${repeat(
                plans,
                (row) => `plan:${row.scope_id}`,
                (row) =>
                  html`<li class="operator-row">
                    ${this.#anchor(row.scope_id, scopeHref(row.scope_id))}
                    <span class="note">plan ready</span>
                  </li>`,
              )}
            </ul>
          </div>`
        : nothing}
      ${merges.length
        ? html`<div class="operator-group">
            <p class="operator-group-head">
              Merges to approve (${merges.length})
            </p>
            <ul class="operator-list">
              ${repeat(
                merges,
                (row) => `merge:${row.task_id}`,
                (row) =>
                  html`<li class="operator-row">
                    ${this.#anchor(row.scope_id, scopeHref(row.scope_id))}
                    ${this.#taskAnchor(
                      row.task_id,
                      row.scope_id,
                      row.task_id,
                    )}
                    <span class="mono operator-head-sha"
                      >${shortSha(row.head_sha)}</span
                    >
                  </li>`,
              )}
            </ul>
          </div>`
        : nothing}
      ${tasks.length
        ? html`<div class="operator-group">
            <p class="operator-group-head">Blocked tasks (${tasks.length})</p>
            <ul class="operator-list">
              ${repeat(
                tasks,
                (row) => `task:${row.task_id}`,
                (row) =>
                  html`<li class="operator-row">
                    ${this.#anchor(row.scope_id, scopeHref(row.scope_id))}
                    ${this.#taskAnchor(
                      row.task_id,
                      row.scope_id,
                      row.task_id,
                    )}
                    <span class="note"
                      >${row.blocked_reason ?? "no reason recorded"}</span
                    >
                    <span class="mono operator-age"
                      >${ageLabel(row.age)}</span
                    >
                  </li>`,
              )}
            </ul>
          </div>`
        : nothing}
      ${scopes.length
        ? html`<div class="operator-group">
            <p class="operator-group-head">Blocked scopes (${scopes.length})</p>
            <ul class="operator-list">
              ${repeat(
                scopes,
                (row) => `scope:${row.scope_id}`,
                (row) =>
                  html`<li class="operator-row">
                    ${this.#anchor(row.scope_id, scopeHref(row.scope_id))}
                    <span class="note"
                      >${row.blocked_reason ?? "no reason recorded"}</span
                    >
                    <span class="mono operator-age"
                      >${ageLabel(row.age)}</span
                    >
                  </li>`,
              )}
            </ul>
          </div>`
        : nothing}
    </div>`;
  }

  /** @param {string} label @param {string} href */
  #anchor(label, href) {
    return html`<a
      class="operator-link mono"
      href=${href}
      @click=${/** @param {MouseEvent} event */ (event) =>
        this.#nav(event, href)}
      >${label}</a
    >`;
  }

  /**
   * A task link. Opening a task is a navigation plus a deferred selection
   * (the shell parks the id until the scope's detail lands), so the row
   * emits colony-open-task rather than inventing a `?task=` route the
   * router has never parsed.
   *
   * @param {string} label @param {string} scopeId @param {string} taskId
   */
  #taskAnchor(label, scopeId, taskId) {
    return html`<a
      class="operator-link mono"
      href=${scopeHref(scopeId)}
      @click=${
        /** @param {MouseEvent} event */ (event) => {
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.button
          )
            return;
          event.preventDefault();
          this.#emit("colony-open-task", { scopeId, taskId });
        }
      }
      >${label}</a
    >`;
  }

  // -- Live ---------------------------------------------------------------

  /** @param {Record<string, any>[]} live */
  #live(live) {
    if (!live.length) {
      return this.#empty("Nothing is running right now.");
    }
    // Stalled first: a stalled run needs a decision, and a healthy fleet
    // scrolls the healthy rows off the top.
    const ordered = [...live].sort((a, b) => Number(b.stalled) - Number(a.stalled));
    return html`<ul class="operator-list">
      ${repeat(
        ordered,
        (run) => run.id,
        (run) =>
          html`<li class="operator-row${run.stalled ? " is-stalled" : ""}">
            ${run.stalled
              ? html`<span class="chip" data-kind="blocked">stalled</span>`
              : html`<span class="chip" data-kind="running">live</span>`}
            ${this.#anchor(run.scope_id, scopeHref(run.scope_id))}
            ${run.task_id
              ? this.#taskAnchor(run.task_id, run.scope_id, run.task_id)
              : nothing}
            <span>${kindLabel(run.kind)}</span>
            <span class="mono operator-run-id">${run.id}</span>
            ${run.model_id
              ? html`<span class="mono">${run.model_id}</span>`
              : nothing}
            ${run.active_tool
              ? html`<span class="mono">${run.active_tool}</span>`
              : nothing}
            <span class="mono operator-age"
              >${rel(run.last_progress_at ?? run.started_at)}</span
            >
          </li>`,
      )}
    </ul>`;
  }

  // -- Metrics ------------------------------------------------------------

  /**
   * One compact metrics table.
   *
   * Rows are divs carrying the table's ARIA roles rather than <tr>/<td>:
   * lit renders each row from its own template, and an HTML parser drops a
   * bare <tr> at the root of a fragment (it is only valid inside a table),
   * which silently emptied these tables. The roles keep it a real table to
   * assistive tech.
   *
   * @param {{ label: string, columns: string[], rows: any[][] }} args
   */
  #table({ label, columns, rows }) {
    return html`<div class="operator-table" role="table" aria-label=${label}>
      <div class="operator-tr" role="row">
        ${columns.map(
          (column) => html`<span class="operator-th" role="columnheader"
            >${column}</span
          >`,
        )}
      </div>
      ${repeat(
        rows,
        (row) => row.key,
        (row) => html`<div class="operator-tr" role="row">
          ${row.cells.map(
            (cell) => html`<span class="operator-td" role="cell"
              >${cell}</span
            >`,
          )}
        </div>`,
      )}
    </div>`;
  }

  /** @param {Record<string, any>} metrics */
  #metrics(metrics) {
    const byKind = Object.entries(metrics?.runs_by_kind_status ?? {});
    const perModel = Object.entries(metrics?.per_model ?? {});
    const byLayer = Object.entries(metrics?.faults_by_layer ?? {});
    const incidents = metrics?.restart_incidents ?? {
      incidents: 0,
      reaped_runs: 0,
    };
    if (!byKind.length && !perModel.length && !byLayer.length) {
      return this.#empty("No runs in this window — nothing to measure yet.");
    }
    return html`<div class="operator-groups">
      <div class="operator-group">
        <p class="operator-group-head">Runs by role</p>
        ${byKind.length
          ? this.#table({
              label: "Runs by role and outcome",
              columns: ["Role", "Outcome", "Runs"],
              rows: byKind.map(([key, count]) => {
                const [role, outcome] = String(key).split(":");
                return {
                  key,
                  cells: [
                    kindLabel(role),
                    html`<span class="chip" data-kind=${outcome}
                      >${outcome}</span
                    >`,
                    count,
                  ],
                };
              }),
            })
          : this.#empty("No runs finished in this window.")}
        <p class="operator-tally">
          <span class="mono">${metrics?.merges ?? 0}</span> merges ·
          <span class="mono">${metrics?.verdicts ?? 0}</span> verdicts ·
          <span class="mono">${metrics?.validation?.pass ?? 0}</span> passed /
          <span class="mono">${metrics?.validation?.fail ?? 0}</span> failed
          validation
        </p>
      </div>
      <div class="operator-group">
        <p class="operator-group-head">Per model</p>
        ${perModel.length
          ? this.#table({
              label: "Per-model completion, timeouts and median runtime",
              columns: ["Model", "Completion", "Timeouts", "Median"],
              rows: perModel.map(([model, m]) => {
                const stats = /** @type {Record<string, any>} */ (m);
                const rate = stats.completion_rate;
                return {
                  key: model,
                  cells: [
                    html`<span class="mono">${model}</span>`,
                    typeof rate === "number"
                      ? `${Math.round(rate * 100)}% of ${stats.runs}`
                      : "—",
                    stats.timeouts,
                    stats.median_ms === null
                      ? "—"
                      : formatDuration(stats.median_ms),
                  ],
                };
              }),
            })
          : this.#empty("No model ran in this window.")}
      </div>
      <div class="operator-group">
        <p class="operator-group-head">Faults by layer</p>
        ${byLayer.length
          ? this.#table({
              label: "Faults by layer",
              columns: ["Layer", "Faults"],
              rows: byLayer.map(([layer, count]) => ({
                key: layer,
                cells: [layer, count],
              })),
            })
          : this.#empty("No faults recorded in this window.")}
      </div>
      <div class="operator-group">
        <p class="operator-group-head">Restart incidents</p>
        ${
          // ONE line: a restart that reaps N runs is one outage with N
          // victims, and printing it per-run would read as N outages.
          this.#restartLine(incidents)
        }
      </div>
    </div>`;
  }

  /** @param {{ incidents?: number, reaped_runs?: number }} incidents */
  #restartLine(incidents) {
    const n = incidents?.incidents ?? 0;
    const reaped = incidents?.reaped_runs ?? 0;
    if (n === 0) {
      return this.#empty("No restart incidents in this window.");
    }
    return html`<p class="operator-restart">
      ${n} restart incident${n === 1 ? "" : "s"} reaped ${reaped} run${reaped ===
      1
        ? ""
        : "s"}.
    </p>`;
  }

  // -- Unclassified faults ------------------------------------------------

  /** @param {Record<string, any>[]} unclassified */
  #unclassified(unclassified) {
    if (!unclassified.length) {
      return this.#empty("No unclassified faults in this window.");
    }
    return html`<ul class="operator-list">
      ${repeat(
        unclassified,
        (row) => row.run_id,
        (row) =>
          html`<li class="operator-row">
            <span class="chip" data-kind="failed">unclassified</span>
            ${(() => {
              // The row carries no scope_id of its own: the task id is how
              // its run link reaches a scope.
              const scopeId = row.scope_id ?? scopeOfTask(row.task_id);
              return scopeId
                ? this.#anchor(scopeId, scopeHref(scopeId))
                : html`<span class="mono">unknown scope</span>`;
            })()}
            ${row.task_id && scopeOfTask(row.task_id)
              ? this.#taskAnchor(
                  row.task_id,
                  scopeOfTask(row.task_id),
                  row.task_id,
                )
              : nothing}
            <span>${kindLabel(row.kind)}</span>
            ${row.model_id
              ? html`<span class="mono">${row.model_id}</span>`
              : nothing}
            <span class="operator-detail">${row.detail}</span>
            <span class="mono operator-age">${rel(row.finished_at)}</span>
          </li>`,
      )}
    </ul>`;
  }

  // -- Deploy -------------------------------------------------------------

  /** @param {Record<string, any>} deploy */
  #deploy(deploy) {
    if (!deploy) return this.#empty("No deploy reported.");
    const incidents = deploy.restart_incidents ?? {
      incidents: 0,
      reaped_runs: 0,
    };
    return html`<dl class="operator-deploy">
      <div>
        <dt>Version</dt>
        <dd class="mono">${deploy.version ?? "unknown"}</dd>
      </div>
      <div>
        <dt>Uptime</dt>
        <dd class="mono">${rel(deploy.started_at)}</dd>
      </div>
      <div>
        <dt>Restarts</dt>
        <dd class="mono">${incidents.incidents ?? 0}</dd>
      </div>
    </dl>`;
  }

  render() {
    const summary = this.summary;
    return html`${this.error
        ? html`<div class="banner banner-error" role="alert">
            ${this.error}
          </div>`
        : nothing}
      <div class="operator-page" id="draw">
        <header class="board-head">
          <h1 class="board-title">Operator</h1>
          <div class="board-head-actions">
            <nav class="tabs" role="tablist" aria-label="Metrics window">
              ${OPERATOR_WINDOWS.map(
                (w) => html`<button
                  class="tab"
                  role="tab"
                  aria-selected=${this.window === w}
                  @click=${() => this.#window(w)}
                >
                  ${WINDOW_LABEL[w]}
                </button>`,
              )}
            </nav>
          </div>
        </header>
        ${summary
          ? html`<p class="operator-generated note">
                Window ${windowLabel(summary.window)} · generated
                ${rel(summary.generated_at)}
              </p>
              <section class="card operator-section">
                <p class="card-head">Waiting on you</p>
                <div class="card-body">
                  ${this.#waiting(summary.waiting_on_you)}
                </div>
              </section>
              <section class="card operator-section">
                <p class="card-head">Live (${summary.live?.length ?? 0})</p>
                <div class="card-body">${this.#live(summary.live ?? [])}</div>
              </section>
              <section class="card operator-section">
                <p class="card-head">Metrics</p>
                <div class="card-body">${this.#metrics(summary.metrics)}</div>
              </section>
              <section class="card operator-section">
                <p class="card-head">
                  Unclassified faults
                  (${summary.unclassified?.length ?? 0})
                </p>
                <div class="card-body">
                  ${this.#unclassified(summary.unclassified ?? [])}
                </div>
              </section>
              <section class="card operator-section">
                <p class="card-head">Deploy</p>
                <div class="card-body">${this.#deploy(summary.deploy)}</div>
              </section>`
          : html`<p class="boot">Loading operator summary…</p>`}
      </div>`;
  }

  /** @param {OperatorWindow} window */
  #window(window) {
    if (this.window === window) return;
    this.#emit("colony-operator-window", { window });
  }
}

customElements.define("operator-page", OperatorPage);
