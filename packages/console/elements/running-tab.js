// <running-tab>: a project's in-flight work — one row per task that has not
// reached a terminal state, with its scope, attempt, live run kind/model, and
// a duration that ticks while the run has no end. Ported from the monolith's
// renderRunningTab/renderRunningRow (app.js).
//
// Property-down: the API's rows (the shell's projectRunning) and the project
// whose task_state_counts back the empty state. Events-up: colony-open-task
// {scopeId, taskId} to land on the task's drawer, and colony-open-scope
// {id} from a row's scope chip, which stops propagation so the chip alone
// navigates.
//
// Rows are keyed `${scope_id}:${task_id}` so a poll that re-sends the list
// patches rows in place: a running row's duration keeps ticking across
// refreshes instead of restarting from zero.
import { ColonyElement, classMap, html, nothing, repeat } from "../base.js";
import { KIND_LABEL } from "../kind-label.js";
import {
  deriveRunningRow,
  formatRunningEmptyTallies,
} from "../project-helpers.js";
import {
  durationAriaLabel,
  formatDuration,
  isoDuration,
  runDurationMs,
} from "../duration.js";
import "./run-duration.js";

export class RunningTab extends ColonyElement {
  static properties = {
    entries: { type: Array },
    project: { type: Object },
    ticker: { type: Object },
    // The clock a live duration reads. Reactive, because the ticker's whole
    // job is to move it — a plain field would advance the number without
    // ever repainting the row.
    _now: { state: true },
  };

  constructor() {
    super();
    /** @type {import("../project-helpers.js").RunningEntry[]} */
    this.entries = [];
    /** @type {Record<string, any> | null} */
    this.project = null;
    /**
     * The clock behind a row's live duration. Injected (never constructed
     * here) so a test can drive ticks without waiting on wall time; null
     * means durations render finished-or-static.
     * @type {import("../duration.js").Ticker | null}
     */
    this.ticker = null;
    this._now = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.ticker) {
      this.ticker.onTick(() => {
        this._now = Date.now();
      });
      this.ticker.start();
    }
  }

  disconnectedCallback() {
    this.ticker?.stop();
    super.disconnectedCallback();
  }

  /** @param {string} type @param {Record<string, unknown>} detail */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  /**
   * One row: the monolith's renderRunningRow. The row body is a click target
   * that opens the task; the scope chip inside it navigates to the scope
   * alone, so it swallows the click before it reaches the row.
   *
   * @param {import("../project-helpers.js").RunningEntry} entry
   */
  #row(entry) {
    const row = deriveRunningRow(entry);
    const nowMs = this._now || Date.now();
    const runMs = row.hasRun && row.run ? runDurationMs(row.run, nowMs) : null;
    const durationText = runMs !== null ? formatDuration(runMs) : "—";
    const durationIso = runMs !== null ? isoDuration(runMs) : null;
    const durationLabel =
      row.hasRun && row.run && runMs !== null
        ? durationAriaLabel(row.run, nowMs)
        : null;
    const runKind = row.runKind ? (KIND_LABEL[row.runKind] ?? row.runKind) : "";
    const runInfo = [runKind, row.runModel].filter(Boolean).join(" · ");
    const openTask = () =>
      this.#emit("colony-open-task", {
        scopeId: row.scopeId,
        taskId: row.taskId,
      });
    return html`<div
      class="running-row"
      tabindex="0"
      role="button"
      @click=${openTask}
      @keydown=${/** @param {KeyboardEvent} event */ (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openTask();
      }}
    >
      <div class="running-main">
        <span
          class="scope-chip mono"
          @click=${/** @param {MouseEvent} event */ (event) => {
            event.stopPropagation();
            this.#emit("colony-open-scope", { id: row.scopeId });
          }}
          >${row.scopeTitle}</span
        >
        <span class="running-task-title">${row.taskTitle}</span>
      </div>
      <div class="running-meta">
        <span class="badge" data-state=${row.taskState}>${row.taskState}</span>
        <span class="running-attempt mono">${row.attemptText}</span>
        ${runInfo
          ? html`<span class="running-run-info">${runInfo}</span>`
          : nothing}
        <span
          class=${classMap({
            "running-duration": true,
            mono: true,
            live: row.isRunning,
          })}
          aria-label=${durationLabel || nothing}
          title=${durationIso || nothing}
          >${durationText}</span
        >
      </div>
    </div>`;
  }

  /** The monolith's empty state: the copy plus the queued/blocked tallies. */
  #empty() {
    const tallies = formatRunningEmptyTallies(this.project?.task_state_counts);
    return html`<div class="running-empty rack-empty">
      <p>Nothing running right now.</p>
      ${tallies
        ? html`<p class="running-tallies mono">${tallies}</p>`
        : nothing}
    </div>`;
  }

  render() {
    const entries = /** @type {import("../project-helpers.js").RunningEntry[]} */ (
      this.entries ?? []
    );
    if (!entries.length) return this.#empty();
    return html`<div class="running-list">
      ${repeat(
        entries,
        (entry) => `${entry.scope_id}:${entry.task_id}`,
        (entry) => this.#row(entry),
      )}
    </div>`;
  }
}

customElements.define("running-tab", RunningTab);
