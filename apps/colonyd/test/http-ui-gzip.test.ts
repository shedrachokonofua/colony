import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { Store } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp, uiGzipCache, type Env } from "../src/http.js";

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
    requestTick() {},
  };
}

function gzipApp(): Hono<Env> {
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
    expect(uiGzipCache.get(cachedKey!)).toEqual(firstBytes);

    // Plant a marker: if the next response serves it, the body came from the
    // cache rather than a fresh gzipSync.
    const marker = Buffer.from("marker-cache-hit");
    uiGzipCache.set(cachedKey!, marker);
    const second = await app.request("/ui/pagination.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(second.headers.get("content-encoding")).toBe("gzip");
    expect(Buffer.from(await second.arrayBuffer())).toEqual(marker);

    // Serving does not grow the cache for an already-compressed path.
    expect([...uiGzipCache.keys()].filter((k) => k.endsWith("pagination.js"))).toHaveLength(1);
  });
});
