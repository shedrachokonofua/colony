// The shell's render fragments: the route-to-view-element dispatch and the
// markdown reader overlay. The shell passes its reactive state down as
// element properties; the fragments own nothing but the template shapes, so
// styles.css keeps styling the same light-DOM markup it always has.
import { html, nothing } from "./base.js";
import { mdFragment } from "./markdown.js";
import { closeReader } from "./shell-actions.js";

/**
 * The route's view element, or the loading note while its module imports.
 *
 * @param {import("./shell-data.js").ShellState} app
 */
export function renderView(app) {
  if (app.viewModule?.loading) {
    return html`<p class="note">Loading…</p>`;
  }
  if (app.viewModule?.error) {
    return html`<div class="banner banner-error" role="alert">
      Failed to load view: ${app.viewModule.error}
    </div>`;
  }
  if (!app.viewModule) return nothing;
  switch (app.viewModule.route) {
    case "list":
      return html`<project-list
        .projectsPage=${app.projectsPage}
        .showArchived=${app.showArchived}
        .error=${app.error}
      ></project-list>`;
    case "project":
      return html`<project-page
        .projectPage=${app.projectPage}
        .projectRunning=${app.projectRunning ?? []}
        .failures=${app.projectFailures ?? null}
        .tab=${app.projectTab}
        .ticker=${app.ticker}
        .contextDoc=${app.projectContext?.doc ??
        (typeof app.projectContext === "string" ? app.projectContext : "")}
        .files=${app.projectFiles ?? []}
        .editing=${app.briefOpen}
        .saveStatus=${app.projectContext?.status ?? null}
        .confirm=${app.confirm}
        .config=${app.config}
        .error=${app.error}
      ></project-page>`;
    case "files":
      return html`<project-files
        .filesPage=${app.filesPage}
        .confirmFile=${app.confirmFile}
        .replaceFileId=${app.replaceFileId}
        .error=${app.error}
      ></project-files>`;
    case "newProject":
      return html`<project-create
        .nameDraft=${app.newProjectDraft?.name ?? ""}
        .contextDraft=${app.newProjectDraft?.context_doc ?? ""}
        .error=${app.error}
      ></project-create>`;
    case "newScope":
      return html`<scope-create
        .fixedProject=${
          /** @type {{ project?: string | null }} */ (app.currentRoute.params)
            .project ?? null
        }
        .error=${app.error}
      ></scope-create>`;
    case "scope":
      return html`<scope-sheet
        .detail=${app.detail}
        .audit=${app.audit}
        .selectedTaskId=${app.selectedTaskId}
        .drawerOpen=${app.drawerOpen}
        .goalOpen=${app.goalOpen}
        .planOpen=${app.planOpen}
        .runEvents=${app.runEvents}
        .scopeRunEvents=${app.scopeRunEvents}
        .error=${app.error}
        .config=${app.config}
        .confirm=${app.confirm}
      ></scope-sheet>`;
    default:
      return nothing;
  }
}

/**
 * The reader overlay: a modal dialog over the current view, closed by
 * backdrop click or the shell's Escape handling.
 *
 * @param {import("./shell-data.js").ShellState} app
 */
export function renderReaderOverlay(app) {
  if (!app.reader) return nothing;
  return html`<div
    class="reader-overlay"
    @click=${
      /** @param {MouseEvent} event */ (event) => {
        if (event.target === event.currentTarget) closeReader(app);
      }
    }
  >
    <div
      class="reader"
      role="dialog"
      aria-modal="true"
      aria-label=${app.reader.title}
    >
      <header class="reader-head">
        <p>${app.reader.title}</p>
        <button class="btn btn-quiet" @click=${() => closeReader(app)}>
          Close
        </button>
      </header>
      <div class="reader-body md">${mdFragment(app.reader.markdown)}</div>
    </div>
  </div>`;
}
