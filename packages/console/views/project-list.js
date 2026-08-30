// <project-list>: the homepage — the paginated project index. Ported from
// renderProjectList (app.js). Property-down: projectsPage and error.
// Events-up: colony-page {page, surface:"projects"}, the pagination the
// shell's _page turns into a hash.
import { ColonyElement, html, nothing, repeat } from "../base.js";
import { rel } from "../rel-time.js";
import { hrefForPage } from "../pagination.js";
import { projectHref } from "../router.js";
import { knowledgeText, repoSummaryText } from "../project-helpers.js";

const PAGE_SIZE = 25;

/**
 * The monolith's renderPager (app.js): Previous / "from–to of total" / Next
 * over a fixed base hash. Hidden unless the list spans more than one page.
 */
function pager({ base, page, total, items, label }) {
  if (total <= PAGE_SIZE) return nothing;
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min((page - 1) * PAGE_SIZE + items, total);
  // Anchors carry the real hash (middle-click, and the URL is the source of
  // truth on refresh); the colony-page event is what the shell routes, and
  // _navigate no-ops when the hash already matches.
  const step = (target) => (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    event.currentTarget.dispatchEvent(
      new CustomEvent("colony-page", {
        bubbles: true,
        composed: true,
        detail: { page: target, surface: "projects" },
      }),
    );
  };
  return html`<nav class="board-pager" aria-label=${label}>
    <a
      class="btn btn-quiet"
      href=${hrefForPage(base, Math.max(1, page - 1))}
      @click=${step(Math.max(1, page - 1))}
      >Previous</a
    >
    <span class="pager-range mono">${from}–${to} of ${total}</span>
    <a
      class="btn btn-quiet"
      href=${hrefForPage(base, Math.min(last, page + 1))}
      @click=${step(Math.min(last, page + 1))}
      >Next</a
    >
  </nav>`;
}

/** Card links route through colony-navigate; modified clicks keep the anchor. */
function navigate(event, href) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  event.currentTarget.dispatchEvent(
    new CustomEvent("colony-navigate", {
      bubbles: true,
      composed: true,
      detail: { href },
    }),
  );
}

function projectCard(project) {
  const counts = project.status_counts ?? {};
  const chips = Object.entries(counts).filter(([, n]) => n > 0);
  const fileCount = project.file_count ?? 0;
  const repoSummary = repoSummaryText(project.repositories);
  return html`<a
    class="card project-card project-row"
    href=${projectHref(project.name)}
    @click=${(event) => navigate(event, projectHref(project.name))}
  >
    <span class="project-card-name">${project.name}</span>
    <span class="project-card-meta">
      <span class="mono"
        >${project.scope_count}
        scope${project.scope_count === 1 ? "" : "s"}</span
      >
      ${chips.length
        ? chips.map(
            ([status, count]) =>
              html`<span class="chip" data-kind=${status}
                >${status} ${count}</span
              >`,
          )
        : nothing}
      <span class="mono">${rel(project.last_activity_at)}</span>
    </span>
    <span class="project-card-repos">${repoSummary}</span>
    <span class="project-card-knowledge"
      >${knowledgeText(project.context_doc, fileCount)}</span
    >
  </a>`;
}

export class ProjectList extends ColonyElement {
  static properties = {
    projectsPage: { type: Object },
    error: { type: String },
  };

  constructor() {
    super();
    this.projectsPage = null;
    this.error = "";
  }

  render() {
    const page = this.projectsPage;
    // The shell's projectsPage carries {projects, total, offset, page} —
    // the shape /projects returns. Not the generic {items} page.
    const rows = page?.projects ?? [];
    const total = page?.total ?? 0;
    const items = rows.length;
    const pageNo = page?.page ?? 1;
    const base = "#/";
    return html`${this.error
        ? html`<div class="banner banner-error" role="alert">
            ${this.error}
          </div>`
        : nothing}
      <div class="project-index board" id="draw">
        <div class="board-head">
          <h1 class="board-title">Projects</h1>
          <div class="board-head-actions">
            <a class="btn btn-solid" href="#/new-project">New project</a>
          </div>
        </div>
        ${total === 0
          ? html`<div class="rack-empty">
              <p>No projects yet</p>
              <a class="btn btn-solid" href="#/new-project">New project</a>
            </div>`
          : items === 0
            ? html`<div class="rack-empty">
                <p>Past the last page.</p>
                <button
                  class="btn btn-solid"
                  @click=${() =>
                    this.dispatchEvent(
                      new CustomEvent("colony-page", {
                        bubbles: true,
                        composed: true,
                        detail: { page: 1, surface: "projects" },
                      }),
                    )}
                >
                  Back to page 1
                </button>
              </div>`
            : html`<div class="project-cards">
                ${repeat(rows, (project) => project.name, projectCard)}
              </div>`}
        ${pager({
          base,
          page: pageNo,
          total,
          items,
          label: "Project pages",
        })}
      </div>`;
  }
}

customElements.define("project-list", ProjectList);
