// Shell unit tests for <colony-app>, under happy-dom: route parsing, the
// 2.5s poll (document.hidden skip), and the hashchange reset handler.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./elements/test-dom.js";

// Element suites share this window and registry (bun runs every suite in one
// process with one module cache); the shared window must be installed before
// colony-app.js (and therefore base.js/lit/demo.js) is imported.
sharedDom();
// demo.js reads location.search at module top level; seed the global before
// the shell is imported.
globalThis.location = { hash: "#/", search: "?demo=1" };

const { ColonyApp } = await import("./colony-app.js");

const realLocation = globalThis.location;

/** Swap the location global wholesale (it is read-only in happy-dom too). */
function withHash(hash) {
  globalThis.location = { ...realLocation, hash };
}

/** Fresh detached shell: no connectedCallback, no timers, no listeners. */
function makeShell() {
  return document.createElement("colony-app");
}

afterEach(() => {
  globalThis.location = realLocation;
});

// -- Routing ---------------------------------------------------------------

describe("route parsing", () => {
  it("parses the project route with its decoded name", () => {
    withHash("#/project/Operator%20console");
    const app = makeShell();
    expect(app.currentRoute).toEqual({
      name: "project",
      params: { name: "Operator console" },
    });
  });

  it("parses the scope route from the bare hash", () => {
    withHash("#/col-a1b2c3d4");
    const app = makeShell();
    expect(app.currentRoute).toEqual({
      name: "scope",
      params: { id: "col-a1b2c3d4" },
    });
  });

  it("parses the new-scope route and its ?project= query", () => {
    withHash("#/new?project=acme");
    const app = makeShell();
    expect(app.currentRoute).toEqual({
      name: "newScope",
      params: { project: "acme" },
    });
  });

  it("parses the new-project and manage-files routes", () => {
    withHash("#/new-project");
    expect(makeShell().currentRoute).toEqual({
      name: "newProject",
      params: {},
    });
    withHash("#/project/My%20%26%20Co/files");
    expect(makeShell().currentRoute).toEqual({
      name: "files",
      params: { name: "My & Co" },
    });
  });

  it("falls back to the paginated list route", () => {
    withHash("#/");
    expect(makeShell().currentRoute).toEqual({
      name: "list",
      params: { page: 1 },
    });
    withHash("#/?page=3");
    expect(makeShell().currentRoute).toEqual({
      name: "list",
      params: { page: 3 },
    });
  });
});

// -- Poll ------------------------------------------------------------------

describe("poll", () => {
  it("starts a 2.5s interval on connect and stops on disconnect", async () => {
    const app = makeShell();
    document.body.append(app);
    await app.updateComplete;
    expect(app._pollTimer).toBeTruthy();
    const app2 = makeShell();
    document.body.append(app2);
    await app2.updateComplete;
    const timers = [app._pollTimer, app2._pollTimer];
    expect(timers[0]).not.toBe(timers[1]);
    app2.remove();
    await app2.updateComplete;
    expect(app2._pollTimer).toBeNull();
    app.remove();
    await app.updateComplete;
    expect(app._pollTimer).toBeNull();
  });

  it("skips the refresh while the document is hidden", async () => {
    const app = makeShell();
    document.body.append(app);
    await app.updateComplete;
    let refreshes = 0;
    app._refresh = () => {
      refreshes += 1;
    };
    const realHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      expect(refreshes).toBe(0);
    } finally {
      Object.defineProperty(document, "hidden", {
        value: realHidden ? realHidden.value : false,
        configurable: true,
      });
    }
  });

  it("fires the refresh on a visible tick", async () => {
    const app = makeShell();
    document.body.append(app);
    await app.updateComplete;
    let refreshes = 0;
    app._refresh = () => {
      refreshes += 1;
    };
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(refreshes).toBeGreaterThan(0);
  });
});

// -- hashchange ------------------------------------------------------------

// -- Pagination -------------------------------------------------------------

