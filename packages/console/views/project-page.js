// <project-page>: a project's own page — breadcrumbs, head, scope list, and
// the settings rail. Ported from renderProjectPage + renderProjectRail
// (app.js). Property-down: projectPage {name, project, scopes, total,
// offset, page}, contextDoc, files, editing, saveStatus, tab, config, error.
// Events-up: colony-page {page, surface:"project"}, colony-navigate, and
// colony-toggle {key:"projectTab", value} from the Scopes/Settings tabs.
//
// The monolith gates the rail behind a Scopes/Settings tab switcher; here
// the tab is a property the shell drives, so the rail's visibility is the
// shell's call rather than state the view owns.
import { ColonyElement, html, nothing, repeat } from "../base.js";
import { rel } from "../rel-time.js";
import { hrefForPage, pageCount } from "../pagination.js";
import { projectHref } from "../router.js";
import { distinctRepos, projectDescription } from "../project-helpers.js";
import "../elements/project-context-card.js";

const PAGE_SIZE = 25;

function scopeTitle(scope) {
  if (!scope) return "";
  if (scope.title) return scope.title;
  return scope.goal.length > 72
    ? `${scope.goal.slice(0, 72).trimEnd()}…`
    : scope.goal;
}

export class ProjectPage extends ColonyElement {
  static properties = {
    projectPage: { type: Object },
    contextDoc: { type: String },
    files: { type: Array },
    editing: { type: Boolean },
    saveStatus: { type: String },
    tab: { type: String },
    config: { type: Object },
    error: { type: String },
  };

  static TABS = [
    ["scopes", "Scopes"],
    ["settings", "Settings"],
  ];

  constructor() {
    super();
    this.projectPage = null;
    this.contextDoc = "";
    this.files = [];
    this.editing = false;
    this.saveStatus = null;
    this.tab = "scopes";
    this.config = null;
    this.error = "";
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  /**
   * The monolith's renderPager (app.js): Previous / "from–to of total" / Next
   * over a fixed base hash. Anchors carry the real hash so a reload lands on
   * the same page; colony-page is what the shell routes.
   */
  #pager({ base, page, total, items, label }) {
    if (total <= PAGE_SIZE) return nothing;
    const last = Math.max(1, pageCount(total, PAGE_SIZE));
    const from = (page - 1) * PAGE_SIZE + 1;
    const to = Math.min((page - 1) * PAGE_SIZE + items, total);
    return html`<nav class="board-pager" aria-label=${label}>
      <a
        class="btn btn-quiet"
        href=${hrefForPage(base, Math.max(1, page - 1))}
        @click=${(event) => this.#page(event, Math.max(1, page - 1))}
        >Previous</a
      >
      <span class="pager-range mono">${from}–${to} of ${total}</span>
      <a
        class="btn btn-quiet"
        href=${hrefForPage(base, Math.min(last, page + 1))}
        @click=${(event) => this.#page(event, Math.min(last, page + 1))}
        >Next</a
      >
    </nav>`;
  }

