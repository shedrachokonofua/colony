#!/usr/bin/env bun
/**
 * Vendor lit's production ESM into packages/console/vendor/.
 *
 * The console is a no-build static site (see project conventions): no
 * bundler, no node_modules runtime resolution, no CDN. This script copies
 * the browser ESM builds of lit-html, lit-element, @lit/reactive-element
 * and @lit-labs/ssr-dom-shim from root node_modules into
 * packages/console/vendor/<package>/..., rewriting every specifier to a
 * vendored relative path (with .js), so a browser resolves the whole
 * closure from /ui/vendor/ alone — no import map, no bare-specifier 404s.
 *
 * Only production ESM is vendored: package roots and their real
 * subdirectories, excluding development/ (dev/SSR variants) and node/
 * (Node-SSR variants) subdirs plus .d.ts, .map and other non-JS files.
 * Entry points are seeded from a manifest, then files reached through
 * imports are pulled in transitively. A specifier that does not resolve
 * to a vendored production .js file fails the run, so a new lit
 * dependency breaks this run instead of silently 404ing in the browser.
 *
 * Idempotent: re-running refreshes the vendored package trees in place and
 * prunes stale files inside them from previous runs. The legacy pre-bundled
 * packages/console/vendor/lit-html.js (still what app.js imports; switching
 * the console onto these trees is a later task in this scope) and VENDOR.md
 * sit outside those trees and are never touched.
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

/** First path segment of every tree the script owns under vendor/. */
const VENDORED_ROOTS = ["lit-html", "lit-element", "@lit", "@lit-labs"];

/**
 * lit-html is copied per entry point: the console imports the production
 * aggregate `lit-html.js` (package main) plus directive-helpers.js, and
 * directives/ only as individually used. Anything else reachable through
 * imports is picked up transitively.
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

const VENDORED = new Set<string>(["lit-html", ...WHOLE_PACKAGES]);

function packageDir(pkg: string): string {
  return join(nodeModules, ...pkg.split("/"));
}

interface LitManifest {
  version?: string;
  module?: string;
  main?: string;
}

function readLitManifest(pkg: string): LitManifest {
  return JSON.parse(
    readFileSync(join(packageDir(pkg), "package.json"), "utf8"),
  ) as LitManifest;
}

function readPackageVersion(pkg: string): string {
  const version = readLitManifest(pkg).version;
  if (!version) throw new Error(`${pkg} has no version in package.json`);
  return version;
}

/** The browser ESM entry of a vendored package (`module`, falling back to `main`). */
function packageEsmMain(pkg: string): string {
  const { module, main } = readLitManifest(pkg);
  const entry = module ?? main;
  if (!entry || !entry.endsWith(".js")) {
    throw new Error(`${pkg} has no production .js ESM entry`);
  }
  return entry;
}

