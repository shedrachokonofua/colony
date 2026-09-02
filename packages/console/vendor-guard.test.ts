import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

/**
 * CI guard for the no-build console: every .js under packages/console
 * outside vendor/ must stay plain browser-runnable JavaScript. Decorators
 * would need a build step, and a bare import specifier the import map in
 * index.html does not cover would 404 in the browser. Adding either turns
 * this red before CI ships a console that cannot load.
 */
const consoleDir = resolve(dirname(fileURLToPath(import.meta.url)));

const DECORATORS = ["@customElement", "@property", "@state"].map(
  (d) => `${d}(`,
);

function walkJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name === "vendor") continue;
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...walkJsFiles(path));
    } else if (dirent.isFile() && dirent.name.endsWith(".js")) {
      out.push(path);
    }
  }
  return out;
}

/** Double- or single-quoted specifiers: console sources are hand-written. */
const SPECIFIER =
  /(?:^|[^\w$.])(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']|(?:^|[^\w$.])import\s*["']([^"']+)["']/g;

interface ImportMap {
  imports: Record<string, string>;
}

function readImportMap(): Record<string, string> {
  const html = readFileSync(join(consoleDir, "index.html"), "utf8");
  const match = html.match(
    /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/,
  );
  expect(match, "index.html must carry the console import map").toBeTruthy();
  const map = JSON.parse(match![1]) as ImportMap;
  expect(map.imports).toBeTypeOf("object");
  return map.imports;
}

/** Import-map lookup: exact key, else the longest trailing-slash prefix. */
function isMapped(spec: string, imports: Record<string, string>): boolean {
  if (spec in imports) return true;
  return Object.keys(imports).some(
    (key) => key.endsWith("/") && spec.startsWith(key),
  );
}

describe("console no-build guard", () => {
  it("scans the console .js files outside vendor/", () => {
    const files = walkJsFiles(consoleDir);
    expect(files).toContain(join(consoleDir, "main.js"));
    expect(files.some((f) => f.includes(`${consoleDir}/vendor/`))).toBe(false);
  });

  it("keeps decorators out of the no-build sources", () => {
    for (const file of walkJsFiles(consoleDir)) {
      const text = readFileSync(file, "utf8");
      for (const decorator of DECORATORS) {
        expect(
          text.includes(decorator),
          `${relative(consoleDir, file)} uses ${decorator}; the console is no-build`,
        ).toBe(false);
      }
    }
  });

  it("covers every non-relative import with the index.html import map", () => {
    const imports = readImportMap();
    let bare = 0;
    for (const file of walkJsFiles(consoleDir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(SPECIFIER)) {
        const spec = match[1] ?? match[2];
        if (!spec) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) continue;
        bare++;
        expect(
          isMapped(spec, imports),
          `${relative(consoleDir, file)}: bare "${spec}" is not in the import map`,
        ).toBe(true);
      }
    }
    expect(bare).toBeGreaterThan(0);
  });
});
