// <scope-create>: the "Open a scope" composer. Ported from renderCreate
// (app.js). No property-down state; the drafts live on the element.
// Events-up: colony-create-scope {goal, title, project, repo:{path},
// approvals} and colony-navigate for the Cancel link.
//
// Defect 2: every field is bound to an internal _*Draft property, never to
// live(). live() would force the DOM value back on each render, and the 2.5s
// poll re-renders this view, so the operator's half-typed project/title/goal
// would be rewritten from the (empty) drafts on every tick. The project draft
// is also seeded from the route's ?project= query on first render, and a
// fixed project renders as a link instead of an input.
import { ColonyElement, html, nothing } from "../base.js";
import { hashQueryProject, projectHref } from "../router.js";

export class ScopeCreate extends ColonyElement {
  static properties = {
    _projectDraft: { type: String, state: true },
    _titleDraft: { type: String, state: true },
    _goalDraft: { type: String, state: true },
    _pathDraft: { type: String, state: true },
    _approvals: { type: String, state: true },
    _seeded: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this._projectDraft = "";
    this._titleDraft = "";
    this._goalDraft = "";
    this._pathDraft = "";
    this._approvals = "manual";
    this._seeded = false;
  }

  willUpdate() {
    super.willUpdate();
    // Seed once from ?project= — after that the operator's typing wins, so a
    // poll-driven re-render can never reset the field they are filling in.
    if (!this._seeded) {
      this._seeded = true;
      this._projectDraft = hashQueryProject() ?? "";
    }
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }

  #submit(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const goal = String(this._goalDraft ?? "").trim();
    const path = String(this._pathDraft ?? "").trim();
    if (!goal || !path) return;
    const title = String(this._titleDraft ?? "").trim();
    this.#emit("colony-create-scope", {
      goal,
      ...(title ? { title } : {}),
      project: this._projectDraft ?? null,
      repo: { path },
      approvals: this._approvals || "auto",
    });
  }

  render() {
    const fixedProject = hashQueryProject();
    return html`<div class="create" id="draw">
      <aside class="card create-card">
        <p class="card-head">Open a scope</p>
        <div class="card-body">
          <form class="composer" @submit=${(e) => this.#submit(e)}>
            <p class="composer-hint">
              Colony plans the work, opens merge requests, and merges what
              passes. Write the goal like a brief for an engineer who cannot ask
              questions: outcomes, constraints, and what done looks like.
            </p>
            ${fixedProject
              ? html`<p class="composer-fixed">
                  Project:
                  <a href=${projectHref(fixedProject)}>${fixedProject}</a>
                </p>`
              : html`<label class="field">
                  <span>Project <em>optional</em></span>
                  <input
                    name="project"
                    maxlength="120"
                    placeholder="Project this scope belongs to"
                    autocomplete="off"
                    .value=${this._projectDraft ?? ""}
                    @input=${(event) => {
                      this._projectDraft = event.target.value;
                    }}
                  />
                </label>`}
            <label class="field">
              <span>Title <em>optional</em></span>
              <input
                name="title"
                maxlength="120"
                placeholder="Short label for the board"
                autocomplete="off"
                .value=${this._titleDraft ?? ""}
                @input=${(event) => {
                  this._titleDraft = event.target.value;
                }}
              />
            </label>
            <label class="field">
              <span>Goal</span>
              <textarea
                name="goal"
                required
                rows="12"
                placeholder="What should the factory build?"
                .value=${this._goalDraft ?? ""}
                @input=${(event) => {
                  this._goalDraft = event.target.value;
                }}
              ></textarea>
            </label>
            <label class="field">
              <span>GitLab repo path</span>
              <input
                name="path"
                required
                placeholder="so/my-repo"
                autocomplete="off"
                .value=${this._pathDraft ?? ""}
                @input=${(event) => {
                  this._pathDraft = event.target.value;
                }}
              />
            </label>
            <label class="field">
              <span>Approvals</span>
              <select
                name="approvals"
                .value=${this._approvals ?? "manual"}
                @change=${(event) => {
                  this._approvals = event.target.value;
                }}
              >
                <option value="manual">
                  Manual — you approve the plan and every merge
                </option>
                <option value="auto">
                  Automatic — plan and merges run unattended
                </option>
              </select>
            </label>
            <div class="create-actions">
              <button class="btn btn-solid" type="submit">Open scope</button>
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

customElements.define("scope-create", ScopeCreate);
