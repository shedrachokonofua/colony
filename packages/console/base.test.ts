// Base module unit tests, under happy-dom.
// @ts-nocheck
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./elements/test-dom.js";

// Element suites share this window and registry (bun runs every suite in one
// process with one module cache); the shared window must be installed before
// base.js (and therefore lit) is imported.
sharedDom();

const base = await import("./base.js");
const { ColonyElement, html, nothing, svg } = base;

const baseSource = readFileSync(new URL("./base.js", import.meta.url), "utf8");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("base.js module surface", () => {
  it("exports exactly the base plus the lit renderers and directives", () => {
    expect(Object.keys(base).sort()).toEqual([
      "ColonyElement",
      "classMap",
      "html",
      "live",
      "nothing",
      "repeat",
      "svg",
    ]);
  });

  it("re-exports the same html template tag lit itself exports", async () => {
    const lit = await import("lit");
    expect(html).toBe(lit.html);
    expect(svg).toBe(lit.svg);
    expect(nothing).toBe(lit.nothing);
  });

  it("keeps decorators out of the buildless source", () => {
    expect(baseSource).toContain("class ColonyElement extends LitElement");
    expect(baseSource).toContain("static properties");
    for (const decorator of ["@customElement(", "@property(", "@state("]) {
      expect(baseSource.includes(decorator), `${decorator} must stay out`).toBe(
        false,
      );
    }
  });
});

describe("ColonyElement", () => {
  it("is a light-DOM LitElement: createRenderRoot() returns this", async () => {
    // happy-dom only permits element construction through a document.
    const el = document.createElement("div");
    const proto = ColonyElement.prototype;
    expect(proto.createRenderRoot.call(el)).toBe(el);
    expect(
      ColonyElement.prototype instanceof (await import("lit")).LitElement,
    ).toBe(true);
  });

  it("renders into the host element with no shadow root", async () => {
    class Probe extends ColonyElement {
      static properties = { msg: { state: true } };
      constructor() {
        super();
        this.msg = "hello";
      }
      render() {
        return html`<p class="probe">${this.msg}</p>
          ${nothing}`;
      }
    }
    customElements.define("base-probe-element", Probe);
    const el = document.createElement("base-probe-element");
    document.body.append(el);
    await el.updateComplete;
    expect(el.shadowRoot ?? null).toBeNull();
    const p = el.firstElementChild;
    expect(p?.textContent).toBe("hello");
    // Reactive updates still work in light DOM.
    el.msg = "changed";
    await el.updateComplete;
    expect(el.firstElementChild?.textContent).toBe("changed");
  });

  it("re-exported svg template tag renders into the light host", async () => {
    class SvgProbe extends ColonyElement {
      render() {
        return svg`<svg viewBox="0 0 2 2"><rect width="2" height="2" /></svg>`;
      }
    }
    customElements.define("base-svg-probe", SvgProbe);
    const el = document.createElement("base-svg-probe");
    document.body.append(el);
    await el.updateComplete;
    expect(el.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(el.querySelector("rect")).toBeTruthy();
  });
});
