// <run-feed>: live agent activity for one run. Ported from the monolith's
// renderFeedLog (app.js): the last 40 feed rows as a <ul class="runlog">,
// each with a relative timestamp, event name, and a detail span derived from
// the row's JSON payload (model fallback, phase, or tool + error flag).
import { ColonyElement, html, nothing } from "../base.js";
import { rel } from "../rel-time.js";

function rowDetail(row) {
  let detail;
  try {
    const d = JSON.parse(row.detail_json);
    if (row.event === "pi_model_fallback" && d.from && d.to) {
      detail = `${d.from} → ${d.to}`;
    } else if (typeof d.phase === "string" && d.phase) {
      detail = d.phase;
    } else {
      detail = [d.tool, d.isError ? "error" : ""].filter(Boolean).join(" · ");
    }
  } catch {
    detail = "";
  }
  return detail;
}

export class RunFeed extends ColonyElement {
  static properties = {
    feed: { type: Object },
    run: { type: Object },
  };

  constructor() {
    super();
    this.feed = null;
    this.run = null;
  }

  render() {
    const feed = this.feed;
    const run = this.run;
    if (!feed || !run || feed.runId !== run.id) return nothing;
    if (!feed.rows.length) {
      return html`<p class="note runlog-empty">No agent activity yet.</p>`;
    }
    return html`<ul class="runlog">
      ${feed.rows.slice(-40).map(
        (row) => html`<li>
          <span class="when">${rel(row.at)}</span>
          <span class="ev">${row.event}</span>
          ${rowDetail(row) ? html`<span class="evd">${rowDetail(row)}</span>` : nothing}
        </li>`,
      )}
    </ul>`;
  }
}

customElements.define("run-feed", RunFeed);
