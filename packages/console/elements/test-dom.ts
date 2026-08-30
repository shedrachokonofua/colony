// Shared happy-dom harness for the element suites.
//
// bun test executes every suite in one process with one module cache, and
// each element module calls customElements.define() at import time. With a
// window per suite, the first suite to load a module would define its class
// into a registry every later suite has already replaced — nested elements
// (<run-list> -> <run-line> -> <run-duration>) would then be born as plain
// HTMLElements outside the class and crash on connectedCallback. So all the
// element suites must share this one window and registry; the first caller
// installs it, later callers reuse it.
//
// @ts-nocheck — mirrors the element test files it serves.
import { Window } from "happy-dom";

let dom = null;

/**
 * Install (once per process) and return the shared DOM globals.
 * Element suites must call this before dynamically importing element
 * modules; the modules register against the shared registry on first load.
 */
export function sharedDom() {
  if (dom) return dom;
  const win = new Window({ url: "https://console.local/" });
  win.window = win;
  // reactive-element reads these at lit-import time, so they must be in
  // place before any element module (and therefore lit) is imported.
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.customElements = win.customElements;
  globalThis.HTMLElement = win.HTMLElement;
  dom = { window: win, document: win.document };
  return dom;
}
