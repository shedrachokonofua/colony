// <project-context-card>: the project's knowledge brief — read-only preview
// or the Markdown editor. Ported from renderProjectContextCard (app.js).
// Property-down: project, contextDoc, editing. Events-up: colony-toggle
// {key:"briefOpen"} and colony-save-context {project, context_doc}.
//
// Defect 1: the textarea is bound to the internal _contextDraft, never to
// live(contextDoc). A live() binding makes every 2.5s poll rewrite
// textarea.value, which throws away the caret and the operator's in-flight
// edits. The draft is the source of truth while the operator types; the
// incoming doc is adopted only when it actually changed and the textarea is
// not focused (see willUpdate).
import { ColonyElement, html, nothing } from "../base.js";
import "./markdown-reader.js";

export class ProjectContextCard extends ColonyElement {
  static properties = {
    project: { type: Object },
    contextDoc: { type: String },
    editing: { type: Boolean },
    _contextDraft: { type: String, state: true },
    _focused: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this.project = null;
    this.contextDoc = "";
    this.editing = false;
    this._contextDraft = "";
    this._focused = false;
  }

  willUpdate(changed) {
    super.willUpdate(changed);
    // Adopt a new doc from the server unless the operator is typing in the
    // textarea: an unfocused editor is showing a value nobody is editing, so
    // a poll may refresh it, but a focused one is the operator's draft.
    if (
      changed.has("contextDoc") &&
      this.contextDoc !== changed.get("contextDoc")
    ) {
      if (!this._focused) this._contextDraft = this.contextDoc ?? "";
    }
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  #submit(event) {
    event.preventDefault();
    this.#emit("colony-save-context", {
      project: this.project?.name ?? null,
      context_doc: String(
        new FormData(event.target).get("project-context") ?? "",
      ),
    });
  }

  #editor() {
    return html`<form class="project-context" @submit=${(e) => this.#submit(e)}>
      <textarea
        name="project-context"
        class="mono"
        placeholder="Background every agent packet in this project carries: architecture notes, conventions, constraints."
        .value=${this._contextDraft}
        @input=${(event) => {
          this._contextDraft = event.target.value;
        }}
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
      </div>
    </form>`;
  }

  #editButton(doc) {
    return html`<button
      class="btn btn-quiet"
      @click=${() => this.#emit("colony-toggle", { key: "briefOpen" })}
    >
      ${doc ? "Edit brief" : "Add brief"}
    </button>`;
  }

  #preview(doc) {
    return doc
      ? html`<div class="knowledge-preview">
          <markdown-reader .markdown=${doc}></markdown-reader>
        </div>`
      : html`<p class="note">No brief yet.</p>`;
  }

  render() {
    const project = this.project;
    if (!project) return nothing;
    const doc = this.contextDoc ?? "";
    // The child part sits flush against its parent's tags: a newline between
    // `<div>` and `${…}` leaves a text node lit cannot remove when the branch
    // swaps under happy-dom, which blows up the update. The short local keeps
    // the `>${body}</div>` pair on one line, and prettier with it.
    const body = this.editing ? this.#editor() : this.#preview(doc);
    const action = this.editing ? nothing : this.#editButton(doc);
    return html`<aside class="card">
      <p class="card-head">Project knowledge ${action}</p>
      <div class="card-body">${body}</div>
    </aside>`;
  }
}

customElements.define("project-context-card", ProjectContextCard);