function isVendoredPath(path: string): boolean {
  return VENDORED_ROOTS.includes(path.split("/")[0]);
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
 * Extend `files` with everything reachable through imports of the copied
 * files, and return each file's text with its specifiers rewritten to
 * vendored relative paths, so the browser resolves the whole closure
 * inside the vendor tree with no import map. Fails the run when a
 * specifier does not resolve to a production .js of the vendored
 * packages: a browser cannot probe extensions or package.json mains, so
 * anything else would 404 at runtime.
 */
function importClosure(files: Set<string>): Map<string, string> {
  const queue = [...files];
  const rewritten = new Map<string, string>();
  while (queue.length > 0) {
    const src = queue.pop()!;
    const text = readFileSync(join(nodeModules, src), "utf8");
    for (const spec of importSpecifiers(text)) {
      const resolved = resolveSpecifier(spec, src);
      if (resolved === null) {
        throw new Error(
          `${src}: specifier "${spec}" does not resolve to a vendored production .js file`,
        );
      }
      if (files.has(resolved)) continue;
      files.add(resolved);
      queue.push(resolved);
    }
    rewritten.set(src, rewriteSpecifiers(text, src));
  }
  return rewritten;
}

/**
 * Resolve `spec` from the node_modules file `src` to its vendored path
 * (tree-relative, slash-separated), or null when it does not resolve to a
 * production .js inside the vendored trees: relative specifiers must hit
 * an existing .js (browsers do not probe extensions); bare specifiers
 * must name a vendored package — the package root maps to its ESM main,
 * `pkg/subpath` must hit an existing .js under the package root.
 */
function resolveSpecifier(spec: string, src: string): string | null {
  if (spec.startsWith(".")) {
    const resolved = relative(
      nodeModules,
      resolve(dirname(join(nodeModules, src)), spec),
    )
      .split(sep)
      .join("/");
    if (
      !isVendoredPath(resolved) ||
      !resolved.endsWith(".js") ||
      !existsSync(join(nodeModules, resolved))
    ) {
      return null;
    }
    return resolved;
  }
  const pkg = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
  if (!VENDORED.has(pkg)) return null;
  const target = pkg === spec ? `${pkg}/${packageEsmMain(pkg)}` : spec;
  return isVendoredPath(target) &&
    target.endsWith(".js") &&
    existsSync(join(nodeModules, target))
    ? target
    : null;
}

/**
 * Point every specifier at its vendored file: "./x.js", "../x.js",
 * "../@lit/reactive-element/reactive-element.js". Rewrites only inside the
 * matched import clauses, so string literals elsewhere survive.
 */
function rewriteSpecifiers(text: string, src: string): string {
  return text.replace(IMPORT_SPECIFIER, (clause, fromSpec, importSpec) => {
    const spec = fromSpec ?? importSpec;
    const target = resolveSpecifier(spec, src);
    if (target === null) {
      throw new Error(
        `${src}: specifier "${spec}" does not resolve to a vendored production .js file`,
      );
    }
    const rel = relative(dirname(`/${src}`), `/${target}`);
    return clause.replace(
      `"${spec}"`,
      () => `"${rel.startsWith(".") ? rel : `./${rel}`}"`,
    );
  });
}

function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function vendorReadme(versions: { pkg: string; version: string }[]): string {
  const lit = versions.find((v) => v.pkg === "lit")!;
  const rest = versions
    .filter((v) => v.pkg !== "lit")
    .sort((a, b) => a.pkg.localeCompare(b.pkg));
  return [
    "# Vendored UI dependencies",
    "",
    "`lit@" + lit.version + "` and its runtime packages, copied from root",
    "`node_modules` by `bun run vendor:ui` (scripts/vendor-ui.ts) so the",
    "no-build console can import lit from `/ui/vendor/` with no bundler, no",
    "CDN and no import map: every specifier inside the trees is rewritten to",
    "a vendored relative path.",
    "",
    "| Package | Version |",
    "| ------- | ------- |",
    `| lit | ${lit.version} |`,
    ...rest.map((v) => `| ${v.pkg} | ${v.version} |`),
    "",
    "Do not hand-edit; regenerate after changing lit versions in the root",
    "package.json:",
    "",
    "```",
    "bun run vendor:ui",
    "```",
    "",
    "The legacy pre-bundled `vendor/lit-html.js` that `app.js` imports is not",
    "part of these trees; switching the console onto them is a later task in",
    "this scope.",
    "",
  ].join("\n");
}

function main(): void {
  rmSync(join(vendorDir, "lit-html"), { recursive: true, force: true });
  for (const pkg of WHOLE_PACKAGES) {
    rmSync(join(vendorDir, ...pkg.split("/")), {
      recursive: true,
      force: true,
    });
  }

  const files = collectSourceFiles();
  const rewritten = importClosure(files);
  for (const src of [...rewritten.keys()].sort()) {
    const to = join(vendorDir, src);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, rewritten.get(src)!);
  }

  const versions = ["lit", ...WHOLE_PACKAGES].map((pkg) => ({
    pkg,
    version: readPackageVersion(pkg),
  }));
  const litVersion = versions.find((v) => v.pkg === "lit")!.version;
  writeFileSync(join(vendorDir, VENDOR_MD), vendorReadme(versions));

  console.log(
    `vendored ${rewritten.size} files (lit ${litVersion}) into packages/console/vendor/`,
  );
}

if (import.meta.main) main();