  /** Crumb links route through colony-navigate; modified clicks keep the anchor. */
  #nav(event, href) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    this.#emit("colony-navigate", { href });
  }

  /** Pager clicks route through colony-page; modified clicks keep the anchor. */
  #page(event, page) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    this.#emit("colony-page", { page, surface: "project" });
  }

  /** The monolith's Scopes/Settings switcher (app.js). */
  #tabs() {
    return html`<nav class="tabs" role="tablist" aria-label="Project sections">
      ${ProjectPage.TABS.map(
        ([id, label]) =>
          html`<button
            class="tab"
            role="tab"
            aria-selected=${this.tab === id}
            @click=${() =>
              this.#emit("colony-toggle", { key: "projectTab", value: id })}
          >
            ${label}
          </button>`,
      )}
    </nav>`;
  }

  #repoUrl(path) {
    const base = String(this.config?.gitlab_base_url ?? "").replace(/\/$/, "");
    return base && path ? `${base}/${path}` : "";
  }

  /** The monolith's scopeCard (app.js): one clickable row per scope. */
  #scopeCard(scope) {
    return html`<button
      class="scope-card"
      @click=${() => this.#emit("colony-navigate", { href: `#/${scope.id}` })}
    >
      <span class="scope-top">
        <span class="chip" data-kind=${scope.status}>${scope.status}</span>
        <span class="scope-time">${rel(scope.updated_at)}</span>
      </span>
      <span class="scope-goal">${scopeTitle(scope)}</span>
      <span class="scope-meta">
        <span class="mono">${scope.id}</span>
        <span>${scope.provider_repo_path}</span>
        ${scope.project_name
          ? html`<a
              class="scope-project"
              href=${projectHref(scope.project_name)}
              @click=${(event) => event.stopPropagation()}
              >${scope.project_name}</a
            >`
          : nothing}
      </span>
    </button>`;
  }

  /** The monolith's renderProjectRail (app.js): brief card + repos. */
  #rail() {
    const project = this.projectPage.project;
    const repos = distinctRepos(project.repositories);
    return html`<div class="project-settings">
      <project-context-card
        .project=${project}
        .contextDoc=${this.contextDoc ?? ""}
        .files=${this.files ?? []}
        .editing=${this.editing}
        .saveStatus=${this.saveStatus}
      ></project-context-card>
      <aside class="card">
        <p class="card-head">Connected repositories</p>
        <div class="card-body">
          ${repos.length
            ? html`<ul class="repo-list">
                ${repos.map(
                  (repo) =>
                    html`<li>
                      <a href=${this.#repoUrl(repo.repo_path)}
                        >${repo.repo_path}</a
                      >
                    </li>`,
                )}
              </ul>`
            : html`<p class="note">No connected repositories</p>`}
        </div>
      </aside>
    </div>`;
  }

  render() {
    const page = this.projectPage;
    if (!page?.name) return nothing;
    if (!page.project) {
      return html`<div class="project-page" id="draw">
        <p class="rack-empty">
          No project named “${page.name}” — scopes group under a project once
          one of them names it.
        </p>
      </div>`;
    }
    const counts = page.project.status_counts ?? {};
    const chips = Object.entries(counts).filter(([, n]) => n > 0);
    const base = projectHref(page.project.name);
    const scopes = page.scopes ?? [];
    const description = projectDescription(page.project.context_doc);
    return html`${this.error
        ? html`<div class="banner banner-error" role="alert">
            ${this.error}
          </div>`
        : nothing}
      <div class="project-page" id="draw">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="#/" @click=${(e) => this.#nav(e, "#/")}>Projects</a>
          <span class="crumb-sep">/</span>
          <span class="crumb">${page.project.name}</span>
        </nav>
        <header class="board-head">
          <h1 class="board-title">${page.project.name}</h1>
          <a
            class="btn btn-solid"
            href=${`#/new?project=${encodeURIComponent(page.project.name)}`}
            >New scope</a
          >
        </header>
        ${description
          ? html`<p class="project-desc">${description}</p>`
          : nothing}
        <p class="project-meta mono">
          <span
            >${page.project.scope_count}
            scope${page.project.scope_count === 1 ? "" : "s"}</span
          >
          updated ${rel(page.project.updated_at)}
        </p>
        ${chips.length
          ? html`<p class="project-counts">
              ${chips.map(
                ([status, count]) =>
                  html`<span class="chip" data-kind=${status}
                    >${status} ${count}</span
                  >`,
              )}
            </p>`
          : nothing}
        ${this.#tabs()}
        ${this.tab === "settings"
          ? this.#rail()
          : html`<section class="project-scopes"
              >${page.total > 0 && scopes.length === 0
                ? html`<div class="rack-empty">
                    <p>Past the last page.</p>
                    <a class="btn btn-solid" href=${hrefForPage(base, 1)}
                      >Back to page 1</a
                    >
                    <a class="btn btn-quiet" href="#/">All projects</a>
                  </div>`
                : scopes.length
                  ? html`<div class="rack">
                      ${repeat(
                        scopes,
                        (scope) => scope.id,
                        (s) => this.#scopeCard(s),
                      )}
                    </div>`
                  : html`<p class="rack-empty">
                      No scopes in this project yet.
                    </p>`}</section
            >${this.#pager({
              base,
              page: page.page,
              total: page.total,
              items: scopes.length,
              label: "Project scope pages",
            })}`}
      </div>`;
  }
}

customElements.define("project-page", ProjectPage);
