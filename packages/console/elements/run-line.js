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

/** A review row with no recorded envelope: the run predates envelope_json. */
const DETAILS_UNAVAILABLE = "full details unavailable for this older record";

/** A review run that finished without a verdict has nothing to believe. */
const NO_ACCEPTED_VERDICT = "no accepted verdict was submitted";

/** A failed/canceled run's envelope is a submission the server rejected. */
const NOT_ACCEPTED = "a submission was recorded but not accepted";

/** @param {string | null | undefined} sha */
function shortSha(sha) {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "—";
}

/**
 * @param {string | null | undefined} raw
 * @returns {Record<string, any> | null}
 */
function parseRecord(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The reviewer envelope of a succeeded review run, or null when there is
 * none to believe. Only a succeeded run's envelope is an accepted verdict: a
 * failed or canceled run's envelope is a submission the server never
 * accepted, so it is never presented as the verdict.
 * @param {Record<string, any>} run
 * @returns {Record<string, any> | null}
 */
function reviewEnvelope(run) {
  if (run.status !== "succeeded") return null;
  const envelope = parseRecord(run.envelope_json);
  if (!envelope) return null;
  if (envelope.kind !== undefined && envelope.kind !== "reviewer_verdict")
    return null;
  return typeof envelope.verdict === "string" ? envelope : null;
}

/** @param {any} finding */
function findingRow(finding) {
  return html`<li>
    ${finding.severity} —
    ${finding.note}${finding.file ? ` (${finding.file})` : ""}
  </li>`;
}

/**
 * Per-dimension candidate counts: how many candidate findings each review
 * dimension produced. Counts overlap between dimensions, so they are not an
 * additive total.
 * @param {any} rawDimensions
 */
function dimensionRows(rawDimensions) {
  const dimensions = Array.isArray(rawDimensions)
    ? /** @type {any[]} */ (rawDimensions).filter(
        /** @param {any} dimension */
        (dimension) =>
          dimension &&
          typeof dimension?.name === "string" &&
          typeof dimension?.findings === "number",
      )
    : [];
  if (dimensions.length === 0) return nothing;
  return html`<p class="coverage-note">
      per-dimension candidate counts · counts may overlap, so they are not an
      additive total
    </p>
    <ul class="dimensions">
      ${dimensions.map(
        /** @param {any} dimension */
        (dimension) =>
          html`<li>
            ${dimension.name}${dimension.spec_blind
              ? html` <span
                  class="badge spec-blind"
                  title="checked without seeing the task spec"
                  >spec-blind</span
                >`
              : nothing}
            · ${dimension.findings}
            ${dimension.findings === 1 ? "candidate" : "candidates"}
            ${Array.isArray(dimension.target_files) &&
            dimension.target_files.length > 0
              ? ` (${dimension.target_files.join(", ")})`
              : nothing}
          </li>`,
      )}
    </ul>`;
}

/**
 * The reviewer's self-check: how many candidate findings it examined and set
 * aside before submitting. Plain language only — no per-candidate history.
 * @param {any} challenged
 */
function selfCheckLine(challenged) {
  const reviewed = challenged?.reviewed;
  const dropped = challenged?.dropped;
  if (typeof reviewed !== "number" || typeof dropped !== "number")
    return nothing;
  return html`<p class="challenged">
    self-check: ${reviewed} examined · ${dropped} set aside
    <span class="self-check-note">candidates considered but not submitted</span>
  </p>`;
}

/** @param {any} rawInspected */
function inspectedRows(rawInspected) {
  const inspected = Array.isArray(rawInspected)
    ? /** @type {any[]} */ (rawInspected).filter(
        /** @param {any} entry */
        (entry) => entry && typeof entry?.file === "string",
      )
    : [];
  if (inspected.length === 0) return nothing;
  return html`<p class="coverage-note">files inspected</p>
    <ul class="inspected">
      ${inspected.map(
        /** @param {any} entry */
        (entry) => html`<li>${entry.file} — ${entry.note ?? ""}</li>`,
      )}
    </ul>`;
}

/**
 * Review coverage recorded in evidence only: one line per dimension plus the
 * self-check counts. Guards on shape so older rows (verdict-only evidence)
 * render exactly as before.
 * @param {any} evidence
 */
function evidenceCoverage(evidence) {
  const dimensions = dimensionRows(evidence?.dimensions);
  const selfCheck = selfCheckLine(evidence?.challenged);
  if (dimensions === nothing) return selfCheck;
  return html`${dimensions}${selfCheck}`;
}

/**
 * The recorded review: verdict, the reviewer's rationale, every final finding,
 * then coverage behind one disclosure. The final count is the recorded
 * findings array length — never reviewed-minus-dropped.
 * @param {Record<string, any>} envelope
 * @param {Record<string, any> | null} evidence
 * @param {string} verdict the recorded verdict: evidence wins over envelope.
 */
function reviewBrief(envelope, evidence, verdict) {
  const findings = Array.isArray(envelope.findings) ? envelope.findings : [];
  const count = envelope.findings?.length ?? 0;
  const summary =
    typeof envelope.summary === "string" ? envelope.summary : nothing;
  const coverage = [
    dimensionRows(envelope.dimensions ?? evidence?.dimensions),
    selfCheckLine(envelope.challenged ?? evidence?.challenged),
    inspectedRows(envelope.inspected),
  ].filter((block) => block !== nothing);
  return html`<div class="review-detail">
    <p class="review-verdict">verdict: ${verdict}</p>
    ${summary === nothing
      ? nothing
      : html`<p class="review-summary">${summary}</p>`}
    <p class="findings-count">
      ${count === 0
        ? "no final findings were recorded"
        : `${count} final finding${count === 1 ? "" : "s"}`}
    </p>
    ${count === 0
      ? nothing
      : html`<ul class="findings">
          ${findings.map(findingRow)}
        </ul>`}
    ${coverage.length === 0
      ? nothing
      : html`<details class="review-coverage">
          <summary>review coverage</summary>
          ${coverage}
        </details>`}
  </div> `;
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
    const evidence = parseRecord(run.evidence_json);
    // Envelope substance is for review runs only: a plan_review run carries a
    // plan_review_verdict with the same field names and renders unchanged.
    const isReview = run.kind === "review";
    const envelope = isReview ? reviewEnvelope(run) : null;
    const verdict = evidence?.verdict ?? envelope?.verdict;
    // With an envelope, its findings ARE the final findings; the evidence copy
    // would be a duplicate list.
    const findings =
      envelope || !Array.isArray(evidence?.findings)
        ? nothing
        : html`<ul class="findings">
            ${
              /** @type {{findings: any[]}} */ (evidence).findings.map(
                findingRow,
              )
            }
          </ul>`;
    const coverage =
      !envelope && isReview ? evidenceCoverage(evidence) : nothing;
    // A succeeded review with no usable envelope is an older record: show what
    // evidence holds and say the rest is gone, rather than inventing it.
    const unavailable =
      isReview && run.status === "succeeded" && !envelope
        ? html`<p class="details-unavailable">${DETAILS_UNAVAILABLE}</p>`
        : nothing;
    const notAccepted =
      isReview &&
      (run.status === "failed" || run.status === "canceled") &&
      !evidence?.verdict
        ? html`<p class="verdict-note">
            ${NO_ACCEPTED_VERDICT}${run.envelope_json
              ? ` — ${NOT_ACCEPTED}`
              : ""}
          </p>`
        : nothing;
    const verdictChip = verdict ? ` · ${verdict}` : "";
    const prediction = parseCostPrediction(this.task ?? {});
    const predictionLine = prediction
      ? costPredictionLines(prediction)[0]
      : null;
    const fault = run.fault;
    const faultSpan =
      run.status === "failed" && fault
        ? fault.layer === "unknown"
          ? html` · <span class="badge fault-unknown">unknown</span> ·
              ${fault.code}`
          : html` ·
              <span class="fault-info">${fault.layer}/${fault.code}</span>`
        : nothing;
    return html`<div class="run" data-status=${run.status}>
      <i></i>
      <div>
        <p class="kind">
          ${KIND_LABEL[run.kind] || run.kind} ${run.status}${verdictChip}
        </p>
        <p class="meta">
          ${run.model_id ? `${run.model_id} · ` : ""} ${shortSha(run.head_sha)}
          · ${rel(run.finished_at || run.started_at)} ·
          <run-duration
            .startedAt=${run.started_at}
            .finishedAt=${run.finished_at ?? null}
          ></run-duration>
          ${predictionLine ? ` · ${predictionLine}` : ""}${faultSpan}${run.error
            ? ` · ${run.error}`
            : ""}
        </p>
        ${run.status === "running" && run.active_tool
          ? html`<p class="active-operation">
              running
              ${run.active_tool}${run.active_tool_detail
                ? `: ${run.active_tool_detail}`
                : ""}
              ·
              <run-duration
                .startedAt=${run.active_tool_started_at}
                .finishedAt=${null}
              ></run-duration>
            </p>`
          : nothing}
        ${traceUrl
          ? html`<a
              class="run-trace"
              href=${traceUrl}
              target="_blank"
              rel="noopener"
              >Trace</a
            >`
          : nothing}
        ${envelope && verdict
          ? reviewBrief(envelope, evidence, verdict)
          : nothing}
        ${findings} ${coverage} ${unavailable} ${notAccepted}
      </div>
    </div>`;
  }
}

customElements.define("run-line", RunLine);
