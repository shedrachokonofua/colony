// Unit tests for <project-page>, under happy-dom: the crumbs, head, scope
// rack, pagination, the not-found state, and the settings rail carrying
// <project-context-card>.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "../elements/test-dom.js";

sharedDom();

await import("./project-page.js");
await import("../elements/project-context-card.js");

const PROJECT = {
  name: "Operator console",
  scope_count: 3,
  context_doc: "# Brief\n\nOperator-facing console.",
  repositories: [
    { repo_id: "1", repo_path: "so/colony" },
    { repo_id: "2", repo_path: "so/colony" },
  ],
  status_counts: { active: 2, done: 1, blocked: 0 },
  updated_at: "2026-01-01T00:00:00.000Z",
};

function scope(id, overrides = {}) {
  return {
    id,
    title: `Scope ${id}`,
    goal: "g",
    status: "active",
    provider_repo_path: "so/colony",
    project_name: null,
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function pageOf(overrides = {}) {
  return {
    name: PROJECT.name,
    project: PROJECT,
    scopes: [scope("col-a"), scope("col-b")],
    total: 2,
    offset: 0,
    page: 1,
    ...overrides,
  };
}

function makePage(page = pageOf(), props = {}) {
  const el = document.createElement("project-page");
  el.projectPage = page;
  el.config = { gitlab_base_url: "https://gitlab.example" };
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  return el;
}

function eventsOf(el) {
  const seen = [];
  for (const type of ["colony-page", "colony-navigate"]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("project-page head", () => {
  it("renders the crumbs, title, description, and scope count", async () => {
    const el = makePage();
    await el.updateComplete;
    const crumbs = el.querySelectorAll(".crumbs a");
    expect(crumbs[0]?.getAttribute("href")).toBe("#/");
    expect(el.querySelector(".crumbs .crumb")?.textContent).toBe(
      "Operator console",
    );
    expect(el.querySelector(".board-title")?.textContent).toBe(
      "Operator console",
    );
    expect(el.querySelector(".project-desc")?.textContent).toBe(
      "Operator-facing console.",
    );
    expect(el.querySelector(".project-meta")?.textContent).toMatch(
      /3\s+scopes\s+updated/,
    );
  });

  it("links New scope with the project fixed in the composer query", async () => {
    const el = makePage();
    await el.updateComplete;
    const link = el.querySelector(".board-head a.btn-solid");
    expect(link?.getAttribute("href")).toBe("#/new?project=Operator%20console");
    expect(link?.textContent.trim()).toBe("New scope");
  });

  it("renders only non-zero status chips", async () => {
    const el = makePage();
    await el.updateComplete;
    const chips = [...el.querySelectorAll(".project-counts .chip")];
    expect(chips.map((c) => c.getAttribute("data-kind"))).toEqual([
      "active",
      "done",
    ]);
    expect(chips[0]?.textContent).toBe("active 2");
  });

  it("shows the not-found state for an unknown project name", async () => {
    const el = makePage({ name: "Ghost", project: null });
    await el.updateComplete;
    expect(el.querySelector(".board-title")).toBeNull();
    expect(el.querySelector(".rack-empty")?.textContent).toContain(
      "No project named",
    );
    expect(el.textContent).toContain("Ghost");
  });

  it("renders nothing before a page arrives", async () => {
    const el = makePage(null);
    await el.updateComplete;
    expect(el.querySelector(".project-page")).toBeNull();
  });
});

describe("project-page scope rack", () => {
  it("renders one scope-card per scope with status and repo", async () => {
    const el = makePage();
    await el.updateComplete;
    const cards = el.querySelectorAll(".rack .scope-card");
    expect(cards.length).toBe(2);
    expect(cards[0].querySelector(".chip")?.getAttribute("data-kind")).toBe(
      "active",
    );
    expect(cards[0].querySelector(".scope-goal")?.textContent).toBe(
      "Scope col-a",
    );
    expect(cards[0].querySelector(".scope-meta .mono")?.textContent).toBe(
      "col-a",
    );
    expect(
      cards[0].querySelector(".scope-meta span:nth-child(2)")?.textContent,
    ).toBe("so/colony");
  });

  it("clicking a scope card bubbles colony-navigate to the scope sheet", async () => {
    const el = makePage();
    const seen = eventsOf(el);
    await el.updateComplete;
    el.querySelector(".scope-card").click();
    expect(seen).toEqual([["colony-navigate", { href: "#/col-a" }]]);
  });

  it("shows the empty note when the project has no scopes", async () => {
    const el = makePage(pageOf({ scopes: [], total: 0 }));
    await el.updateComplete;
    expect(el.querySelector(".rack")).toBeNull();
    expect(el.querySelector(".rack-empty")?.textContent).toContain(
      "No scopes in this project yet.",
    );
  });

  it("shows the past-the-last-page state with both escapes", async () => {
    const el = makePage(pageOf({ scopes: [], total: 30, page: 4 }));
    await el.updateComplete;
    const empty = el.querySelector(".rack-empty");
    expect(empty?.textContent).toContain("Past the last page.");
    const hrefs = [...empty.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["#/project/Operator%20console", "#/"]);
  });

  it("a project-scoped scope keeps its project link, whose click does not navigate", async () => {
    const el = makePage(
      pageOf({
        scopes: [scope("col-c", { project_name: "Operator console" })],
      }),
    );
    const seen = eventsOf(el);
    await el.updateComplete;
    const link = el.querySelector(".scope-project");
    expect(link?.getAttribute("href")).toBe("#/project/Operator%20console");
    link.click();
    // The row's own navigation must not fire from the nested project link.
    expect(seen).toEqual([]);
  });
});

describe("project-page pagination", () => {
  it("hides the pager within one page and bubbles colony-page past it", async () => {
    const el = makePage();
    await el.updateComplete;
    expect(el.querySelector(".pager")).toBeNull();

    const paged = makePage(pageOf({ total: 100, page: 3 }));
    const seen = eventsOf(paged);
    await paged.updateComplete;
    expect(paged.querySelector(".pager-range")?.textContent).toBe(
      "51–52 of 100",
    );
    const links = [...paged.querySelectorAll(".board-pager a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#/project/Operator%20console?page=2",
      "#/project/Operator%20console?page=4",
    ]);
    links[0].click();
    links[1].click();
    expect(seen).toEqual([
      ["colony-page", { page: 2, surface: "project" }],
      ["colony-page", { page: 4, surface: "project" }],
    ]);
  });
});

describe("project-page settings rail", () => {
  it("composes <project-context-card> and the deduped repo list", async () => {
    const el = makePage(pageOf({ scopes: [] }), {
      editing: true,
      settingsOpen: true,
      contextDoc: "# Brief\n\nOperator-facing console.",
    });
    await el.updateComplete;
    const card = el.querySelector("project-context-card");
    expect(card).toBeTruthy();
    expect(card.project.name).toBe("Operator console");
    expect(card.contextDoc).toBe("# Brief\n\nOperator-facing console.");
    expect(card.editing).toBe(true);
    expect(card.querySelector('textarea[name="project-context"]')).toBeTruthy();
    // The duplicate so/colony path is listed once.
    const repos = [...el.querySelectorAll(".repo-list li a")];
    expect(repos.length).toBe(1);
    expect(repos[0].getAttribute("href")).toBe(
      "https://gitlab.example/so/colony",
    );
  });

  it("hands the files and save status down to the card", async () => {
    const el = makePage(pageOf({ scopes: [] }), {
      settingsOpen: true,
      files: [
        { filename: "notes.md", media_type: "text/markdown", byte_size: 12 },
      ],
      saveStatus: "saved",
      editing: true,
    });
    await el.updateComplete;
    const card = el.querySelector("project-context-card");
    expect(card.files.length).toBe(1);
    expect(card.saveStatus).toBe("saved");
    expect(card.querySelector(".file-list li").textContent).toContain(
      "notes.md",
    );
    expect(card.querySelector(".pc-status.is-saved")).toBeTruthy();
  });
});

describe("project-page settings tab", () => {
  it("shows the scopes rack and hides the rail while the Scopes tab is active", async () => {
    const el = makePage(pageOf({ scopes: [scope("col-a")] }));
    await el.updateComplete;
    expect(el.settingsOpen).toBe(false);
    expect(el.querySelector(".project-scopes")).toBeTruthy();
    expect(el.querySelector(".project-settings")).toBeNull();
  });

  it("swaps to the rail on the Settings tab, hiding the scope rack", async () => {
    const el = makePage(pageOf({ scopes: [scope("col-a")] }), {
      settingsOpen: true,
    });
    await el.updateComplete;
    expect(el.querySelector(".project-scopes")).toBeNull();
    expect(el.querySelector(".project-settings")).toBeTruthy();
  });

  it("each tab bubbles the bare colony-toggle the shell's _toggle flips, and marks aria-selected", async () => {
    // _toggle(detail.key) flips a shell property by name: a {key, value}
    // pair would set projectTab to "settings", which no handler reads and
    // no render compares, so the Settings tab could never open.
    const el = makePage(pageOf({ scopes: [] }));
    const seen = [];
    el.addEventListener("colony-toggle", (event) => seen.push(event.detail));
    await el.updateComplete;
    const tabs = [...el.querySelectorAll(".tabs .tab")];
    expect(tabs.map((t) => t.textContent.trim())).toEqual([
      "Scopes",
      "Settings",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    tabs[1].click();
    tabs[0].click();
    expect(seen).toEqual([
      { key: "settingsOpen" },
      { key: "settingsOpen" },
    ]);
  });

  it("swaps the rack for the rail as settingsOpen flips", async () => {
    const el = makePage(pageOf({ scopes: [scope("col-a")] }));
    await el.updateComplete;
    expect(el.querySelector(".project-settings")).toBeNull();
    el.settingsOpen = true;
    await el.updateComplete;
    expect(el.querySelector(".project-settings")).toBeTruthy();
  });

  it("shows the empty repo note when none are connected", async () => {
    const el = makePage(
      pageOf({ project: { ...PROJECT, repositories: [] }, scopes: [] }),
      { settingsOpen: true },
    );
    await el.updateComplete;
    expect(el.querySelector(".repo-list")).toBeNull();
    expect(
      [...el.querySelectorAll(".card-body p.note")].some(
        (p) => p.textContent === "No connected repositories",
      ),
    ).toBe(true);
  });
});
