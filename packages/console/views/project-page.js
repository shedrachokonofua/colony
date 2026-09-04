// <project-page>: a project's own page — breadcrumbs, head, scope list, the
// running tab, and the settings rail. Ported from renderProjectPage +
// renderProjectRail (app.js). Property-down: projectPage {name, project,
// scopes, total, offset, page}, projectRunning, tab, contextDoc, files,
// editing, saveStatus, config, error. Events-up: colony-page {page,
// surface:"project"}, colony-navigate, colony-project-tab {tab} from the
// Scopes/Running/Settings switcher, and whatever the tab's own element emits.
//
// The tab is a property the shell drives (it owns the URL's ?tab=), so which
// surface shows is the shell's call rather than state this view owns. The
// switcher emits the tab it was clicked to, never a bare toggle: with three
// surfaces a toggle could not say which one to land on, and clicking the
// active tab emits nothing because the monolith's setProjectTab was
// idempotent.
import { ColonyElement, html, nothing, repeat } from "../base.js";
import { rel } from "../rel-time.js";
import { hrefForPage, pageCount } from "../pagination.js";
import { projectHref } from "../router.js";
import { distinctRepos, projectDescription } from "../project-helpers.js";
import "../elements/project-context-card.js";
import "../elements/running-tab.js";

const PAGE_SIZE = 25;

