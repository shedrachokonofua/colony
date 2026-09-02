// <run-list>: a run history for a task or scope. One <run-line> per run,
// keyed by run id (repeat) so poll refreshes patch rows in place instead of
// rebuilding them — a running row's duration keeps ticking across polls.
// The wrapper is the monolith's .runs container (styles.css), so the rows
// keep its column layout.
import { ColonyElement, html, nothing, repeat } from "../base.js";
import "./run-line.js";

export class RunList extends ColonyElement {
  static properties = {
    runs: { type: Array },
    config: { type: Object },
    task: { type: Object },
  };

  constructor() {
    super();
    /** @type {Array<Record<string, any>>} */
    this.runs = [];
    /** @type {Record<string, any> | null} */
    this.config = null;
    /** @type {Record<string, any> | null} */
    this.task = null;
  }

  render() {
    const rows = this.runs ?? [];
    if (!rows.length) {
      return html`<p class="note">No runs on this task yet.</p>`;
    }
    return html`<section class="runs">
      ${repeat(
        rows,
        (run) => run.id,
        (run) =>
          html`<run-line
            .run=${run}
            .config=${this.config}
            .task=${this.task}
          ></run-line>`,
      )}
    </section>`;
  }
}

customElements.define("run-list", RunList);
