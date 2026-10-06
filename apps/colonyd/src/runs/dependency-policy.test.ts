import { describe, expect, it } from "bun:test";
import {
  reviewDependencyChanges,
  type ReadAtRef,
} from "./dependency-policy.js";

const REGISTRIES = [
  "https://registry.npmjs.org/",
  "https://gitlab.home.shdr.ch/api/v4/projects/46/packages/npm/",
];

function sides(files: {
  target?: Record<string, string>;
  head: Record<string, string>;
}): ReadAtRef {
  return async (side, path) =>
    (side === "target" ? files.target : files.head)?.[path] ?? null;
}

function manifest(fields: Record<string, unknown>): string {
  return JSON.stringify({ name: "app", ...fields });
}

async function review(
  files: { target?: Record<string, string>; head: Record<string, string> },
  registries: readonly string[] = REGISTRIES,
) {
  return reviewDependencyChanges({
    changedFiles: Object.keys(files.head),
    readAt: sides(files),
    registryUrls: registries,
  });
}

describe("reviewDependencyChanges manifests", () => {
  it.each([
    ["git URL", "git+https://github.com/a/b.git"],
    ["github: spec", "github:a/b"],
    ["GitHub shorthand", "a/b#main"],
    ["tarball from an unlisted host", "https://evil.example/pkg.tgz"],
    ["path outside the repository", "file:../../../elsewhere"],
  ])("rejects a %s", async (_, spec) => {
    const result = await review({
      target: { "apps/api/package.json": manifest({}) },
      head: {
        "apps/api/package.json": manifest({ dependencies: { x: spec } }),
      },
    });
    expect(result.violations).toEqual([
      expect.objectContaining({ file: "apps/api/package.json", package: "x" }),
    ]);
  });

  it.each([
    ["semver range", "^1.2.3"],
    ["dist-tag", "latest"],
    ["npm alias", "npm:other@^2.0.0"],
    ["workspace protocol", "workspace:*"],
    ["path inside the repository", "file:../shared"],
    [
      "tarball from an allowed registry",
      "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
    ],
  ])("admits a %s and records the change", async (_, spec) => {
    const result = await review({
      target: { "apps/api/package.json": manifest({}) },
      head: {
        "apps/api/package.json": manifest({ devDependencies: { x: spec } }),
      },
    });
    expect(result.violations).toEqual([]);
    expect(result.changes).toEqual([
      {
        manifest: "apps/api/package.json",
        section: "devDependencies",
        name: "x",
        spec,
      },
    ]);
  });

  it("records a changed spec with its previous value and ignores unchanged ones", async () => {
    const result = await review({
      target: {
        "package.json": manifest({
          dependencies: { a: "^1.0.0", b: "^2.0.0" },
        }),
      },
      head: {
        "package.json": manifest({
          dependencies: { a: "^1.1.0", b: "^2.0.0" },
        }),
      },
    });
    expect(result.changes).toEqual([
      {
        manifest: "package.json",
        section: "dependencies",
        name: "a",
        spec: "^1.1.0",
        previous: "^1.0.0",
      },
    ]);
  });

  it("rejects a new trustedDependencies entry but not an existing one", async () => {
    const result = await review({
      target: {
        "package.json": manifest({ trustedDependencies: ["esbuild"] }),
      },
      head: {
        "package.json": manifest({ trustedDependencies: ["esbuild", "sharp"] }),
      },
    });
    expect(result.violations).toEqual([
      expect.objectContaining({ package: "sharp" }),
    ]);
  });
});

