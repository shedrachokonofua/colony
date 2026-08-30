// Unit tests for <project-list>, under happy-dom: the homepage project index
// renders one card per project with the monolith's fields, the empty and
// past-the-last-page states, and pagination/ navigation bubbling colony-page
// {page, surface:"projects"} / colony-navigate {href}.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "../elements/test-dom.js";

sharedDom();

await import("./project-list.js");

function project(name, overrides = {}) {
  return {
    name,
    scope_count: 2,
    file_count: 0,
    context_doc: null,
    repositories: [],
    status_counts: {},
    last_activity_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// The shell's projectsPage shape (colony-app.js), which is /projects'
// own {projects, total, ...} — not the generic {items, total} page.
function pageOf(projects, overrides = {}) {
  return {
    projects,
    total: projects.length,
    offset: 0,
    page: 1,
    ...overrides,
  };
}

function makeList(page = null, props = {}) {
  const el = document.createElement("project-list");
  el.projectsPage = page;
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  return el;
}

function pagerLink(el, label) {
  return [...el.querySelectorAll(".board-pager a")].find(
    (a) => a.textContent.trim() === label,
  );
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

describe("project-list structure", () => {
  it("renders the board head, one card per project, and the project's fields", async () => {
    const el = makeList(
      pageOf([
        project("Alpha", {
          scope_count: 1,
          context_doc: "# Brief",
          file_count: 3,
          status_counts: { active: 2, done: 1 },
          repositories: [{ repo_path: "so/alpha" }],
        }),
        project("Beta"),
      ]),
    );
    await el.updateComplete;
    expect(el.querySelector(".board-title")?.textContent).toBe("Projects");
    const cards = el.querySelectorAll(".project-card");
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute("href")).toBe("#/project/Alpha");
    expect(cards[0].querySelector(".project-card-name")?.textContent).toBe(
      "Alpha",
    );
    // "1 scope" renders as `1` + ` scope` (the plural suffix is its own
    // binding), so match the count and the singular separately.
    expect(cards[0].querySelector(".project-card-meta")?.textContent).toMatch(
      /1\s+scope(?!s)/,
    );
    expect(cards[1].querySelector(".project-card-meta")?.textContent).toMatch(
      /2\s+scopes/,
    );
    expect(cards[0].querySelector(".project-card-repos")?.textContent).toBe(
      "1 connected repo · so/alpha",
    );
    expect(cards[0].querySelector(".project-card-knowledge")?.textContent).toBe(
      "Brief · 3 reference files",
    );
    // status chips only for non-zero counts
    const kinds = [...cards[0].querySelectorAll(".chip")].map((c) =>
      c.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(["active", "done"]);
    expect(cards[1].querySelectorAll(".chip").length).toBe(0);
  });

  it("reads the shell's projects key, not a generic items page", async () => {
    // Regression: the view read page.items, which every producer of
    // projectsPage omits, so a real 30-project page rendered the
    // past-the-last-page state on the homepage.
    const el = makeList({
      projects: [project("Alpha")],
      total: 30,
      offset: 0,
      page: 1,
    });
    await el.updateComplete;
    expect(el.querySelectorAll(".project-card").length).toBe(1);
    expect(el.querySelector(".rack-empty")).toBeNull();
  });

  it("renders the empty state when the project total is zero", async () => {
    const el = makeList(pageOf([], { total: 0 }));
    await el.updateComplete;
    expect(el.querySelector(".rack-empty")?.textContent).toContain(
      "No projects yet",
    );
    expect(el.querySelector(".project-cards")).toBeNull();
  });

  it("renders the past-the-last-page state when a page arrives empty", async () => {
    const el = makeList(pageOf([], { total: 30, page: 4 }));
    const seen = eventsOf(el);
    await el.updateComplete;
    expect(el.querySelector(".rack-empty")?.textContent).toContain(
      "Past the last page.",
    );
    [...el.querySelectorAll(".rack-empty button")]
      .find((b) => b.textContent.includes("Back to page 1"))
      .click();
    expect(seen).toEqual([["colony-page", { page: 1, surface: "projects" }]]);
  });

  it("shows the error banner with role=alert", async () => {
    const el = makeList(pageOf([project("Alpha")]), { error: "boom" });
    await el.updateComplete;
    const banner = el.querySelector(".banner-error");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent?.trim()).toBe("boom");
  });
});

describe("project-list pagination", () => {
  it("hides the pager until the list spans more than one page", async () => {
    const el = makeList(pageOf([project("Alpha")]));
    await el.updateComplete;
    expect(el.querySelector(".board-pager")).toBeNull();

    const paged = makeList(pageOf([project("Alpha")], { total: 30, page: 2 }));
    await paged.updateComplete;
    expect(paged.querySelector(".board-pager")).toBeTruthy();
    expect(paged.querySelector(".pager-range")?.textContent).toBe(
      "26–26 of 30",
    );
  });

  it("Previous and Next bubble colony-page with the projects surface", async () => {
    const el = makeList(pageOf([project("Alpha")], { total: 100, page: 3 }));
    const seen = eventsOf(el);
    await el.updateComplete;
    pagerLink(el, "Previous").click();
    pagerLink(el, "Next").click();
    expect(seen).toEqual([
      ["colony-page", { page: 2, surface: "projects" }],
      ["colony-page", { page: 4, surface: "projects" }],
    ]);
  });

  it("clamps at the first and last page", async () => {
    const first = makeList(pageOf([project("Alpha")], { total: 30, page: 1 }));
    await first.updateComplete;
    // Page 1 drops the ?page= query, so Previous is a self-link.
    expect(pagerLink(first, "Previous").getAttribute("href")).toBe("#/");

    const last = makeList(pageOf([project("Alpha")], { total: 30, page: 2 }));
    await last.updateComplete;
    // 30 items over 25 gives two pages: Next from the last one is a no-op.
    expect(pagerLink(last, "Next").getAttribute("href")).toBe("#/?page=2");
    const seen = eventsOf(last);
    pagerLink(last, "Next").click();
    expect(seen).toEqual([["colony-page", { page: 2, surface: "projects" }]]);
  });

  it("carries the pager hrefs, so a reload lands on the same page", async () => {
    const el = makeList(pageOf([project("Alpha")], { total: 100, page: 3 }));
    await el.updateComplete;
    const hrefs = [...el.querySelectorAll(".board-pager a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["#/?page=2", "#/?page=4"]);
  });
});

describe("project-list navigation", () => {
  it("clicking a card bubbles colony-navigate with the project hash", async () => {
    const el = makeList(pageOf([project("My Project")]));
    const seen = eventsOf(el);
    await el.updateComplete;
    el.querySelector(".project-card").click();
    expect(seen).toEqual([
      ["colony-navigate", { href: "#/project/My%20Project" }],
    ]);
  });

  it("escapes a project name that needs encoding", async () => {
    const el = makeList(pageOf([project("a/b?c")]));
    await el.updateComplete;
    expect(el.querySelector(".project-card").getAttribute("href")).toBe(
      "#/project/a%2Fb%3Fc",
    );
  });
});
