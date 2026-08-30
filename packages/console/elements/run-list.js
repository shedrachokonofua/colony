// <run-list>: a run history for a task or scope. One <run-line> per run,
// keyed by run id (repeat) so poll refreshes patch rows in place instead of
// rebuilding them — a running row's duration keeps ticking across polls.
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
    this.runs = [];
    this.config = null;
    this.task = null;
  }

  render() {
    const rows = this.runs ?? [];
    if (!rows.length) {
      return html`<p class="note">No runs on this task yet.</p>`;
    }
    return html`<section class="run-list">
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