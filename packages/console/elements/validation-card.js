// <validation-card>: the scope's acceptance criteria and their latest
// validate-run results. Ported from renderValidationCard (app.js). A failed
// validating scope offers colony-task-action revalidate; a blocked one (the
// replan budget exhausted) offers the operator unblock, both ported from the
// monolith's a393cfd retry logic.
import { ColonyElement, classMap, html, nothing, repeat } from "../base.js";
import {
  durationAriaLabel,
  formatDuration,
  isoDuration,
  runDurationMs,
} from "../duration.js";

/** @param {string | null | undefined} raw @returns {any} */
function parseEvidence(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {{ acceptance_json?: string | null } | null | undefined} scope @returns {any} */
function parseAcceptance(scope) {
  if (!scope?.acceptance_json) return null;
  try {
    const parsed = JSON.parse(scope.acceptance_json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class ValidationCard extends ColonyElement {
  static properties = {
    scope: { type: Object },
    detail: { type: Object },
  };

  constructor() {
    super();
    /** @type {Record<string, any> | null} */
    this.scope = null;
    /** @type {Record<string, any> | null} */
    this.detail = null;
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  render() {
    const scope = this.scope;
    if (!scope) return nothing;
    const acceptance = parseAcceptance(scope);
    const detailRuns = /** @type {any[]} */ (this.detail?.runs || []);
    const validateRuns = detailRuns.filter((run) => run.kind === "validate");
    if ((!acceptance || !acceptance.length) && !validateRuns.length) {
      return nothing;
    }
    const latest = validateRuns
      .slice()
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
      .pop();
    const evidence = latest ? parseEvidence(latest.evidence_json) : null;
    const results = Array.isArray(evidence?.results) ? evidence.results : [];
    const failedCount = results.filter(
      /** @param {{exit_code: number}} result */ (result) =>
        result.exit_code !== 0,
    ).length;
    const failed = Boolean(latest && latest.status === "failed");
    const running = Boolean(latest && latest.status === "running");
    const summary =
      latest && evidence
        ? evidence.passed
          ? "All criteria passed"
          : `Failed: ${failedCount} criteria did not pass`
        : running
          ? "Validation is running…"
          : null;
    return html`<aside class="card">
      <p class="card-head">Validation</p>
      <div class="card-body">
        ${summary
          ? html`<p
              class=${classMap({
                "validation-summary": true,
                "is-passed": Boolean(evidence?.passed),
                "is-failed": Boolean(evidence && !evidence.passed),
              })}
            >
              ${summary}${(() => {
                if (!latest) return nothing;
                const ms = runDurationMs(latest, Date.now());
                if (ms === null) return nothing;
                return html` ·
                  <time
                    class="dur"
                    datetime=${isoDuration(ms)}
                    title=${`started ${latest.started_at}${latest.finished_at ? `, finished ${latest.finished_at}` : ""}`}
                    aria-label=${durationAriaLabel(latest, Date.now())}
                    >${formatDuration(ms)}</time
                  >`;
              })()}
            </p>`
          : nothing}
        ${(scope.status === "validating" || scope.status === "blocked") &&
        failed
          ? html`<button
              class="btn btn-solid validation-retry"
              @click=${() =>
                this.#emit("colony-task-action", {
                  path: `/scopes/${scope.id}/${
                    scope.status === "blocked" ? "unblock" : "revalidate"
                  }`,
                })}
            >
              Run validation again
            </button>`
          : nothing}
        <ul class="validation-list">
          ${repeat(
            acceptance || [],
            /** @type {(item: any, i: number) => number} */ ((item, i) => i),
            (item, i) => {
              const result = results.find(
                (/** @type {any} */ r) => r.index === i,
              );
              const pending = !result;
              const itemFailed = result && result.exit_code !== 0;
              return html`<li
                class=${classMap({
                  "validation-item": true,
                  "is-pending": pending,
                  "is-passed": !pending && !itemFailed,
                  "is-failed": Boolean(itemFailed),
                })}
              >
                <span class="validation-marker">
                  ${pending ? "…" : itemFailed ? "✕" : "✓"}
                </span>
                <div class="validation-detail">
                  <p class="validation-desc">
                    ${item?.description || `Criterion ${i + 1}`}
                  </p>
                  ${item?.command
                    ? html`<code class="mono validation-cmd"
                        >${item.command}</code
                      >`
                    : nothing}
                  ${(() => {
                    // Acceptance commands often discard their own output
                    // (>/dev/null 2>&1); a tail of blank lines must not
                    // render as an empty output pane.
                    const tail = (result?.tail || [])
                      .join("\n")
                      .replace(/\s+$/, "");
                    return itemFailed && tail
                      ? html`<pre class="runlog">${tail}</pre>`
                      : nothing;
                  })()}
                </div>
              </li>`;
            },
          )}
        </ul>
      </div>
    </aside>`;
  }
}

customElements.define("validation-card", ValidationCard);
