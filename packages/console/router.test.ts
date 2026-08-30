import { afterEach, describe, expect, it } from "bun:test";
import {
  FILES_ROUTE,
  NEW_PROJECT_ROUTE,
  NEW_ROUTE,
  PROJECT_ROUTE,
  hashQueryProject,
  projectHref,
  routeIsManageFiles,
  routeIsNew,
  routeIsNewProject,
  routeProjectFilesName,
  routeProjectName,
  routeScopeId,
} from "./router.js";

const realLocation = globalThis.location;

/** location is a read-only global in bun: swap it wholesale, then restore. */
function withHash(hash: string) {
  Object.defineProperty(globalThis, "location", {
    value: { ...realLocation, hash },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "location", {
    value: realLocation,
    configurable: true,
    writable: true,
  });
});

describe("route regexes", () => {
  it("match their exact routes and reject lookalikes", () => {
    expect(PROJECT_ROUTE.test("project/Operator%20console")).toBe(true);
    expect(PROJECT_ROUTE.test("new")).toBe(false);
    expect(FILES_ROUTE.test("project/acme/files")).toBe(true);
    expect(FILES_ROUTE.test("project/acme/files?x=1")).toBe(true);
    expect(FILES_ROUTE.test("project/acme")).toBe(false);
    expect(NEW_ROUTE.test("new")).toBe(true);
    expect(NEW_ROUTE.test("new?project=acme")).toBe(true);
    expect(NEW_ROUTE.test("new-project")).toBe(false);
    expect(NEW_PROJECT_ROUTE.test("new-project")).toBe(true);
    expect(NEW_PROJECT_ROUTE.test("new-project?x=1")).toBe(true);
  });
});

describe("routeProjectName", () => {
  it("decodes the project segment", () => {
    withHash("#/project/Operator%20console");
    expect(routeProjectName()).toBe("Operator console");
  });

  it("returns null off the project route, ignoring query strings", () => {
    withHash("#/project/acme?page=2");
    expect(routeProjectName()).toBe("acme");
    withHash("#/");
    expect(routeProjectName()).toBeNull();
    withHash("#/new");
    expect(routeProjectName()).toBeNull();
  });
});

describe("routeProjectFilesName", () => {
  it("decodes the files route's project name", () => {
    withHash("#/project/My%20%26%20Co/files");
    expect(routeProjectFilesName()).toBe("My & Co");
  });

  it("returns null off the files route", () => {
    withHash("#/project/acme");
    expect(routeProjectFilesName()).toBeNull();
  });
});

describe("routeScopeId", () => {
  it("returns the bare scope hash", () => {
    withHash("#/col-a1b2c3d4");
    expect(routeScopeId()).toBe("col-a1b2c3d4");
  });

  it("returns null for the homepage, query-only, new, and project routes", () => {
    for (const hash of ["#", "#/", "#/?page=2", "#/new", "#/new-project", "#/project/acme"]) {
      withHash(hash);
      expect(routeScopeId()).toBeNull();
    }
  });
});

describe("routeIsNew / routeIsNewProject / routeIsManageFiles", () => {
  it("flags the exact routes, tolerating a query", () => {
    withHash("#/new");
    expect(routeIsNew()).toBe(true);
    withHash("#/new?project=acme");
    expect(routeIsNew()).toBe(true);
    withHash("#/new-project");
    expect(routeIsNewProject()).toBe(true);
    withHash("#/new");
    expect(routeIsNewProject()).toBe(false);
    withHash("#/project/acme/files");
    expect(routeIsManageFiles()).toBe(true);
    withHash("#/project/acme");
    expect(routeIsManageFiles()).toBe(false);
  });
});

describe("hashQueryProject", () => {
  it("reads ?project= from the hash query", () => {
    withHash("#/new?project=Fixed%20Project");
    expect(hashQueryProject()).toBe("Fixed Project");
  });

  it("returns null without a query or a project key", () => {
    withHash("#/");
    expect(hashQueryProject()).toBeNull();
    withHash("#/new?page=2");
    expect(hashQueryProject()).toBeNull();
  });
});

describe("projectHref", () => {
  it("encodes the name for href use", () => {
    expect(projectHref("Operator console")).toBe(
      "#/project/Operator%20console",
    );
    expect(projectHref("a&b/c")).toBe("#/project/a%26b%2Fc");
  });

  it("round-trips through routeProjectName", () => {
    withHash(projectHref("Operator console"));
    expect(routeProjectName()).toBe("Operator console");
  });
});
