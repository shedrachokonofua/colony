// <goal-card>: the scope's goal brief, ported from renderGoalCard (app.js).
// Long goals clamp until goalOpen opens them; the toggle bubbles
// colony-toggle {key:"goalOpen"}. `error` is the host's current error — the
// sheet passes its banner error down, so the goal the operator is reading
// states it too.
//
// The T5 catalog lists colony-feedback for this card, but no goal-level
// feedback surface exists to back it: the goal is fixed on the default branch
// (app.js waitingOnYou: "fix the goal on the default branch") and colonyd
// exposes no goal mutation, so there is no path this card could post to.
import { ColonyElement, classMap, html, nothing } from "../base.js";

export class GoalCard extends ColonyElement {
  static properties = {
    scope: { type: Object },
    goalOpen: { type: Boolean },
    error: { type: String },
  };

  constructor() {
    super();
    this.scope = null;
    this.goalOpen = false;
    this.error = "";
  }

  render() {
    const scope = this.scope;
    if (!scope) return html``;
    const long = scope.goal.length > 420;
    return html`<aside class="card">
      <p class="card-head">Goal</p>
      <div class="card-body">
        ${this.error
          ? html`<p class="banner-error" role="alert">${this.error}</p>`
          : nothing}
        <p
          class=${classMap({
            "plan-summary": true,
            "is-open": this.goalOpen || !long,
          })}
        >
          ${scope.goal}
        </p>
        ${long
          ? html`<button
              class="goal-toggle"
              @click=${() =>
                this.dispatchEvent(
                  new CustomEvent("colony-toggle", {
                    bubbles: true,
                    detail: { key: "goalOpen" },
                  }),
                )}
            >
              ${this.goalOpen ? "Show less" : "Show more"}
            </button>`
          : html``}
      </div>
    </aside>`;
  }
}

customElements.define("goal-card", GoalCard);
