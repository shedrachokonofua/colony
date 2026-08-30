// <run-line>: one row in a task's or scope's run history. Ported from the
// monolith's runLine (app.js): status dot, kind/status line, verdict chip,
// meta line (model, head sha, relative time, live duration, error), trace
// deep link, and evidence findings. CSS classes match the monolith's.
import { ColonyElement, html, nothing } from "../base.js";
import { KIND_LABEL } from "../kind-label.js";
import { traceHref } from "../trace-link.js";
import { costPredictionLines, parseCostPrediction } from "../cost-prediction.js";
import "./run-duration.js";

function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "—";
}

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
    this.run = null;
    this.config = null;
    this.task = null;
  }

  render() {
    const run = this.run;
    if (!run) return nothing;
    const traceUrl = traceHref(this.config, run);
    const evidence = parseEvidence(run.evidence_json);
    const findings = Array.isArray(evidence?.findings)
      ? html`<ul class="findings">
          ${evidence.findings.map(
            (finding) =>
              html`<li>
                ${finding.severity} —
                ${finding.note}${finding.file ? ` (${finding.file})` : ""}
              </li>`,
          )}
        </ul>`
      : nothing;
    const verdict = evidence?.verdict ? ` · ${evidence.verdict}` : "";
    const prediction = parseCostPrediction(this.task);
    const predictionLine = prediction
      ? costPredictionLines(prediction)[0]
      : null;
    return html`<div class="run-line" data-status=${run.status}>
      <i></i>
      <div>
        <p class="kind">
          <span class="kind-label"
            >${KIND_LABEL[run.kind] || run.kind}</span
          >
          ${run.status}${verdict}
        </p>
        <p class="meta">
          ${run.model_id ? `${run.model_id} · ` : ""} ${shortSha(run.head_sha)}
          ·
          <run-duration
            .startedAt=${run.started_at}
            .finishedAt=${run.finished_at ?? null}
          ></run-duration>
          ${predictionLine
            ? html`<span class="cost-prediction-line"> · ${predictionLine}</span>`
            : nothing}${run.error ? ` · ${run.error}` : ""}
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
