// <project-files>: a project's reference files — paginated list, upload
// form, and the delete/replace flows. Ported from renderManageFiles +
// fileRow (app.js). Property-down: filesPage {name, project, files, total,
// offset, page}, confirmFile, replaceFileId, error. Events-up: the file
// catalog (colony-file-confirm, colony-file-replace-toggle,
// colony-file-replace, colony-file-delete, colony-file-upload) plus
// colony-navigate and colony-page.
import { ColonyElement, html, nothing, repeat } from "../base.js";
import { hrefForPage, pageCount } from "../pagination.js";
import { projectHref, projectFilesHref } from "../router.js";

const PAGE_SIZE = 25;

const MEDIA_TYPES = ["text/plain", "text/markdown"];

export class ProjectFiles extends ColonyElement {
  static properties = {
    filesPage: { type: Object },
    confirmFile: { type: String },
    replaceFileId: { type: String },
    error: { type: String },
  };

  constructor() {
    super();
    /** @type {{ name: string, project: Record<string, any> | null, files?: any[], total?: number, page?: number } | null} */
    this.filesPage = null;
    /** @type {string | null} */
    this.confirmFile = null;
    /** @type {string | null} */
    this.replaceFileId = null;
    this.error = "";
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  /** Crumb / back links route through colony-navigate; modified clicks keep it. */
  /** @param {MouseEvent} event @param {string} href */
  #nav(event, href) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    this.#emit("colony-navigate", { href });
  }

  /** @param {{ base: string, page: number, total: number, items: number, label: string }} args */
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

  /** @param {MouseEvent} event @param {number} page */
  #page(event, page) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    this.#emit("colony-page", { page, surface: "files" });
  }

  /** The monolith's fileRow (app.js): a row plus its two-step destructive
   * controls and the inline replace form. */
  /** @param {Record<string, any>} file */
  #fileRow(file) {
    const replacing = this.replaceFileId === file.id;
    // Each conditional part sits flush against its parent's tags: a newline
    // between `<div>` and `${…}` leaves a text node lit cannot remove when the
    // branch swaps under happy-dom, which blows up the update.
    const action =
      this.confirmFile === file.id
        ? html`<button
            class="btn btn-rev"
            @click=${() =>
              this.#emit("colony-file-delete", { fileId: file.id })}
          >
            Confirm delete
          </button>`
        : html`<button
            class="btn btn-quiet"
            @click=${() =>
              this.#emit("colony-file-confirm", { fileId: file.id })}
          >
            Delete
          </button>`;
    const toggle = html`<button
      class="btn btn-quiet"
      @click=${() =>
        this.#emit("colony-file-replace-toggle", { fileId: file.id })}
    >
      ${replacing ? "Cancel replace" : "Replace"}
    </button>`;
    // Conditional parts are locals so each `${…}` sits flush against its
    // parent's tag: a newline between a child part and a tag leaves a text
    // node lit cannot remove when the branch swaps under happy-dom, which
    // crashes the update. prettier-ignore keeps that pairing from being
    // re-wrapped.
    const form = replacing ? this.#replaceForm(file) : nothing;
    // prettier-ignore
    return html`<div class="file-row">
      <div class="file-row-main">
        <span class="file-row-name">${file.filename}</span>
        <span class="file-row-meta mono"
          >${file.media_type} · ${file.byte_size} bytes</span
        >
      </div>
      <div class="create-actions">${action}${toggle}</div>
      ${form}</div>`;
  }

  /** @param {Record<string, any>} file */
  #replaceForm(file) {
    return html`<form
      class="composer"
      @submit=${
        /** @param {SubmitEvent} event */ (event) => {
          event.preventDefault();
          const form = new FormData(
            /** @type {HTMLFormElement} */ (event.target),
          );
          this.#emit("colony-file-replace", {
            fileId: file.id,
            media_type: String(form.get("media_type") ?? ""),
            content: String(form.get("content") ?? ""),
          });
        }
      }
    >
      <label class="field">
        <span>Media type</span>
        <select name="media_type">
          ${MEDIA_TYPES.map(
            (type) =>
              html`<option value=${type} ?selected=${file.media_type === type}>
                ${type}
              </option>`,
          )}
        </select>
      </label>
      <label class="field">
        <span>Content</span>
        <textarea name="content" rows="8"></textarea>
      </label>
      <div class="create-actions">
        <button class="btn" type="submit">Replace file</button>
      </div>
    </form>`;
  }

  render() {
    const page = this.filesPage;
    if (!page?.name) return nothing;
    if (!page.project) {
      return html`<div class="project-page" id="draw">
        <p class="rack-empty">
          No project named “${page.name}” — scopes group under a project once
          one of them names it.
        </p>
      </div>`;
    }
    const files = page.files ?? [];
    const base = projectFilesHref(page.project.name);
    // Precomputed so the <h1> stays a prettier one-liner (like project-page):
    // splitting it across lines grows its textContent and breaks the pin.
    const title = `${page.project?.name ?? page.name} · files`;
    return html`${this.error
        ? html`<div class="banner banner-error" role="alert">
            ${this.error}
          </div>`
        : nothing}
      <div class="project-page" id="draw">
        <header class="board-head">
          <h1 class="board-title">${title}</h1>
          <a
            class="btn btn-quiet"
            href=${projectHref(page.name)}
            @click=${
              /** @param {MouseEvent} event */ (event) =>
                this.#nav(event, projectHref(page.name))
            }
            >Back to project</a
          >
        </header>
        <section class="project-files">
          ${(page.total ?? 0) > 0 && files.length === 0
            ? html`<div class="rack-empty">
                <p>Past the last page.</p>
                <a class="btn btn-solid" href=${hrefForPage(base, 1)}
                  >Back to page 1</a
                >
              </div>`
            : files.length
              ? repeat(
                  files,
                  (file) => file.id,
                  (file) => this.#fileRow(file),
                )
              : html`<p class="rack-empty">No reference files yet.</p>`}
        </section>
        ${this.#pager({
          base,
          page: page.page ?? 1,
          total: page.total ?? 0,
          items: files.length,
          label: "Project file pages",
        })}
        <aside class="card">
          <p class="card-head">Add a file</p>
          <div class="card-body">
            <form
              class="composer"
              @submit=${
                /** @param {SubmitEvent} event */ (event) => {
                  event.preventDefault();
                  const form = new FormData(
                    /** @type {HTMLFormElement} */ (event.target),
                  );
                  this.#emit("colony-file-upload", {
                    filename: String(form.get("filename") ?? ""),
                    media_type: String(form.get("media_type") ?? ""),
                    content: String(form.get("content") ?? ""),
                  });
                }
              }
            >
              <label class="field">
                <span>Filename</span>
                <input
                  name="filename"
                  required
                  maxlength="255"
                  placeholder="AGENTS.md"
                  autocomplete="off"
                />
              </label>
              <label class="field">
                <span>Media type</span>
                <select name="media_type">
                  ${MEDIA_TYPES.map(
                    (type) => html`<option value=${type}>${type}</option>`,
                  )}
                </select>
              </label>
              <label class="field">
                <span>Content</span>
                <textarea name="content" rows="10"></textarea>
              </label>
              <div class="create-actions">
                <button class="btn btn-solid" type="submit">Add file</button>
              </div>
            </form>
          </div>
        </aside>
      </div>`;
  }
}

customElements.define("project-files", ProjectFiles);