describe("pagination (_page)", () => {
  it("pages the projects list from the clean #/ base, not the current hash", () => {
    // Deep link straight onto page 2, then page forward: the old base was
    // location.hash, producing the unparseable #/?page=2?page=3.
    withHash("#/?page=2");
    const app = makeShell();
    app._page(3, "projects");
    expect(globalThis.location.hash).toBe("#/?page=3");
  });

  it("Previous from page 2 navigates back to the bare list hash", () => {
    // hrefForPage(base, 1) returns base itself, so the base must differ from
    // the paginated hash or _navigate no-ops and the pager sticks.
    withHash("#/?page=2");
    const app = makeShell();
    app._page(1, "projects");
    expect(globalThis.location.hash).toBe("#/");
  });

  it("pages a project sheet from its projectHref base", () => {
    withHash("#/project/My%20%26%20Co?page=1");
    const app = makeShell();
    app.currentRoute = { name: "project", params: { name: "My & Co" } };
    app._page(2, "project");
    expect(globalThis.location.hash).toBe("#/project/My%20%26%20Co?page=2");
  });

  it("pages the manage-files surface to its own route, not the list", () => {
    withHash("#/project/Acme/files");
    const app = makeShell();
    app.currentRoute = { name: "files", params: { name: "Acme" } };
    app._page(2, "files");
    expect(globalThis.location.hash).toBe("#/project/Acme/files?page=2");
  });

  it("clamps out-of-range page numbers to 1", () => {
    withHash("#/");
    const app = makeShell();
    app._page(0, "projects");
    expect(globalThis.location.hash).toBe("#/");
  });
});

// -- hashchange ------------------------------------------------------------

describe("hashchange handler", () => {
  it("resets transient surface state and re-parses the route", async () => {
    const app = makeShell();
    document.body.append(app);
    await app.updateComplete;
    withHash("#/col-a1b2c3d4");
    app.selectedTaskId = "t1";
    app.drawerOpen = true;
    app.runEvents = { runId: "r1", rows: [] };
    app.confirm = "delete";
    app.goalOpen = true;
    app.planOpen = true;
    app.briefOpen = true;
    app.projectContext = { doc: "x", status: null };
    app.projectPage = { name: "p" };
    app.projectsPage = { total: 1 };
    app.filesPage = { name: "p" };
    app.projectFiles = [];
    app.confirmFile = "f1";
    app.replaceFileId = "f1";
    app.newProjectDraft = { name: "p" };
    // _refresh in demo mode re-populates the paginated surfaces after the
    // reset; only the handler's own clearing is under test here.
    app._refresh = async () => {};
    window.dispatchEvent(new window.Event("hashchange"));
    await app.updateComplete;
    expect(app.currentRoute).toEqual({
      name: "scope",
      params: { id: "col-a1b2c3d4" },
    });
    expect(app.selectedTaskId).toBeNull();
    expect(app.drawerOpen).toBe(false);
    expect(app.runEvents).toBeNull();
    expect(app.confirm).toBeNull();
    expect(app.goalOpen).toBe(false);
    expect(app.planOpen).toBe(false);
    expect(app.briefOpen).toBe(false);
    expect(app.projectContext).toBeNull();
    expect(app.projectPage).toBeNull();
    expect(app.projectsPage).toBeNull();
    expect(app.filesPage).toBeNull();
    expect(app.projectFiles).toBeNull();
    expect(app.confirmFile).toBeNull();
    expect(app.replaceFileId).toBeNull();
    expect(app.newProjectDraft).toBeNull();
  });

  it("lazy-loads the view module for the new route", async () => {
    const app = makeShell();
    document.body.append(app);
    await app.updateComplete;
    // The list view is the first module; every later task registers its own.
    expect(app.viewModule?.route).toBe("list");
    withHash("#/new-project");
    window.dispatchEvent(new window.Event("hashchange"));
    await app.updateComplete;
    expect(app.viewModule?.route).toBe("newProject");
    expect(app.viewModule?.loading).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // project-create registers and resolves: the shell shows it.
    expect(app.viewModule).toEqual({ route: "newProject", loading: false });
  });
});
