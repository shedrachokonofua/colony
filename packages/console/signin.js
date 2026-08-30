import { ColonyElement, html, nothing } from "./base.js";
import { brandMark } from "./topbar.js";

/**
 * Sign-in prompt for OIDC-gated deployments. The button bubbles
 * colony-signin; the shell's handler starts the PKCE flow.
 */
export class ColonySignin extends ColonyElement {
  static properties = {
    error: { state: true },
  };

  constructor() {
    super();
    this.error = "";
  }

  render() {
    return html`<div class="signin">
      <div class="card signin-card">
        <p class="signin-brand">${brandMark()}COLONY</p>
        <p class="note">
          Sign in with your aether account to operate the factory.
        </p>
        ${this.error
          ? html`<div class="banner banner-error" role="alert">
              ${this.error}
            </div>`
          : nothing}
        <button
          class="btn btn-solid"
          @click=${() =>
            this.dispatchEvent(
              new CustomEvent("colony-signin", { bubbles: true }),
            )}
        >
          Sign in
        </button>
      </div>
    </div>`;
  }
}

customElements.define("colony-signin", ColonySignin);
