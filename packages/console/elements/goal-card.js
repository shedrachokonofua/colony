// <goal-card>: the scope's goal brief, ported from renderGoalCard (app.js).
// Long goals clamp until goalOpen opens them; the toggle bubbles
// colony-toggle {key:"goalOpen"}.
import { ColonyElement, classMap, html } from "../base.js";

export class GoalCard extends ColonyElement {
  static properties = {
    scope: { type: Object },
    goalOpen: { type: Boolean },
  };

  constructor() {
    super();
    this.scope = null;
    this.goalOpen = false;
  }

  render() {
    const scope = this.scope;
    if (!scope) return html``;
    const long = scope.goal.length > 420;
    return html`<aside class="card">
      <p class="card-head">Goal</p>
      <div class="card-body">
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