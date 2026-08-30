#!/usr/bin/env bun
/**
 * Vendor lit's production ESM into packages/console/vendor/.
 *
 * The console is a no-build static site (see project conventions): no
 * bundler, no node_modules runtime resolution, no CDN. This script copies
 * the browser ESM builds of lit-html, lit-element, @lit/reactive-element
 * and @lit-labs/ssr-dom-shim from root node_modules into
 * packages/console/vendor/<package>/..., preserving the relative structure
 * so the browser resolves lit's relative imports and its bare package
 * imports (`lit-html`, `@lit/reactive-element/...`) inside the vendor tree.
 *
 * Only production ESM is vendored: package roots and their real
 * subdirectories, excluding development/ (dev/SSR variants) and node/
 * (Node-SSR variants) subdirs plus .d.ts, .map and other non-JS files.
 * Entry points are seeded from a manifest, then files reached through
 * relative imports are pulled in transitively; a bare import that escapes
 * the vendored set is a hard error, so a new internal lit dependency fails
 * this run instead of silently 404ing in the browser.
 *
 * Idempotent: re-running refreshes the vendored package trees in place and
 * prunes stale files inside them from previous runs. The legacy pre-bundled
 * packages/console/vendor/lit-html.js (still imported by app.js) and
 * VENDOR.md sit outside those trees and are never touched.
 *
 * Usage: bun run vendor:ui
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = join(repoRoot, "node_modules");
const vendorDir = join(repoRoot, "packages", "console", "vendor");

/** Packages copied in full (production ESM), keyed by vendored location. */
const WHOLE_PACKAGES = [
  "lit-element",
  "@lit/reactive-element",
  "@lit-labs/ssr-dom-shim",
] as const;

/**
 * lit-html is copied per entry point: the console imports the production
 * aggregate `lit-html.js` (package main) plus directive-helpers.js, and
 * directives/ only as individually used. Anything else reachable through
 * relative imports is picked up transitively by importClosure.
 */
const LIT_HTML_ENTRIES = [
  "lit-html.js",
  "directive.js",
  "directive-helpers.js",
  "directives/repeat.js",
  "directives/class-map.js",
  "directives/live.js",
  "directives/keyed.js",
  "directives/guard.js",
  "directives/if-defined.js",
  "directives/unsafe-html.js",
] as const;

const VENDOR_MD = "VENDOR.md";

/** Matches import/export ... from "x" and side-effect / dynamic import "x". */
const IMPORT_SPECIFIER =
  /(?:^|[^\w$.])(?:import|export)\b[\s\S]*?\bfrom\s*"([^"]+)"|import\s*"([^"]+)"/g;

function packageDir(pkg: string): string {
  return join(nodeModules, ...pkg.split("/"));
}

function readPackageVersion(pkg: string): string {
  const manifest = JSON.parse(
    readFileSync(join(packageDir(pkg), "package.json"), "utf8"),
  ) as { version?: string };
  if (!manifest.version)
    throw new Error(`${pkg} has no version in package.json`);
  return manifest.version;
}

/** Seed set: lit-html manifest entries + every production .js of whole packages. */
function collectSourceFiles(): Set<string> {
  const files = new Set<string>();
  for (const entry of LIT_HTML_ENTRIES) {
    if (!existsSync(join(nodeModules, "lit-html", entry))) {
      throw new Error(`lit-html entry point missing: ${entry}`);
    }
    files.add(`lit-html/${entry}`);
  }
  for (const pkg of WHOLE_PACKAGES) {
    for (const rel of walkJsFiles(packageDir(pkg))) {
      files.add(`${pkg}/${rel}`);
    }
  }
  return files;
}

function walkJsFiles(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      // development/ and node/ hold dev/Node-SSR builds of the same modules.
      if (dirent.name === "development" || dirent.name === "node") continue;
      out.push(...walkJsFiles(join(dir, dirent.name), root));
    } else if (dirent.isFile() && dirent.name.endsWith(".js")) {
      out.push(relative(root, join(dir, dirent.name)));
    }
  }
  return out;
}

/**
 * lit sources import siblings with relative specifiers (`../directive.js`)
 * and cross-package file specifiers (`@lit/reactive-element/decorators/...`).
 * Extend `files` with everything reachable through relative imports, then
 * fail if any bare specifier points outside the vendored packages.
 */
function importClosure(files: Set<string>): void {
  const queue = [...files];
  const bare = new Set<string>();
  while (queue.length > 0) {
    const src = queue.pop()!;
    for (const spec of importSpecifiers(
      readFileSync(join(nodeModules, src), "utf8"),
    )) {
      if (!spec.startsWith(".")) {
        bare.add(
          spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0],
        );
        continue;
      }
      const resolved = relative(
        nodeModules,
        resolve(dirname(join(nodeModules, src)), spec),
      )
        .split(sep)
        .join("/");
      if (files.has(resolved)) continue;
      if (
        !existsSync(join(nodeModules, resolved)) ||
        !resolved.endsWith(".js")
      ) {
        throw new Error(`imports missing file: ${spec}`);
      }
      files.add(resolved);
      queue.push(resolved);
    }
  }
  const unvendored = [...bare].filter(
    (pkg) =>
      pkg !== "lit-html" &&
      !WHOLE_PACKAGES.includes(pkg as (typeof WHOLE_PACKAGES)[number]),
  );
  if (unvendored.length > 0) {
    throw new Error(`imports unvendored packages: ${unvendored.join(", ")}`);
  }
}

function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

rmSync(join(vendorDir, "lit-html"), { recursive: true, force: true });
for (const pkg of WHOLE_PACKAGES) {
  rmSync(join(vendorDir, ...pkg.split("/")), { recursive: true, force: true });
}

const files = collectSourceFiles();
importClosure(files);
for (const src of [...files].sort()) {
  const to = join(vendorDir, src);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(join(nodeModules, src)));
}

const versions = ["lit", ...WHOLE_PACKAGES].map((pkg) => ({
  pkg,
  version: readPackageVersion(pkg),
}));
const litVersion = versions.find((v) => v.pkg === "lit")!.version;
writeFileSync(
  join(vendorDir, VENDOR_MD),
  [
    "# Vendored UI dependencies",
    "",
    "Production ESM builds copied from root `node_modules` by",
    "`bun run vendor:ui` (scripts/vendor-ui.ts) so the no-build console can",
    "import lit from `/ui/vendor/` with no bundler and no CDN. Do not edit;",
    "regenerate after changing lit versions in the root package.json:",
    "",
    "```",
    "bun run vendor:ui",
    "```",
    "",
    "| Package | Version |",
    "| ------- | ------- |",
    `| lit | ${litVersion} |`,
    ...versions
      .filter((v) => v.pkg !== "lit")
      .sort((a, b) => a.pkg.localeCompare(b.pkg))
      .map((v) => `| ${v.pkg} | ${v.version} |`),
    "",
  ].join("\n"),
);

console.log(
  `vendored ${files.size} files (lit ${litVersion}) into packages/console/vendor/`,
);
