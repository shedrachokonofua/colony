// <run-duration>: live duration readout for one run. Finished runs render
// statically; running runs tick once a second until they finish or leave the
// document — the element form of the monolith's duration ticker.
import { ColonyElement, html } from "../base.js";
import {
  createRunTicker,
  durationAriaLabel,
  formatDuration,
  isoDuration,
  runDurationMs,
} from "../duration.js";

export class RunDuration extends ColonyElement {
  static properties = {
    startedAt: { type: String },
    finishedAt: { type: String },
    _now: { state: true },
  };

  #ticker = createRunTicker(() => {
    this._now = Date.now();
  });

  constructor() {
    super();
    this.startedAt = "";
    this.finishedAt = null;
    this._now = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#syncTicker();
  }

  disconnectedCallback() {
    this.#ticker.stop();
    super.disconnectedCallback();
  }

  updated(changed) {
    super.updated(changed);
    // The clock runs only while the run has no end; finishing (or a new run
    // reusing the element) starts/stops it to match.
    if (changed.has("startedAt") || changed.has("finishedAt")) {
      this.#syncTicker();
    }
  }

  #syncTicker() {
    if (this.finishedAt == null || this.finishedAt === "") {
      this.#ticker.start();
    } else {
      this.#ticker.stop();
    }
  }

  render() {
    if (!this.startedAt) return html`<time class="dur">—</time>`;
    const run = { started_at: this.startedAt, finished_at: this.finishedAt };
    const now = this._now || Date.now();
    const ms = runDurationMs(run, now);
    if (ms === null) return html`<time class="dur">—</time>`;
    return html`<time
      class="dur"
      datetime=${isoDuration(ms)}
      title=${`started ${this.startedAt}${this.finishedAt ? `, finished ${this.finishedAt}` : ""}`}
      aria-label=${durationAriaLabel(run, now)}
      >${formatDuration(ms)}</time
    >`;
  }
}

customElements.define("run-duration", RunDuration);
