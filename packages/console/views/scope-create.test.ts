// Unit tests for <scope-create>, under happy-dom: the composer renders every
// field, submit emits colony-create-scope with the shell's payload shape, and
// — the defect-2 contract — every draft survives a re-render: with live() the
// 2.5s poll would rewrite the inputs from the empty drafts and eat whatever
// the operator was typing.
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sharedDom } from "../elements/test-dom.js";

sharedDom();

// hashQueryProject() (router.js) reads the global `location`, which the
// shared harness does not put on globalThis; alias it from the same window.
globalThis.location = window.location;

await import("./scope-create.js");

function makeCreate() {
  const el = document.createElement("scope-create");
  document.body.append(el);
  return el;
}

function eventsOf(el) {
  const seen = [];
  for (const type of ["colony-create-scope", "colony-navigate"]) {
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

/** Fill every field the way an operator would. */
async function fill(el, overrides = {}) {
  const values = {
    project: "My project",
    title: "Ship it",
    goal: "Build the thing",
    path: "so/colony",
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) type(el, name, value);
  await el.updateComplete;
  return values;
}

beforeEach(() => {
  window.location.hash = "#/new";
});

afterEach(() => {
  document.body.innerHTML = "";
  window.location.hash = "#/";
});

describe("scope-create structure", () => {
  it("renders every field with the monolith's labels and limits", async () => {
    const el = makeCreate();
    await el.updateComplete;
    expect(el.querySelector(".card-head")?.textContent).toBe("Open a scope");
    expect(el.querySelector(".composer-hint")?.textContent).toContain(
      "Colony plans the work",
    );
    const project = field(el, "project");
    expect(project.getAttribute("maxlength")).toBe("120");
    expect(project.getAttribute("placeholder")).toBe(
      "Project this scope belongs to",
    );
    const title = field(el, "title");
    expect(title.getAttribute("maxlength")).toBe("120");
    expect(title.getAttribute("placeholder")).toBe("Short label for the board");
    const goal = field(el, "goal");
    expect(goal.required).toBe(true);
    expect(goal.getAttribute("rows")).toBe("12");
    expect(goal.getAttribute("placeholder")).toBe(
      "What should the factory build?",
    );
    const path = field(el, "path");
    expect(path.required).toBe(true);
    expect(path.getAttribute("placeholder")).toBe("so/my-repo");
    const options = [...field(el, "approvals").options].map((o) => o.value);
    expect(options).toEqual(["manual", "auto"]);
    expect(el.querySelector(".create-actions button")?.textContent).toBe(
      "Open scope",
    );
  });

  it("defaults approvals to manual", async () => {
    const el = makeCreate();
    await el.updateComplete;
    expect(field(el, "approvals").value).toBe("manual");
  });
});

describe("scope-create submit", () => {
  it("emits colony-create-scope with the shell's payload shape", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    await fill(el);
    submit(el);
    expect(seen).toEqual([
      [
        "colony-create-scope",
        {
          goal: "Build the thing",
          title: "Ship it",
          project: "My project",
          repo: { path: "so/colony" },
          approvals: "manual",
        },
      ],
    ]);
  });

  it("omits an empty title and falls back to auto approvals", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    await fill(el, { title: "" });
    field(el, "approvals").value = "auto";
    field(el, "approvals").dispatchEvent(
      new window.Event("change", { bubbles: true }),
    );
    await el.updateComplete;
    submit(el);
    expect(seen).toEqual([
      [
        "colony-create-scope",
        {
          goal: "Build the thing",
          project: "My project",
          repo: { path: "so/colony" },
          approvals: "auto",
        },
      ],
    ]);
  });

  it("sends an empty-string project when the field is left blank", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    await fill(el, { project: "" });
    submit(el);
    expect(seen[0][1].project).toBe("");
  });

  it("refuses to submit without a goal or a repo path", async () => {
    const el = makeCreate();
    const seen = eventsOf(el);
    await el.updateComplete;
    await fill(el, { goal: "  " });
    submit(el);
    expect(seen).toEqual([]);
    await fill(el, { path: " " });
    submit(el);
    expect(seen).toEqual([]);
    // Both present (after trimming) and it goes through.
    await fill(el, { goal: "g", path: "so/colony" });
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

describe("scope-create drafts survive re-render (defect 2)", () => {
  it("typed values stay put across a poll-driven re-render", async () => {
    const el = makeCreate();
    await el.updateComplete;
    await fill(el);
    // A poll re-renders the view; nothing may be rewritten from the drafts.
    el.requestUpdate();
    await el.updateComplete;
    el.requestUpdate();
    await el.updateComplete;
    expect(field(el, "project").value).toBe("My project");
    expect(field(el, "title").value).toBe("Ship it");
    expect(field(el, "goal").value).toBe("Build the thing");
    expect(field(el, "path").value).toBe("so/colony");
  });

  it("the project draft is settable as a property and survives re-render", async () => {
    const el = makeCreate();
    await el.updateComplete;
    el._projectDraft = "my project";
    el.requestUpdate();
    await el.updateComplete;
    expect(field(el, "project").value).toBe("my project");
    el.requestUpdate();
    await el.updateComplete;
    expect(field(el, "project").value).toBe("my project");
  });

  it("a partially typed goal survives mid-typing re-renders", async () => {
    const el = makeCreate();
    await el.updateComplete;
    type(el, "goal", "half-typed");
    await el.updateComplete;
    // Poll fires between keystrokes.
    el.requestUpdate();
    await el.updateComplete;
    type(el, "goal", "half-typed goal");
    await el.updateComplete;
    expect(field(el, "goal").value).toBe("half-typed goal");
  });
});

describe("scope-create fixed project from the query", () => {
  it("renders the fixed project as a link, not an input", async () => {
    window.location.hash = "#/new?project=Operator%20console";
    const el = makeCreate();
    await el.updateComplete;
    expect(field(el, "project")).toBeNull();
    const fixed = el.querySelector(".composer-fixed a");
    expect(fixed?.textContent).toBe("Operator console");
    expect(fixed?.getAttribute("href")).toBe("#/project/Operator%20console");
  });

  it("seeds the project draft from ?project= and keeps it across re-render", async () => {
    window.location.hash = "#/new?project=Operator%20console";
    const el = makeCreate();
    await el.updateComplete;
    expect(el._projectDraft).toBe("Operator console");
    el.requestUpdate();
    await el.updateComplete;
    expect(el._projectDraft).toBe("Operator console");
  });

  it("seeding happens once, so later typing is never clobbered", async () => {
    window.location.hash = "#/new?project=Seeded";
    const el = makeCreate();
    await el.updateComplete;
    expect(el._projectDraft).toBe("Seeded");
    el._projectDraft = "changed by hand";
    el.requestUpdate();
    await el.updateComplete;
    expect(el._projectDraft).toBe("changed by hand");
  });
});
