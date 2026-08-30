import { ColonyElement, html, nothing } from "./base.js";

// Ported from the monolith's BRAND_MARK so the topbar and the sign-in card
// render the identical three-cell mark.
export function brandMark() {
  return html`<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
    <path
      class="cell cell-a"
      d="M7 2.5 L11.5 5 L11.5 10 L7 12.5 L2.5 10 L2.5 5 Z"
    />
    <path
      class="cell cell-b"
      d="M17 6.5 L21.5 9 L21.5 14 L17 16.5 L12.5 14 L12.5 9 Z"
    />
    <path
      class="cell cell-c"
      d="M8.5 12.5 L13 15 L13 20 L8.5 22.5 L4 20 L4 15 Z"
    />
  </svg>`;
}

/**
 * Topbar: brand, breadcrumb, account. Property-down: the shell feeds actor,
 * config, auth, oidc. Events-up: edits bubble as colony-actor-change,
 * colony-signin, colony-signout; links bubble as colony-navigate so the
 * shell owns the hash.
 */
export class ColonyTopbar extends ColonyElement {
  static properties = {
    actor: { state: true },
    config: { state: true },
    auth: { state: true },
    oidc: { state: true },
    _draftActor: { state: true },
    _route: { state: true },
  };

  constructor() {
    super();
    this.actor = "";
    this.config = null;
    this.auth = null;
    this.oidc = null;
    this._draftActor = "";
    this._route = { scopeId: null, projectName: null, isNew: false };
  }

  /**
   * Breadcrumbs depend on the URL, not on shell props; read the hash at
   * render time so paint-after-navigation is always current.
   */
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("hashchange", this);
  }

  disconnectedCallback() {
    window.removeEventListener("hashchange", this);
    super.disconnectedCallback();
  }

  handleEvent() {
    this._route = this.#readRoute();
  }

  #readRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    const project = hash.match(/^project\/([^/?]+)/);
    return {
      scopeId: project || /^new/.test(hash) ? null : hash || null,
      projectName: project ? decodeURIComponent(project[1]) : null,
      isNew: /^new(?:-project)?(?:$|\?)/.test(hash),
    };
  }

  /** Changes commit on change/Enter (like the monolith's saveActor). */
  #saveActor(event) {
    const actor = String(event.target.value ?? "").trim();
    this._draftActor = actor;
    if (!actor || actor === this.actor) return;
    this.dispatchEvent(
      new CustomEvent("colony-actor-change", {
        bubbles: true,
        detail: { actor },
      }),
    );
  }

  #submitActor(event) {
    event.preventDefault();
    this.#saveActor({ target: { value: this._draftActor } });
  }

  render() {
    const { scopeId, projectName, isNew } = this._route;
    const projectHref = projectName
      ? `#/project/${encodeURIComponent(projectName)}`
      : "#/";
    const account = this.oidc
      ? this.auth
        ? html`<div class="sign account">
            <span class="whoami mono">${this.auth.username}</span>
            <button
              class="btn btn-quiet"
              @click=${() =>
                this.dispatchEvent(
                  new CustomEvent("colony-signout", { bubbles: true }),
                )}
            >
              Sign out
            </button>
          </div>`
        : html`<div class="sign"></div>`
      : html`<form class="sign" @submit=${(e) => this.#submitActor(e)}>
          <label>
            <span>Operator</span>
            <input
              name="actor"
              .value=${this._draftActor || this.actor}
              spellcheck="false"
              @change=${(e) => this.#saveActor(e)}
            />
          </label>
        </form>`;
    return html`<header class="topbar">
      <a class="brand" href="#/" @click=${(e) => this.#navigate(e, "#/")}
        >${brandMark()}<span>COLONY</span></a
      >
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/" @click=${(e) => this.#navigate(e, "#/")}>Projects</a>
        ${projectName
          ? html`<span class="crumb-sep">/</span>
              <a
                class="crumb"
                href=${projectHref}
                @click=${(e) => this.#navigate(e, projectHref)}
                >${projectName}</a
              >`
          : nothing}
        ${isNew
          ? html`<span class="crumb-sep">/</span>
              <span class="crumb">new scope</span>`
          : nothing}
        ${scopeId
          ? html`<span class="crumb-sep">/</span>
              <span class="crumb mono">${scopeId}</span>`
          : nothing}
      </nav>
      <div class="nav-new">
        <a
          class="btn btn-quiet"
          href="#/new-project"
          @click=${(e) => this.#navigate(e, "#/new-project")}
          >New project</a
        >
        <a
          class="btn btn-quiet"
          href="#/new"
          @click=${(e) => this.#navigate(e, "#/new")}
          >New scope</a
        >
      </div>
      ${account}
    </header>`;
  }

  #navigate(event, href) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("colony-navigate", { bubbles: true, detail: { href } }),
    );
  }
}

customElements.define("colony-topbar", ColonyTopbar);
