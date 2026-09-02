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
  /** @type {import("../duration.js").Unsubscribe | null} */
  #unsubscribe = null;

  static properties = {
    entries: { type: Array },
    project: { type: Object },
    // Not a lifecycle owner: subscribing to a clock does not make it this
    // element's to start or stop.
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
     *
     * The tab borrows it: it subscribes on connect and unsubscribes on
     * disconnect. It must never start or stop the clock — the shell owns
     * when the interval runs, and the project page mounts this element only
     * while the Running tab is active, so a clock stopped on disconnect
     * would stay dead for every other surface that shares it.
     * @type {import("../duration.js").Ticker | null}
     */
    this.ticker = null;
    this._now = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#subscribe();
  }

  disconnectedCallback() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    super.disconnectedCallback();
  }

  /**
   * Bind the clock without touching its lifecycle. Re-subscribing on a new
   * ticker drops the previous binding first.
   */
  #subscribe() {
    if (!this.ticker || this.#unsubscribe) return;
    this.#unsubscribe = this.ticker.subscribe(() => {
      this._now = Date.now();
    });
  }

  /** @param {Map<string, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    if (!changed.has("ticker")) return;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#subscribe();
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
      @keydown=${
        /** @param {KeyboardEvent} event */ (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openTask();
        }
      }
    >
      <div class="running-main">
        <span
          class="scope-chip mono"
          @click=${
            /** @param {MouseEvent} event */ (event) => {
              event.stopPropagation();
              this.#emit("colony-open-scope", { id: row.scopeId });
            }
          }
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
    const entries =
      /** @type {import("../project-helpers.js").RunningEntry[]} */ (
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
