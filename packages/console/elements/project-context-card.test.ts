// Unit tests for <project-context-card>, under happy-dom: the preview/edit
// branches and — the defect-1 contract — the textarea draft surviving the
// 2.5s poll. An unfocused editor adopts a changed contextDoc; a focused one
// never does, and it catches up on blur.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./test-dom.js";

// Element suites share this window and registry (bun runs every suite in one
// process with one module cache); the shared window must be installed before
// any element module (and therefore lit) is imported.
sharedDom();

await import("./project-context-card.js");

const PROJECT = { name: "Operator console", context_doc: "# Brief" };

function makeCard(props = {}) {
  const el = document.createElement("project-context-card");
  el.project = PROJECT;
  el.contextDoc = "";
  el.editing = false;
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  return el;
}

function eventsOf(el) {
  const seen = [];
  for (const type of ["colony-toggle", "colony-save-context"]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

function textarea(el) {
  return el.querySelector('textarea[name="project-context"]');
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("project-context-card preview", () => {
  it("renders nothing without a project", async () => {
    const el = makeCard({ project: null });
    await el.updateComplete;
    expect(el.querySelector(".card")).toBeNull();
  });

  it("offers Add brief with no doc and Edit brief once one exists", async () => {
    const empty = makeCard();
    await empty.updateComplete;
    expect(empty.querySelector(".card-head button")?.textContent.trim()).toBe(
      "Add brief",
    );
    expect(empty.querySelector(".card-body p.note")?.textContent).toBe(
      "No brief yet.",
    );

    const filled = makeCard({ contextDoc: "# Brief" });
    await filled.updateComplete;
    expect(filled.querySelector(".card-head button")?.textContent.trim()).toBe(
      "Edit brief",
    );
    expect(filled.querySelector("p.note")).toBeNull();
  });

  it("renders the doc through <markdown-reader>, not raw text", async () => {
    const el = makeCard({ contextDoc: "# Heading\n\nBody text." });
    await el.updateComplete;
    const reader = el.querySelector(".knowledge-preview markdown-reader");
    expect(reader).toBeTruthy();
    expect(reader.markdown).toBe("# Heading\n\nBody text.");
    // renderMarkdown demotes `#` to <h2> (app.js levels headings below the
    // page's own h1), so the preview is real markup, not escaped text.
    expect(reader.querySelector("h2")?.textContent).toBe("Heading");
    expect(reader.querySelector("p")?.textContent).toBe("Body text.");
  });

  it("the Edit brief button bubbles colony-toggle {key:briefOpen}", async () => {
    const el = makeCard({ contextDoc: "# Brief" });
    const seen = eventsOf(el);
    await el.updateComplete;
    el.querySelector(".card-head button").click();
    expect(seen).toEqual([["colony-toggle", { key: "briefOpen" }]]);
  });

  it("hides the toggle while editing and bubbles it from Cancel", async () => {
    const el = makeCard({ contextDoc: "# Brief", editing: true });
    const seen = eventsOf(el);
    await el.updateComplete;
    expect(el.querySelector(".card-head button")).toBeNull();
    [...el.querySelectorAll(".pc-actions button")]
      .find((b) => b.textContent.trim() === "Cancel")
      .click();
    expect(seen).toEqual([["colony-toggle", { key: "briefOpen" }]]);
  });
});

describe("project-context-card editor", () => {
  it("prefills the textarea from the current doc when it opens", async () => {
    const el = makeCard({ contextDoc: "# Brief", editing: true });
    await el.updateComplete;
    expect(textarea(el).value).toBe("# Brief");
  });

  it("Save context bubbles colony-save-context with the project and draft", async () => {
    const el = makeCard({ contextDoc: "# Brief", editing: true });
    const seen = eventsOf(el);
    await el.updateComplete;
    textarea(el).value = "# Edited";
    textarea(el).dispatchEvent(new window.Event("input", { bubbles: true }));
    await el.updateComplete;
    el.querySelector("form.project-context").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(seen).toEqual([
      [
        "colony-save-context",
        { project: "Operator console", context_doc: "# Edited" },
      ],
    ]);
  });

  it("leaving the editor removes the form and restores the preview", async () => {
    // Regression: the card's child parts sit flush against their tags. A
    // newline around a child part leaves a text node lit cannot remove when
    // the branch swaps, which crashes the update under happy-dom.
    const el = makeCard({ contextDoc: "# Brief", editing: true });
    await el.updateComplete;
    expect(el.querySelector("form.project-context")).toBeTruthy();
    el.editing = false;
    await el.updateComplete;
    expect(el.querySelector("form.project-context")).toBeNull();
    expect(el.querySelector(".knowledge-preview markdown-reader")).toBeTruthy();
    el.editing = true;
    await el.updateComplete;
    expect(el.querySelector("form.project-context")).toBeTruthy();
  });

  it("an empty submit sends the empty string, which Save turns into null", async () => {
    const el = makeCard({ contextDoc: "# Brief", editing: true });
    const seen = eventsOf(el);
    await el.updateComplete;
    textarea(el).value = "";
    textarea(el).dispatchEvent(new window.Event("input", { bubbles: true }));
    await el.updateComplete;
    el.querySelector("form.project-context").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(seen).toEqual([
      ["colony-save-context", { project: "Operator console", context_doc: "" }],
    ]);
  });
});

describe("project-context-card draft vs poll (defect 1)", () => {
  it("an unfocused editor adopts a changed contextDoc from the poll", async () => {
    const el = makeCard({ contextDoc: "orig", editing: true });
    await el.updateComplete;
    expect(el._contextDraft).toBe("orig");
    el.contextDoc = "poll";
    await el.updateComplete;
    expect(el._contextDraft).toBe("poll");
    expect(textarea(el).value).toBe("poll");
  });

  it("a focused editor keeps its draft through polls and catches up on blur", async () => {
    const el = makeCard({ contextDoc: "orig", editing: true });
    await el.updateComplete;
    // The element tracks focus through the real @focus/@blur handlers, so
    // drive the actual events rather than setting the state by hand.
    textarea(el).dispatchEvent(new window.FocusEvent("focus"));
    await el.updateComplete;
    expect(el._focused).toBe(true);

    // Poll while focused: the draft and the textarea both stay put.
    el.contextDoc = "poll2";
    await el.updateComplete;
    expect(el._contextDraft).toBe("orig");
    expect(textarea(el).value).toBe("orig");

    // Blur, then poll again: the new doc lands.
    textarea(el).dispatchEvent(new window.FocusEvent("blur"));
    await el.updateComplete;
    expect(el._focused).toBe(false);
    el.contextDoc = "poll3";
    await el.updateComplete;
    expect(el._contextDraft).toBe("poll3");
  });

  it("typing updates the draft and survives a re-render with the same doc", async () => {
    const el = makeCard({ contextDoc: "orig", editing: true });
    await el.updateComplete;
    textarea(el).value = "typed";
    textarea(el).dispatchEvent(new window.Event("input", { bubbles: true }));
    await el.updateComplete;
    expect(el._contextDraft).toBe("typed");
    // A poll that re-sends the identical doc must not clobber the typing.
    el.contextDoc = "orig";
    await el.updateComplete;
    expect(el._contextDraft).toBe("typed");
    expect(textarea(el).value).toBe("typed");
  });

  it("re-opening the editor (editing false -> true) re-adopts the latest doc", async () => {
    const el = makeCard({ contextDoc: "orig", editing: true });
    await el.updateComplete;
    textarea(el).value = "typed";
    textarea(el).dispatchEvent(new window.Event("input", { bubbles: true }));
    await el.updateComplete;
    el.editing = false;
    await el.updateComplete;
    el.contextDoc = "server";
    el.editing = true;
    await el.updateComplete;
    expect(el._contextDraft).toBe("server");
  });
});
