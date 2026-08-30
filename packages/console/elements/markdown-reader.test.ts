// Unit tests for <markdown-reader>, under happy-dom: markdown must render
// into the light host through renderMarkdown, and a poll that re-sends the
// same text must leave the DOM untouched (text selection survives).
// @ts-nocheck
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "bun:test";

// reactive-element's happy-dom mode patches `window.HTMLElement`, so the
// Window globals must be installed before `../base.js` (and therefore lit)
// is imported; dynamic import here is the sequencing primitive.
const win = new Window({ url: "https://console.local/" });
win.window = win;
globalThis.window = win;
globalThis.document = win.document;
globalThis.customElements = win.customElements;
globalThis.HTMLElement = win.HTMLElement;

await import("./markdown-reader.js");

function makeReader() {
  return document.createElement("markdown-reader");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("markdown-reader", () => {
  it("renders markdown into the light host", async () => {
    const el = makeReader();
    document.body.append(el);
    el.markdown = "# Title\n\nA paragraph with **bold**.";
    await el.updateComplete;
    expect(el.shadowRoot ?? null).toBeNull();
    expect(el.querySelector("h2")?.textContent).toBe("Title");
    const strong = el.querySelector("strong");
    expect(strong?.textContent).toBe("bold");
  });

  it("re-renders only when the markdown actually changes", async () => {
    const el = makeReader();
    document.body.append(el);
    el.markdown = "# One";
    await el.updateComplete;
    const h2 = el.querySelector("h2");
    expect(h2?.textContent).toBe("One");
    // Same value again: the element must not rebuild the DOM (a lit element
    // with an html`` render would wipe and repaint here).
    el.markdown = "# One";
    await el.updateComplete;
    expect(el.querySelector("h2")).toBe(h2);
    el.markdown = "# Two";
    await el.updateComplete;
    expect(el.querySelector("h2")?.textContent).toBe("Two");
    expect(el.querySelector("h2")).not.toBe(h2);
  });

  it("escapes html so agent-authored text cannot inject markup", async () => {
    const el = makeReader();
    document.body.append(el);
    el.markdown = '<img src=x onerror="alert(1)">';
    await el.updateComplete;
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=");
  });

  it("renders an empty pane for missing markdown", async () => {
    const el = makeReader();
    document.body.append(el);
    await el.updateComplete;
    expect(el.innerHTML).toBe("");
    el.markdown = null;
    await el.updateComplete;
    expect(el.innerHTML).toBe("");
  });
});
