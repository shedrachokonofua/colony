// <project-context-card>: the project's knowledge brief — read-only preview
// or the Markdown editor, its file list, and the Manage files link. Ported
// from renderProjectContextCard (app.js).
// Property-down: project, contextDoc, files, editing, saveStatus.
// Events-up: colony-toggle {key:"briefOpen"}, colony-save-context
// {project, context_doc}, and colony-navigate from the Manage files link.
//
// Defect 1: the textarea is bound to the internal _contextDraft, never to
// live(contextDoc). A live() binding makes every 2.5s poll rewrite
// textarea.value, which throws away the caret and the operator's in-flight
// edits. The draft is the source of truth while the operator types; the
// incoming doc is adopted only when it actually changed and the textarea is
// not focused (see willUpdate).
import { ColonyElement, html, nothing } from "../base.js";
import "./markdown-reader.js";
import { projectFilesHref } from "../router.js";

export class ProjectContextCard extends ColonyElement {
  static properties = {
    project: { type: Object },
    contextDoc: { type: String },
    files: { type: Array },
    editing: { type: Boolean },
    saveStatus: { type: String },
    _contextDraft: { type: String, state: true },
    _focused: { type: Boolean, state: true },
  };

  constructor() {
    super();
    /** @type {Record<string, any> | null} */
    this.project = null;
    this.contextDoc = "";
    /** @type {Array<Record<string, any>>} */
    this.files = [];
    this.editing = false;
    /** @type {string | null} */
    this.saveStatus = null;
    this._contextDraft = "";
    this._focused = false;
  }

  /** @param {Map<string, unknown>} changed */
  willUpdate(changed) {
    super.willUpdate(changed);
    // Adopt a new doc from the server unless the operator is typing in the
    // textarea: an unfocused editor is showing a value nobody is editing, so
    // a poll may refresh it, but a focused one is the operator's draft. The
    // shell seeds the doc once and never re-fetches it, so the value rarely
    // changes while the editor is closed — which is why opening the editor
    // re-reads it too: without that, Cancel would leave the abandoned text
    // in the draft and reopening would restore what the operator discarded.
    const docChanged =
      changed.has("contextDoc") &&
      this.contextDoc !== changed.get("contextDoc");
    if (docChanged && !this._focused) {
      this._contextDraft = this.contextDoc ?? "";
    } else if (this.editing && changed.get("editing") === false) {
      this._contextDraft = this.contextDoc ?? "";
    }
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  /** Links route through colony-navigate; modified clicks keep the anchor. */
  /** @param {MouseEvent} event @param {string} href */
  #nav(event, href) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
      return;
    event.preventDefault();
    this.#emit("colony-navigate", { href });
  }

  /** @param {SubmitEvent} event */
  #submit(event) {
    event.preventDefault();
    this.#emit("colony-save-context", {
      project: this.project?.name ?? null,
      context_doc: String(
        new FormData(/** @type {HTMLFormElement} */ (event.target)).get(
          "project-context",
        ) ?? "",
      ),
    });
  }

  // Both branches carry the file summary and the Manage files link, so the
  // card body stays a single child part swapping between two whole
  // templates — lit's cleanup trips over a part sitting beside another
  // part when the branch swaps under happy-dom.
  #editor() {
    return html`<form
        class="project-context"
        @submit=${/** @param {SubmitEvent} e */ (e) => this.#submit(e)}
      >
        <textarea
          name="project-context"
          class="mono"
          placeholder="Background every agent packet in this project carries: architecture notes, conventions, constraints."
          .value=${this._contextDraft}
          @input=${
            /** @param {InputEvent} event */ (event) => {
              this._contextDraft = /** @type {HTMLInputElement} */ (
                event.target
              ).value;
            }
          }
          @focus=${() => {
            this._focused = true;
          }}
          @blur=${() => {
            this._focused = false;
          }}
        ></textarea>
        <div class="pc-actions">
          <button class="btn" type="submit">Save context</button>
          <button
            class="btn btn-quiet"
            type="button"
            @click=${() => this.#emit("colony-toggle", { key: "briefOpen" })}
          >
            Cancel
          </button>
          ${this.saveStatus === "saving"
            ? html`<span class="pc-status">Saving…</span>`
            : this.saveStatus === "saved"
              ? html`<span class="pc-status is-saved">Saved.</span>`
              : nothing}
        </div>
      </form>
      ${this.#fileList()}`;
  }

  /** @param {string} doc */
  #editButton(doc) {
    return html`<button
      class="btn btn-quiet"
      @click=${() => this.#emit("colony-toggle", { key: "briefOpen" })}
    >
      ${doc ? "Edit brief" : "Add brief"}
    </button>`;
  }

  /**
   * Read-only preview branch: rendered markdown + file list.
   * @param {string} doc
   */
  #preview(doc) {
    return doc
      ? html`<div class="knowledge-preview">
            <markdown-reader .markdown=${doc}></markdown-reader>
          </div>
          ${this.#fileList()}`
      : html`<p class="note">No brief yet.</p>
          ${this.#fileList()}`;
  }

  /** The file summary and the Manage files link, shared by both branches. */
  #fileList() {
    /** @type {Array<{filename: string, media_type: string, byte_size: number}>} */
    const files = this.files ?? [];
    return html`${files.length
        ? html`<ul class="file-list">
            ${files.map(
              (file) =>
                html`<li>
                  <span class="mono">${file.filename}</span>
                  <span>${file.media_type}</span>
                  <span class="mono">${file.byte_size} B</span>
                </li>`,
            )}
          </ul>`
        : nothing}<a
        class="btn btn-quiet"
        href=${projectFilesHref(this.project?.name ?? "")}
        @click=${
          /** @param {MouseEvent} event */ (event) =>
            this.#nav(event, projectFilesHref(this.project?.name ?? ""))
        }
        >Manage files</a
      >`;
  }

  render() {
    const project = this.project;
    if (!project) return nothing;
    const doc = this.contextDoc ?? "";
    // The child part sits flush against its parent's tags: a newline between
    // `<div>` and `${…}` leaves a text node lit cannot remove when the branch
    // swaps under happy-dom, which blows up the update. The short local keeps
    // the `>${body}</div>` pair on one line, and prettier with it.
    const action = this.editing ? nothing : this.#editButton(doc);
    const body = this.editing ? this.#editor() : this.#preview(doc);
    return html`<aside class="card">
      <p class="card-head">Project knowledge ${action}</p>
      <div class="card-body">${body}</div>
    </aside>`;
  }
}

customElements.define("project-context-card", ProjectContextCard);
