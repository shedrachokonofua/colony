import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

/**
 * Pins the output of `bun run vendor:ui` (scripts/vendor-ui.ts): the
 * committed vendor tree must load standalone in a no-build browser, so
 * every import specifier in every vendored file has to resolve to another
 * .js file inside the tree — a bare specifier or extensionless probe
 * would 404 at runtime. Deleting or regenerating the tree wrong turns
 * this red.
 */
const vendorDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "vendor",
);

const VENDORED_ROOTS = ["lit-html", "lit-element", "@lit", "@lit-labs"];

const REQUIRED_FILES = [
  "lit-html/lit-html.js",
  "lit-html/directives/repeat.js",
  "lit-html/directives/class-map.js",
  "lit-html/directives/live.js",
  "lit-html/directives/keyed.js",
  "lit-html/directives/guard.js",
  "lit-html/directives/if-defined.js",
  "lit-html/directives/unsafe-html.js",
  "lit-element/lit-element.js",
  "@lit/reactive-element/reactive-element.js",
];

/** Mirrors the specifier grammar of scripts/vendor-ui.ts. */
const SPECIFIER = /(?:import|export)\b[\s\S]*?\bfrom\s*"([^"]+)"|import\s*"([^"]+)"/g;

function walkJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      expect(dirent.name).not.toBe("development");
      expect(dirent.name).not.toBe("node");
      out.push(...walkJsFiles(path));
    } else if (dirent.isFile() && dirent.name.endsWith(".js")) {
      out.push(path);
    } else {
      expect(
        `${relative(vendorDir, path)}: only production .js is vendored`,
      ).toBe("");
    }
  }
  return out;
}

describe("vendored lit tree", () => {
  it("VENDOR.md records the lit version from root devDependencies", () => {
    const root = JSON.parse(
      readFileSync(resolve(vendorDir, "../../../package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const litVersion = root.devDependencies?.lit;
    expect(litVersion).toBeDefined();
    expect(readFileSync(join(vendorDir, "VENDOR.md"), "utf8")).toContain(
      `lit@${litVersion}`,
    );
  });

  it("contains the entry points the console and lit closure need", () => {
    for (const file of REQUIRED_FILES) {
      expect(existsSync(join(vendorDir, file)), file).toBe(true);
    }
  });

  it("holds only production .js plus VENDOR.md", () => {
    for (const root of VENDORED_ROOTS) {
      walkJsFiles(join(vendorDir, root));
    }
  });

  it("resolves every import specifier to a .js file inside the tree", () => {
    let checked = 0;
    for (const root of VENDORED_ROOTS) {
      for (const file of walkJsFiles(join(vendorDir, root))) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(SPECIFIER)) {
          const spec = match[1] ?? match[2];
          if (!spec) continue;
          checked++;
          expect(spec.startsWith("."), `${file}: bare "${spec}"`).toBe(true);
          const target = resolve(dirname(file), spec);
          expect(
            relative(vendorDir, target).startsWith(".."),
            `${file}: "${spec}" escapes the vendor tree`,
          ).toBe(false);
          expect(
            statSync(target).isFile() && target.endsWith(".js"),
            `${file}: "${spec}" does not resolve to a vendored .js`,
          ).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
