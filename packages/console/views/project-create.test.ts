// Unit tests for <project-create>, under happy-dom: the new-project form,
// submit emitting colony-create-project {name, context_doc}, and — the
// poll-safety contract — the drafts surviving a re-render with no live()
// binding anywhere in the template.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "../elements/test-dom.js";

sharedDom();

await import("./project-create.js");

function makeCreate() {
  const el = document.createElement("project-create");
  document.body.append(el);
  return el;
}

function eventsOf(el) {
  const seen = [];
  for (const type of ["colony-create-project", "colony-navigate"]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

function field(el, name) {
  return el.querySelector(`[name="${name}"]`);
}

function type(el, name, value) {
  const input = field(el, name);
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function submit(el) {
  el.querySelector("form.composer").dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("project-create structure", () => {
  it("renders the monolith's two fields with their limits", async () => {
    const el = makeCreate();
    await el.updateComplete;
    expect(el.querySelector(".card-head")?.textContent).toBe("New project");
    const name = field(el, "name");
    expect(name.required).toBe(true);
    expect(name.getAttribute("maxlength")).toBe("120");
    expect(name.getAttribute("placeholder")).toBe("Project name");
    expect(name.getAttribute("autocomplete")).toBe("off");
    const brief = field(el, "context_doc");
    expect(brief.getAttribute("rows")).toBe("10");
    expect(brief.getAttribute("placeholder")).toContain(
      "Background every agent packet",
    );
    expect(el.querySelector(".create-actions button")?.textContent).toContain(
      "Create project",
    );
  });

  it("starts empty", async () => {
    const el = makeCreate();
    await el.updateComplete;
    expect(field(el, "name").value).toBe("");
    expect(field(el, "context_doc").value).toBe("");
  });
});

describe("project-create submit", () => {
  it("emits colony-create-project with the trimmed name and the brief", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    type(el, "name", "  My Project  ");
    type(el, "context_doc", "# Brief\n\nNotes.");
    await el.updateComplete;
    submit(el);
    expect(seen).toEqual([
      [
        "colony-create-project",
        { name: "My Project", context_doc: "# Brief\n\nNotes." },
      ],
    ]);
  });

  it("sends an empty brief when none is given", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    type(el, "name", "Bare");
    await el.updateComplete;
    submit(el);
    expect(seen).toEqual([
      ["colony-create-project", { name: "Bare", context_doc: "" }],
    ]);
  });

  it("refuses to submit a blank name", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    type(el, "name", "   ");
    await el.updateComplete;
    submit(el);
    expect(seen).toEqual([]);
    type(el, "name", "Real");
    await el.updateComplete;
    submit(el);
    expect(seen.length).toBe(1);
  });

  it("Cancel bubbles colony-navigate home", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    el.querySelector(".create-actions a.btn-quiet").click();
    expect(seen).toEqual([["colony-navigate", { href: "#/" }]]);
  });
});

describe("project-create drafts survive re-render", () => {
  it("typed values stay put across a poll-driven re-render", async () => {
    const el = makeCreate();
    await el.updateComplete;
    type(el, "name", "Half typed");
    type(el, "context_doc", "# Draft");
    await el.updateComplete;
    // A poll re-renders the view; nothing may rewrite the inputs.
    el.requestUpdate();
    await el.updateComplete;
    el.requestUpdate();
    await el.updateComplete;
    expect(field(el, "name").value).toBe("Half typed");
    expect(field(el, "context_doc").value).toBe("# Draft");
  });

  it("a keystroke after a re-render keeps the whole value", async () => {
    const el = makeCreate();
    await el.updateComplete;
    type(el, "name", "Pro");
    await el.updateComplete;
    el.requestUpdate();
    await el.updateComplete;
    type(el, "name", "Project");
    await el.updateComplete;
    expect(field(el, "name").value).toBe("Project");
    expect(el._nameDraft).toBe("Project");
  });
});
