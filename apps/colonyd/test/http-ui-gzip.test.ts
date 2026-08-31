import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp, uiGzipCache } from "../src/http.js";

const staticDir = dirname(
  createRequire(import.meta.url).resolve("@colony/console/package.json"),
);

function fakeCtx(): ColonydContext {
  return {
    store: new Store(join(tmpdir(), `colonyd-gzip-${Date.now()}`, "test.db")),
    provider: {} as ColonydContext["provider"],
    config: {
      reviewMode: "required",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    artifacts: createLocalArtifactStore(
      mkdtempSync(join(tmpdir(), "colonyd-artifacts-")),
    ),
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.home.shdr.ch",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 1,
      maxAttempts: 3,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
      traceUiBaseUrl: "",
    },
    draining: { isDraining: () => false },
    requestTick() {},
  };
}

function gzipApp(): ReturnType<typeof buildApp> {
  return buildApp(fakeCtx());
}

describe("UI gzip serving", () => {
  beforeAll(() => {
    uiGzipCache.clear();
  });

  it("serves gzipped js, css, html, and svg when the client advertises gzip", async () => {
    const app = gzipApp();
    for (const [route, file, type] of [
      ["/ui/app.js", "app.js", /javascript/],
      ["/ui/styles.css", "styles.css", /text\/css/],
      ["/", "index.html", /text\/html/],
      ["/ui/favicon.svg", "favicon.svg", /svg/],
    ] as const) {
      const res = await app.request(route, {
        headers: { "accept-encoding": "gzip" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(res.headers.get("vary")).toBe("accept-encoding");
      expect(res.headers.get("content-type")).toMatch(type);
      const body = Buffer.from(await res.arrayBuffer());
      expect(gunzipSync(body)).toEqual(readFileSync(join(staticDir, file)));
    }
  });

  it("serves raw bytes without gzip when Accept-Encoding is absent", async () => {
    const app = gzipApp();
    const res = await app.request("/ui/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(
      readFileSync(join(staticDir, "app.js")),
    );
  });

  it("never compresses .woff2", async () => {
    const app = gzipApp();
    const file = join(staticDir, "fonts", "big-shoulders-800.woff2");
    const res = await app.request("/ui/fonts/big-shoulders-800.woff2", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(readFileSync(file));
  });

  it("caches compressed buffers per absolute file path and reuses them", async () => {
    const app = gzipApp();
    const first = await app.request("/ui/pagination.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(first.headers.get("content-encoding")).toBe("gzip");
    const firstBytes = Buffer.from(await first.arrayBuffer());

    const cachedKey = [...uiGzipCache.keys()].find((k) =>
      k.endsWith("pagination.js"),
    );
    expect(cachedKey).toBeDefined();
    const entry = uiGzipCache.get(cachedKey!);
    expect(entry).toBeDefined();
    expect(entry!.compressed).toEqual(firstBytes);

    // Plant a marker: if the next response serves it, the body came from the
    // cache rather than a fresh gzipSync.
    const marker = Buffer.from("marker-cache-hit");
    uiGzipCache.set(cachedKey!, { ...entry!, compressed: marker });
    const second = await app.request("/ui/pagination.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(second.headers.get("content-encoding")).toBe("gzip");
    expect(Buffer.from(await second.arrayBuffer())).toEqual(marker);

    // Serving does not grow the cache for an already-compressed path.
    expect(
      [...uiGzipCache.keys()].filter((k) => k.endsWith("pagination.js")),
    ).toHaveLength(1);
  });

  it("recompresses when the file changes on disk", async () => {
    const app = gzipApp();
    const name = `gz-stale-${process.pid}-${Date.now()}.js`;
    const full = join(staticDir, name);
    const pad0 = "// padding 0".repeat(40);
    const firstContent = `export const v = 1; ${pad0}`;
    const pad1 = "/* changed */".repeat(60);
    const secondContent = `export const v = 22; ${pad1}`;
    // Different padding lengths guarantee statSync().size differs, so the
    // (mtimeMs, size) identity changes even with coarse mtime granularity.
    expect(secondContent.length).not.toBe(firstContent.length);
    writeFileSync(full, firstContent);
    try {
      const first = await app.request(`/ui/${name}`, {
        headers: { "accept-encoding": "gzip" },
      });
      expect(first.status).toBe(200);
      expect(first.headers.get("content-encoding")).toBe("gzip");
      const firstBytes = Buffer.from(await first.arrayBuffer());
      expect(gunzipSync(firstBytes)).toEqual(Buffer.from(firstContent));

      writeFileSync(full, secondContent);
      const second = await app.request(`/ui/${name}`, {
        headers: { "accept-encoding": "gzip" },
      });
      expect(second.status).toBe(200);
      expect(second.headers.get("content-encoding")).toBe("gzip");
      const secondBytes = Buffer.from(await second.arrayBuffer());
      expect(gunzipSync(secondBytes)).toEqual(Buffer.from(secondContent));
      expect(gunzipSync(secondBytes)).not.toEqual(gunzipSync(firstBytes));
    } finally {
      rmSync(full, { force: true });
      uiGzipCache.delete(full);
    }
  });
});
