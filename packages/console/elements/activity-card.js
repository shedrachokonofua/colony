// <activity-card>: the scope's audit ledger tail, ported from renderActivity
// (app.js): the last 10 rows as timestamp + action + actor.
import { ColonyElement, html, repeat } from "../base.js";
import { rel } from "../rel-time.js";

export class ActivityCard extends ColonyElement {
  static properties = {
    audit: { type: Array },
  };

  constructor() {
    super();
    this.audit = [];
  }

  render() {
    const rows = (this.audit ?? []).slice(0, 10);
    return html`<aside class="card">
      <p class="card-head">Activity</p>
      <div class="card-body">
        <ul class="activity">
          ${rows.length
            ? repeat(
                rows,
                (row) => row.id,
                (row) =>
                  html`<li>
                    <span class="when">${rel(row.at)}</span>
                    <span>
                      <span class="what">${row.action}</span>
                      <span class="who">${row.actor}</span>
                    </span>
                  </li>`,
              )
            : html`<li><span class="note">Nothing yet.</span></li>`}
        </ul>
      </div>
    </aside>`;
  }
}

customElements.define("activity-card", ActivityCard);