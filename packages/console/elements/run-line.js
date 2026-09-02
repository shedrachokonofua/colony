// <run-line>: one row in a task's or scope's run history. Ported from the
// monolith's runLine (app.js): status dot, kind/status line, verdict chip,
// meta line (model, head sha, relative time, live duration, error), trace
// deep link, and evidence findings. CSS classes match the monolith's:
// <run-line> is the monolith's div.run, styled at styles.css .run.
import { ColonyElement, html, nothing } from "../base.js";
import { KIND_LABEL } from "../kind-label.js";
import { rel } from "../rel-time.js";
import { traceHref } from "../trace-link.js";
import {
  costPredictionLines,
  parseCostPrediction,
} from "../cost-prediction.js";
import "./run-duration.js";

/** @param {string | null | undefined} sha */
function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "—";
}

/** @param {string | null | undefined} raw */
function parseEvidence(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class RunLine extends ColonyElement {
  static properties = {
    run: { type: Object },
    config: { type: Object },
    task: { type: Object },
  };

  constructor() {
    super();
    /** @type {import("../trace-link.js").TraceLinkRun & Record<string, any> | null} */
    this.run = null;
    /** @type {import("../trace-link.js").TraceLinkConfig & Record<string, any> | null} */
    this.config = null;
    /** @type {import("../cost-prediction.js").TaskWithCostPrediction & Record<string, any> | null} */
    this.task = null;
  }

  render() {
    const run = this.run;
    if (!run) return nothing;
    const traceUrl = traceHref(this.config ?? {}, run);
    const evidence = parseEvidence(run.evidence_json);
    const findings = Array.isArray(evidence?.findings)
      ? html`<ul class="findings">
          ${
            /** @type {{findings: any[]}} */ (evidence).findings.map(
              /** @param {{severity: string, note: string, file?: string}} finding */
              (finding) =>
                html`<li>
                  ${finding.severity} —
                  ${finding.note}${finding.file ? ` (${finding.file})` : ""}
                </li>`,
            )
          }
        </ul>`
      : nothing;
    const verdict = evidence?.verdict ? ` · ${evidence.verdict}` : "";
    const prediction = parseCostPrediction(this.task ?? {});
    const predictionLine = prediction
      ? costPredictionLines(prediction)[0]
      : null;
    return html`<div class="run" data-status=${run.status}>
      <i></i>
      <div>
        <p class="kind">
          ${KIND_LABEL[run.kind] || run.kind} ${run.status}${verdict}
        </p>
        <p class="meta">
          ${run.model_id ? `${run.model_id} · ` : ""} ${shortSha(run.head_sha)}
          · ${rel(run.finished_at || run.started_at)} ·
          <run-duration
            .startedAt=${run.started_at}
            .finishedAt=${run.finished_at ?? null}
          ></run-duration>
          ${predictionLine ? ` · ${predictionLine}` : ""}${run.error
            ? ` · ${run.error}`
            : ""}
        </p>
        ${traceUrl
          ? html`<a
              class="run-trace"
              href=${traceUrl}
              target="_blank"
              rel="noopener"
              >Trace</a
            >`
          : nothing}
        ${findings}
      </div>
    </div>`;
  }
}

customElements.define("run-line", RunLine);
