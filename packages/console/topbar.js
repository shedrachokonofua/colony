import { ColonyElement, html, nothing } from "./base.js";
import {
  projectHref,
  routeIsManageFiles,
  routeIsNew,
  routeIsNewProject,
  routeProjectName,
  routeScopeId,
} from "./router.js";

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
    detail: { state: true },
    _draftActor: { state: true },
  };

  constructor() {
    super();
    this.actor = "";
    /** @type {Record<string, any> | null} */
    this.config = null;
    /** @type {{ username: string } | null} */
    this.auth = null;
    /** @type {Record<string, any> | null} */
    this.oidc = null;
    /** @type {{ scope?: { project_name?: string | null } } | null} */
    this.detail = null;
    this._draftActor = "";
  }

  connectedCallback() {
    super.connectedCallback();
    // Crumbs read the URL live at render; this listener only forces the
    // re-render, because the shell's re-render does not change any topbar
    // property on a pure navigation.
    window.addEventListener("hashchange", this);
  }

  disconnectedCallback() {
    window.removeEventListener("hashchange", this);
    super.disconnectedCallback();
  }

  handleEvent() {
    this.requestUpdate();
  }

  /** Changes commit on change/Enter (like the monolith's saveActor). */
  /** @param {{ target: { value?: string | null } } | Event} event */
  #saveActor(event) {
    const actor = String(
      /** @type {{ value?: string | null }} */ (event.target)?.value ?? "",
    ).trim();
    this._draftActor = actor;
    if (!actor || actor === this.actor) return;
    this.dispatchEvent(
      new CustomEvent("colony-actor-change", {
        bubbles: true,
        detail: { actor },
      }),
    );
  }

  /** @param {SubmitEvent} event */
  #submitActor(event) {
    event.preventDefault();
    this.#saveActor({ target: { value: this._draftActor } });
  }

  render() {
    // The monolith read the route at every render; router.js owns the parsing
    // so the topbar cannot drift from it.
    const scopeId = routeScopeId();
    const projectName = routeProjectName();
    const isNew = routeIsNew();
    const isNewProject = routeIsNewProject();
    const isFiles = routeIsManageFiles();
    const scopeProject = scopeId
      ? this.detail?.scope?.project_name || null
      : null;
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
      : html`<form
          class="sign"
          @submit=${/** @param {SubmitEvent} e */ (e) => this.#submitActor(e)}
        >
          <label>
            <span>Operator</span>
            <input
              name="actor"
              .value=${this._draftActor || this.actor}
              spellcheck="false"
              @change=${/** @param {Event} e */ (e) => this.#saveActor(e)}
            />
          </label>
        </form>`;
    return html`<header class="topbar">
      <a
        class="brand"
        href="#/"
        @click=${/** @param {MouseEvent} e */ (e) => this.#navigate(e, "#/")}
        >${brandMark()}<span>COLONY</span></a
      >
      <nav class="crumbs" aria-label="Breadcrumb">
        <a
          href="#/"
          @click=${/** @param {MouseEvent} e */ (e) => this.#navigate(e, "#/")}
          >Projects</a
        >
        ${projectName
          ? html`<span class="crumb-sep">/</span>
              <a
                class="crumb"
                href=${projectHref(projectName)}
                @click=${
                  /** @param {MouseEvent} e */ (e) =>
                    this.#navigate(e, projectHref(projectName))
                }
                >${projectName}</a
              >`
          : nothing}
        ${isNew
          ? html`<span class="crumb-sep">/</span>
              <span class="crumb">new scope</span>`
          : nothing}
        ${isNewProject
          ? html`<span class="crumb-sep">/</span>
              <span class="crumb">new project</span>`
          : nothing}
        ${isFiles
          ? html`<span class="crumb-sep">/</span>
              <span class="crumb">files</span>`
          : nothing}
        ${scopeProject
          ? html`<span class="crumb-sep">/</span>
              <a
                class="crumb"
                href=${projectHref(scopeProject)}
                @click=${
                  /** @param {MouseEvent} e */ (e) =>
                    this.#navigate(e, projectHref(scopeProject))
                }
                >${scopeProject}</a
              >`
          : nothing}
        ${scopeId
          ? html`<span class="crumb-sep">/</span>
              <span class="crumb mono">${scopeId}</span>`
          : nothing}
      </nav>
      ${account}
    </header>`;
  }

  /** @param {MouseEvent} event @param {string} href */
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
