import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "bun:test";

/**
 * Runs scripts/vendor-ui.ts for real and pins its output: the committed
 * vendor tree is what the no-build console serves, so a regeneration
 * must leave VENDOR.md carrying the lit version from the root
 * package.json and every entry file the console imports in place and
 * non-empty. A broken run or a half-written tree turns this red.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "packages", "console", "vendor");

const REQUIRED_FILES = [
  "lit-html/lit-html.js",
  "lit-html/directive.js",
  "lit-html/directive-helpers.js",
  "lit-html/directives/class-map.js",
  "lit-html/directives/repeat.js",
  "lit-html/directives/live.js",
  "lit-html/directives/keyed.js",
  "lit-html/directives/guard.js",
  "lit-html/directives/if-defined.js",
  "lit-html/directives/unsafe-html.js",
  "lit-element/lit-element.js",
  "@lit/reactive-element/reactive-element.js",
  "@lit-labs/ssr-dom-shim/index.js",
];

let litVersion = "";

beforeAll(() => {
  const run = spawnSync("bun", ["run", "vendor:ui"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(
    run.status,
    `bun run vendor:ui failed:\n${run.stderr ?? run.stdout}`,
  ).toBe(0);
  const root = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  litVersion = root.devDependencies?.lit ?? "";
  expect(litVersion, "lit must stay a root devDependency").not.toBe("");
});

describe("bun run vendor:ui output", () => {
  it("writes VENDOR.md with the vendored lit version", () => {
    const vendorMd = join(vendorDir, "VENDOR.md");
    expect(existsSync(vendorMd), "VENDOR.md is missing").toBe(true);
    expect(readFileSync(vendorMd, "utf8")).toContain(`lit@${litVersion}`);
  });

  it("leaves the key vendored files in place and non-empty", () => {
    for (const file of REQUIRED_FILES) {
      const path = join(vendorDir, file);
      expect(existsSync(path), `${file} is missing`).toBe(true);
      expect(statSync(path).size, `${file} is empty`).toBeGreaterThan(0);
    }
  });
});
