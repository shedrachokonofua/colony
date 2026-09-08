// The project failure census was a mis-aimed read: it counted faults on a
// project page nobody asked for. This is the deletion proof — per-file, so a
// stray match in an unrelated test file can never satisfy (or break) it. A
// repo-wide scan for the bare word "failures" would hit loop.integration and
// friends and prove nothing about the route.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

function read(relative: string): string {
  return readFileSync(join(REPO, relative), "utf8");
}

/** @param {string} source @param {string} needle */
function absent(source: string, needle: string) {
  return !source.includes(needle);
}

describe("project failure census removal", () => {
  it("drops the census from the console's project view", () => {
    const source = read("packages/console/views/project-page.js");
    expect(absent(source, "failureCensus")).toBe(true);
    expect(absent(source, "projectFailures")).toBe(true);
  });

  it("drops the census fetch from the shell's data layer", () => {
    const source = read("packages/console/shell-data.js");
    expect(absent(source, "failureCensus")).toBe(true);
    expect(absent(source, "projectFailures")).toBe(true);
  });

  it("drops the census property from the shell's view", () => {
    const source = read("packages/console/shell-view.js");
    expect(absent(source, "failureCensus")).toBe(true);
    expect(absent(source, "projectFailures")).toBe(true);
  });

  it("drops the census state from the shell element", () => {
    const source = read("packages/console/colony-app.js");
    expect(absent(source, "failureCensus")).toBe(true);
    expect(absent(source, "projectFailures")).toBe(true);
  });

  it("leaves no dead census CSS behind", () => {
    const source = read("packages/console/styles.css");
    expect(absent(source, ".project-census")).toBe(true);
    expect(absent(source, "census-")).toBe(true);
  });

  it("drops the /projects/:name/failures route", () => {
    const source = read("apps/colonyd/src/http.ts");
    expect(absent(source, "/failures")).toBe(true);
  });
});
