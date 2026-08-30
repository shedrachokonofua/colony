// <project-create>: the new-project form. Ported from renderNewProject
// (app.js). No property-down state; the drafts live on the element.
// Events-up: colony-create-project {name, context_doc} and colony-navigate
// for the Cancel link. No live() bindings anywhere: the 2.5s poll re-renders
// this view, and a live() binding would rewrite both fields from the drafts
// on every tick, eating whatever the operator is typing.
import { ColonyElement, html } from "../base.js";

export class ProjectCreate extends ColonyElement {
  static properties = {
    _nameDraft: { type: String, state: true },
    _contextDraft: { type: String, state: true },
  };

  constructor() {
    super();
    this._nameDraft = "";
    this._contextDraft = "";
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  #submit(event) {
    event.preventDefault();
    const name = String(this._nameDraft ?? "").trim();
    if (!name) return;
    this.#emit("colony-create-project", {
      name,
      context_doc: this._contextDraft ?? "",
    });
  }

  render() {
    return html`<div class="create" id="draw">
      <aside class="card create-card">
        <p class="card-head">New project</p>
        <div class="card-body">
          <form class="composer" @submit=${(e) => this.#submit(e)}>
            <label class="field">
              <span>Name</span>
              <input
                name="name"
                required
                maxlength="120"
                placeholder="Project name"
                autocomplete="off"
                .value=${this._nameDraft ?? ""}
                @input=${(event) => {
                  this._nameDraft = event.target.value;
                }}
              />
            </label>
            <label class="field">
              <span>Brief <em>optional Markdown</em></span>
              <textarea
                name="context_doc"
                rows="10"
                placeholder="Background every agent packet in this project carries: architecture notes, conventions, constraints."
                .value=${this._contextDraft ?? ""}
                @input=${(event) => {
                  this._contextDraft = event.target.value;
                }}
              ></textarea>
            </label>
            <div class="create-actions">
              <button class="btn btn-solid" type="submit">
                Create project
              </button>
              <a
                class="btn btn-quiet"
                href="#/"
                @click=${(event) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.button
                  )
                    return;
                  event.preventDefault();
                  this.#emit("colony-navigate", { href: "#/" });
                }}
                >Cancel</a
              >
            </div>
          </form>
        </div>
      </aside>
    </div>`;
  }
}

customElements.define("project-create", ProjectCreate);
