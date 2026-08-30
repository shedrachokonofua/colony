// Unit tests for <colony-topbar> breadcrumbs, under happy-dom: the route
// must be read at connect (deep links) and re-read at render, from router.js
// — not from a divergent hand parse.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./elements/test-dom.js";

// Element suites share this window and registry (bun runs every suite in one
// process with one module cache); the shared window must be installed before
// topbar.js (and therefore base.js/lit) is imported.
sharedDom();
globalThis.location = { hash: "#/", search: "" };

await import("./topbar.js");

const realLocation = globalThis.location;

function withHash(hash) {
  globalThis.location = { ...realLocation, hash };
}

function makeTopbar() {
  return document.createElement("colony-topbar");
}

async function crumbsFor(hash, props = {}) {
  withHash(hash);
  const el = makeTopbar();
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  await el.updateComplete;
  return [...el.querySelectorAll(".crumbs a, .crumbs .crumb")].map((node) =>
    node.textContent.trim(),
  );
}

afterEach(() => {
  globalThis.location = realLocation;
  document.body.innerHTML = "";
});

describe("topbar breadcrumbs", () => {
  it("seeds the route on connect: a deep link renders its crumb with no hashchange", async () => {
    // connectedCallback never read the hash before, so the first paint of a
    // deep link showed no project crumb.
    const crumbs = await crumbsFor("#/project/Operator%20console");
    expect(crumbs).toEqual(["Projects", "Operator console"]);
  });

  it("renders the manage-files crumbs (project + files) from router.js", async () => {
    const crumbs = await crumbsFor("#/project/Acme/files");
    expect(crumbs).toEqual(["Projects", "Acme", "files"]);
  });

  it("renders the new-project crumb", async () => {
    const crumbs = await crumbsFor("#/new-project");
    expect(crumbs).toEqual(["Projects", "new project"]);
  });

  it("renders the scope-project crumb from the shell's detail", async () => {
    const crumbs = await crumbsFor("#/col-a1b2c3d4", {
      detail: { scope: { project_name: "Acme" } },
    });
    expect(crumbs).toEqual(["Projects", "Acme", "col-a1b2c3d4"]);
  });

  it("renders no scope crumb for paginated list routes", async () => {
    // The hand parse treated the "?page=2" query as a scope id.
    const crumbs = await crumbsFor("#/?page=2");
    expect(crumbs).toEqual(["Projects"]);
  });

  it("re-reads the route at render time, not only on hashchange", async () => {
    withHash("#/");
    const el = makeTopbar();
    document.body.append(el);
    await el.updateComplete;
    expect(el.querySelectorAll(".crumbs .crumb").length).toBe(0);
    // A lit render without a hashchange (e.g. an actor or detail prop
    // landing late) must still paint the current URL's crumbs.
    withHash("#/project/Acme");
    el.actor = "human:op-2";
    await el.updateComplete;
    const crumbs = [...el.querySelectorAll(".crumbs .crumb")].map((node) =>
      node.textContent.trim(),
    );
    expect(crumbs).toEqual(["Acme"]);
  });
});
