// ⚠ No decorators — this is a buildless project. Reactive properties are
// declared with `static properties = { ... }` blocks only.
import { LitElement } from "lit";
class ColonyElement extends LitElement {
  createRenderRoot() {
    return this;
  }
}
export { ColonyElement };
export { html, svg, nothing } from "lit";
export { classMap } from "lit-html/directives/class-map.js";
export { repeat } from "lit-html/directives/repeat.js";
export { live } from "lit-html/directives/live.js";