describe("reviewDependencyChanges lockfiles", () => {
  // bun.lock is JSON with trailing commas, exactly as bun writes it.
  function bunLock(packages: Record<string, string>): string {
    const rows = Object.entries(packages)
      .map(([key, row]) => `    "${key}": ${row},`)
      .join("\n");
    return `{\n  "lockfileVersion": 1,\n  "packages": {\n${rows}\n  },\n}\n`;
  }

  it("rejects a bun.lock package resolved from an unlisted registry", async () => {
    const result = await review({
      target: { "bun.lock": bunLock({}) },
      head: {
        "bun.lock": bunLock({
          evil: '["evil@1.0.0", "https://npm.evil.example/evil/-/evil-1.0.0.tgz", {}, "sha512-x"]',
        }),
      },
    });
    expect(result.violations).toEqual([
      expect.objectContaining({ file: "bun.lock", package: "evil" }),
    ]);
  });

  // The allowed registry is one project's path; the host serves every
  // project's registry, including the agent's own repository.
  it("rejects a package from another project's registry on an allowed host", async () => {
    const result = await review({
      target: { "bun.lock": bunLock({}) },
      head: {
        "bun.lock": bunLock({
          "@s30/pad":
            '["@s30/pad@1.0.0", "https://gitlab.home.shdr.ch/api/v4/projects/460/packages/npm/@s30/pad/-/@s30/pad-1.0.0.tgz", {}, "sha1-x"]',
        }),
        ".npmrc":
          "@s30:registry=https://gitlab.home.shdr.ch/api/v4/projects/41/packages/npm/\n",
      },
    });
    expect(result.violations).toEqual([
      expect.objectContaining({ file: "bun.lock", package: "@s30/pad" }),
      expect.objectContaining({ file: ".npmrc" }),
    ]);
  });

  it("admits default-registry and allowed private-registry bun.lock entries", async () => {
    const result = await review({
      target: { "bun.lock": bunLock({}) },
      head: {
        "bun.lock": bunLock({
          hono: '["hono@4.13.10", "", {}, "sha512-x"]',
          "@s30/palisade":
            '["@s30/palisade@0.5.0", "https://gitlab.home.shdr.ch/api/v4/projects/46/packages/npm/@s30/palisade/-/@s30/palisade-0.5.0.tgz", {}, "sha1-x"]',
          "brief-api": '["brief-api@workspace:apps/api"]',
        }),
      },
    });
    expect(result.violations).toEqual([]);
  });

  it("rejects a git resolution in bun.lock", async () => {
    const result = await review({
      head: {
        "bun.lock": bunLock({
          pad: '["pad@github:someone/pad#abc123", {}, "someone-pad-abc123"]',
        }),
      },
    });
    expect(result.violations).toEqual([
      expect.objectContaining({ package: "pad" }),
    ]);
  });

  it("rejects an unparseable bun.lock instead of trusting it", async () => {
    const result = await review({ head: { "bun.lock": "{ not json" } });
    expect(result.violations).toEqual([
      expect.objectContaining({ file: "bun.lock" }),
    ]);
  });

  it("rejects a package-lock.json entry resolved from an unlisted host", async () => {
    const lock = (resolved: string) =>
      JSON.stringify({
        packages: { "node_modules/x": { version: "1.0.0", resolved } },
      });
    const result = await review({
      target: { "package-lock.json": JSON.stringify({ packages: {} }) },
      head: {
        "package-lock.json": lock("https://npm.evil.example/x-1.0.0.tgz"),
      },
    });
    expect(result.violations).toEqual([
      expect.objectContaining({ package: "node_modules/x" }),
    ]);
  });
});

describe("reviewDependencyChanges registry configuration", () => {
  it("rejects an .npmrc that points a scope at a new unlisted host", async () => {
    const result = await review({
      target: {
        ".npmrc":
          "@s30:registry=https://gitlab.home.shdr.ch/api/v4/projects/46/packages/npm/\n",
      },
      head: {
        ".npmrc":
          "@s30:registry=https://gitlab.home.shdr.ch/api/v4/projects/46/packages/npm/\n@x:registry=https://npm.evil.example/\n",
      },
    });
    expect(result.violations).toEqual([
      expect.objectContaining({ file: ".npmrc" }),
    ]);
    expect(result.violations[0]!.detail).toContain("npm.evil.example");
  });

  it("admits a bunfig.toml registry on an allowed host", async () => {
    const result = await review({
      head: {
        "bunfig.toml":
          '[install.scopes]\n"@s30" = { url = "https://gitlab.home.shdr.ch/api/v4/projects/46/packages/npm/" }\n',
      },
    });
    expect(result.violations).toEqual([]);
  });
});