/** @param {Record<string, any> | null | undefined} scope */
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
    projectRunning: { type: Array },
    tab: { type: String },
    ticker: { type: Object },
    contextDoc: { type: String },
    files: { type: Array },
    editing: { type: Boolean },
    saveStatus: { type: String },
    confirm: { type: String },
    config: { type: Object },
    failures: { type: Object },
    error: { type: String },
  };

  /**
   * The switcher's surfaces: [tab id, label]. Scopes is the default tab, so
   * it owns no ?tab= in the URL.
   */
  static TABS = [
    ["scopes", "Scopes"],
    ["running", "Running tasks"],
    ["settings", "Settings"],
  ];

  constructor() {
    super();
    /** @type {{ name: string, project: Record<string, any> | null, scopes?: any[], total?: number, page?: number } | null} */
    this.projectPage = null;
    /** @type {import("../project-helpers.js").RunningEntry[]} */
    this.projectRunning = [];
    /** @type {import("../project-helpers.js").ProjectTab} */
    this.tab = "scopes";
    /** @type {import("../duration.js").Ticker | null} */
    this.ticker = null;
    this.contextDoc = "";
    /** @type {Array<Record<string, any>>} */
    this.files = [];
    this.editing = false;
    /** @type {string | null} */
    this.saveStatus = null;
    /** @type {string | null} */
    this.confirm = null;
    /** @type {{ gitlab_base_url?: string } | null} */
    this.config = null;
    /** @type {{ items: any[], total: number, limit: number, offset: number, counts: Record<string, number> } | null} */
    this.failures = null;
    this.error = "";
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  /**
   * The monolith's renderPager (app.js): Previous / "from–to of total" / Next
   * over a fixed base hash. Anchors carry the real hash so a reload lands on
   * the same page; colony-page is what the shell routes.
   * @param {{ base: string, page: number, total: number, items: number, label: string }} args
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
        @click=${
          /** @param {MouseEvent} event */ (event) =>
            this.#page(event, Math.max(1, page - 1))
        }
        >Previous</a
      >
      <span class="pager-range mono">${from}–${to} of ${total}</span>
      <a
        class="btn btn-quiet"
        href=${hrefForPage(base, Math.min(last, page + 1))}
        @click=${
          /** @param {MouseEvent} event */ (event) =>
            this.#page(event, Math.min(last, page + 1))
        }
        >Next</a
      >
    </nav>`;
  }

  /** Crumb links route through colony-navigate; modified clicks keep the anchor. */
  /** @param {MouseEvent} event @param {string} href */
  #nav(event, href) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    this.#emit("colony-navigate", { href });
  }

  /** Pager clicks route through colony-page; modified clicks keep the anchor. */
  /** @param {MouseEvent} event @param {number} page */
  #page(event, page) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    this.#emit("colony-page", { page, surface: "project" });
  }

  /**
   * The monolith's Scopes/Running/Settings switcher (app.js setProjectTab):
   * aria-selected marks the live surface, and a click emits the tab it names
   * so the shell can put it in the URL.
   */
  #tabs() {
    return html`<nav class="tabs" role="tablist" aria-label="Project sections">
      ${ProjectPage.TABS.map(
        ([id, label]) =>
          html`<button
            class="tab"
            role="tab"
            aria-selected=${this.tab === id}
            @click=${() => {
              if (this.tab === id) return;
              this.#emit("colony-project-tab", { tab: id });
            }}
          >
            ${label}
          </button>`,
      )}
    </nav>`;
  }

  /** The monolith's unarchiveButton (app.js): immediate, no confirm. */
  /** @param {string} projectName */
  #unarchiveButton(projectName) {
    return html`<button
      class="btn"
      @click=${() =>
        this.#emit("colony-task-action", {
          path: `/projects/${encodeURIComponent(projectName)}/unarchive`,
        })}
    >
      Unarchive
    </button>`;
  }

  /**
   * The monolith's archiveButton (app.js): going the other way hides the
   * project, so it stays behind a confirm.
   */
  /** @param {string} projectName */
  #archiveButton(projectName) {
    return this.confirm === "archive"
      ? html`<button
          class="btn btn-rev"
          @click=${() =>
            this.#emit("colony-task-action", {
              path: `/projects/${encodeURIComponent(projectName)}/archive`,
            })}
        >
          Confirm archive
        </button>`
      : html`<button
          class="btn btn-quiet"
          @click=${() => this.#emit("colony-confirm", { kind: "archive" })}
        >
          Archive project
        </button>`;
  }

  /** @param {string} path */
  #repoUrl(path) {
    const base = String(this.config?.gitlab_base_url ?? "").replace(/\/$/, "");
    return base && path ? `${base}/${path}` : "";
  }

  /** The monolith's scopeCard (app.js): one clickable row per scope. */
  /** @param {Record<string, any>} scope */
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
              @click=${
                /** @param {MouseEvent} event */ (event) =>
                  event.stopPropagation()
              }
              >${scope.project_name}</a
            >`
          : nothing}
      </span>
    </button>`;
  }

  /**
   * The monolith's Running tab surface (app.js): the in-flight rows inside
   * the .project-running section the e2e specs key on.
   */
  #running() {
    return html`<section class="project-running">
      <running-tab
        .entries=${this.projectRunning ?? []}
        .project=${this.projectPage?.project ?? null}
        .ticker=${this.ticker}
      ></running-tab>
    </section>`;
  }

  /** The monolith's renderProjectRail (app.js): brief card + repos. */
  #rail() {
    const project = this.projectPage?.project;
    if (!project) return nothing;
    const repos = distinctRepos(project.repositories ?? []);
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
                      <a href=${this.#repoUrl(repo.repo_path ?? "")}
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

  /**
   * Render the failure census: a counts row by layer plus failure items
   * grouped by layer.
   */
  #failureCensus() {
    const failures = this.failures;
    if (!failures || failures.total === 0) {
      return html`<section class="project-census">
        <p class="rack-empty">No failures recorded for this project.</p>
      </section>`;
    }
    const counts = failures.counts ?? {};
    const layers = [
      "model",
      "harness",
      "sandbox",
      "provider",
      "colonyd",
      "unknown",
    ];
    const items = failures.items ?? [];

    const grouped = new Map();
    for (const layer of layers) {
      grouped.set(layer, []);
    }
    for (const item of items) {
      const layer = grouped.has(item.layer) ? item.layer : "unknown";
      grouped.get(layer).push(item);
    }

    return html`<section class="project-census">
      <div class="census-counts">
        ${layers.map(
          (layer) =>
            html`<span class="census-count" data-layer=${layer}>
              <span class="census-layer">${layer}</span>
              <span class="census-val">${counts[layer] ?? 0}</span>
            </span>`,
        )}
      </div>
      <div class="census-groups">
        ${layers.map((layer) => {
          const list = grouped.get(layer) ?? [];
          if (list.length === 0) return nothing;
          return html`<div class="census-group" data-layer=${layer}>
            <h3 class="census-group-title">${layer} (${list.length})</h3>
            <ul class="census-list">
              ${list.map(
                /** @param {{ code: string, taskId?: string | null, runId: string, at: string }} item */
                (item) =>
                  html`<li class="census-item">
                    <span class="census-code">${item.code}</span>
                    <span class="census-meta mono">
                      ${item.taskId
                        ? html`<span class="task-id">${item.taskId}</span> · `
                        : nothing}
                      <span class="run-id">${item.runId.slice(0, 8)}</span> ·
                      <span class="census-at">${rel(item.at)}</span>
                    </span>
                  </li>`,
              )}
            </ul>
          </div>`;
        })}
      </div>
    </section>`;
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
    const archivedAt = page.project.archived_at ?? null;
    return html`${this.error
        ? html`<div class="banner banner-error" role="alert">
            ${this.error}
          </div>`
        : nothing}
      <div class="project-page" id="draw">
        ${archivedAt
          ? html`<div class="banner banner-archived" role="status">
              Archived ${rel(archivedAt)}
            </div>`
          : nothing}
        <nav class="crumbs" aria-label="Breadcrumb">
          <a
            href="#/"
            @click=${/** @param {MouseEvent} e */ (e) => this.#nav(e, "#/")}
            >Projects</a
          >
          <span class="crumb-sep">/</span>
          <span class="crumb">${page.project.name}</span>
        </nav>
        <header class="board-head">
          <h1 class="board-title">${page.project.name}</h1>
          <div class="board-head-actions">
            ${archivedAt
              ? this.#unarchiveButton(page.project.name)
              : html`${this.#archiveButton(page.project.name)}
                  <a
                    class="btn btn-solid"
                    href=${`#/new?project=${encodeURIComponent(page.project.name)}`}
                    >New scope</a
                  >`}
          </div>
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
        ${this.tab === "running"
          ? this.#running()
          : this.tab === "settings"
            ? this.#rail()
            : html`<section class="project-scopes">
                  ${(page.total ?? 0) > 0 && scopes.length === 0
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
                        </p>`}
                </section>
                ${this.#pager({
                  base,
                  page: page.page ?? 1,
                  total: page.total ?? 0,
                  items: scopes.length,
                  label: "Project scope pages",
                })}`}
        ${this.#failureCensus()}
      </div>`;
  }
}

customElements.define("project-page", ProjectPage);
