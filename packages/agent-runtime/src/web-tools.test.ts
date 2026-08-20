import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as http from "node:http";
import {
  createWebTools,
  isRoutableAddress,
  createPinnedLookup,
  createNodeHttpsTransport,
  webFetchInputSchema,
  searxngResponseSchema,
} from "./web-tools.js";
import type { HttpTransport } from "./web-tools.js";

// helpers

async function callTool(
  tool: {
    execute: (...args: unknown[]) => Promise<unknown>;
  },
  rawArgs: unknown,
): Promise<{
  isError: boolean;
  content: { type: string; text: string }[];
  details?: unknown;
}> {
  let prepared: unknown = rawArgs;
  try {
    const res = (await tool.execute(
      "test-id",
      prepared,
      undefined,
      undefined,
      undefined,
    )) as {
      content: { type: string; text: string }[];
      details?: unknown;
    };
    // Tools now throw on error (agent loop converts to isError:true).
    // For direct invocations, map thrown errors to isError shape so tests
    // can assert on content regardless of calling path.
    return { isError: false, content: res.content, details: res.details };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}

async function callToolThrows(
  tool: {
    execute: (...args: unknown[]) => Promise<unknown>;
  },
  rawArgs: unknown,
): Promise<Error> {
  let prepared: unknown = rawArgs;
  try {
    await tool.execute("test-id", prepared, undefined, undefined, undefined);
    throw new Error("expected tool to throw");
  } catch (err) {
    if ((err as Error).message === "expected tool to throw") throw err;
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Web tools ignore the extension context; a stub keeps the SDK signature. */
const toolContext = {} as ExtensionContext;

describe("web-tools factory & registration", () => {
  it("returns [] when searxngUrl absent/empty", () => {
    expect(createWebTools({})).toEqual([]);
    expect(createWebTools({ searxngUrl: "" })).toEqual([]);
    expect(createWebTools({ searxngUrl: "   " })).toEqual([]);
  });

  it("throws on invalid searxngUrl", () => {
    expect(() => createWebTools({ searxngUrl: "http://example.com" })).toThrow(
      /https/,
    );
    expect(() =>
      createWebTools({ searxngUrl: "https://user:pass@example.com" }),
    ).toThrow(/credentials/);
    expect(() => createWebTools({ searxngUrl: "not-a-url" })).toThrow(
      /valid URL/,
    );
  });

  it("exposes only web_fetch - web_search is the SDK builtin", () => {
    const tools = createWebTools({ searxngUrl: "https://searx.example.com" });
    expect(tools.map((t) => t.name)).toEqual(["web_fetch"]);
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    expect(fetch.description).toBeTruthy();
    expect(fetch.parameters).toBeTruthy();
    expect(fetch.execute).toBeTypeOf("function");
  });
});

describe("input-bound rejections via Zod schemas", () => {
  it("rejects non-https URL via Zod", async () => {
    expect(() =>
      webFetchInputSchema.parse({ url: "http://example.com" }),
    ).toThrow();
    expect(() =>
      webFetchInputSchema.parse({ url: "ftp://example.com" }),
    ).toThrow();
    const tools = createWebTools({ searxngUrl: "https://searx.example.com" });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    await expect(
      fetch.execute(
        "t",
        { url: "http://example.com" },
        undefined,
        undefined,
        toolContext,
      ),
    ).rejects.toThrow();
  });
});

describe("successful fetch incl one redirect hop", () => {
  it("follows redirect and re-validates hop via transport", async () => {
    const seen: string[] = [];
    const handler = async ({ url }: { url: URL }) => {
      seen.push(url.toString());
      if (url.pathname === "/start") {
        return {
          status: 302,
          headers: { location: `https://example.com/final` },
          body: "",
          truncated: false,
        };
      }
      if (url.pathname === "/final") {
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "hello final",
          truncated: false,
        };
      }
      return { status: 404, headers: {}, body: "not", truncated: false };
    };
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
      fetchMaxBytes: 5000,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/start",
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.url).toBe("https://example.com/final");
    expect(data.content).toBe("hello final");
    expect(seen).toEqual([
      "https://example.com/start",
      "https://example.com/final",
    ]);
  });

  it("follows relative redirect", async () => {
    const handler = async ({ url }: { url: URL }) => {
      if (url.pathname === "/a") {
        return {
          status: 301,
          headers: { location: "/b" },
          body: "",
          truncated: false,
        };
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "b body",
        truncated: false,
      };
    };
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/a",
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.url).toBe("https://example.com/b");
  });

  it("extracts html to text (script/style stripped, entities decoded)", async () => {
    const handler = async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: `<html><head><style>.x{}</style></head><body><script>alert(1)</script><p>Hello &amp; &lt;world&gt; &quot;test&quot; &#39; &#39; &nbsp; end</p><div>\n\n\n\n<p>next</p></div></body></html>`,
      truncated: false,
    });
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/",
    });
    const data = JSON.parse(res.content[0]!.text);
    expect(data.content).not.toContain("<script");
    expect(data.content).not.toContain("<style");
    expect(data.content).not.toContain("<p>");
    expect(data.content).toContain("Hello & <world>");
    expect(data.content).not.toMatch(/\n{3,}/);
  });
});

describe("HTTP failure (404 and 502) for web_fetch", () => {
  it("web_fetch 404 and 502", async () => {
    for (const code of [404, 502]) {
      const handler = async () => ({
        status: code,
        headers: {},
        body: "fetch upstr error " + "y".repeat(200),
        truncated: false,
      });
      const tools = createWebTools({
        searxngUrl: "https://searx.example.com",
        transport: handler as unknown as HttpTransport,
      });
      const fetch = tools.find((t) => t.name === "web_fetch")!;
      const res = await callTool(fetch as unknown as never, {
        url: "https://example.com/x",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(new RegExp(`upstream HTTP ${code}`));
      expect(res.content[0]!.text.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("timeout via injected never-resolving transport", () => {
  it("web_fetch timeout includes ms (genuinely never-resolving)", async () => {
    const never: HttpTransport = () => new Promise(() => {}) as Promise<any>;
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: never,
      fetchTimeoutMs: 15,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const err = await callToolThrows(fetch as unknown as never, {
      url: "https://example.com/x",
    });
    expect(err.message).toMatch(/timed out after 15ms/);
  });
});

describe("truncation", () => {
  it("body > fetchMaxBytes → truncated true, capped content, byte counts", async () => {
    const big = "a".repeat(500);
    const handler = async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: big,
      truncated: true,
    });
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
      fetchMaxBytes: 200,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/x",
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.truncated).toBe(true);
    expect(data.byteCount).toBe(200);
    expect(Buffer.byteLength(data.content, "utf8")).toBeLessThanOrEqual(200);
  });

  it("non-truncated body reports correct byteCount", async () => {
    const handler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
      truncated: false,
    });
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
      fetchMaxBytes: 200_000,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/x",
    });
    const data = JSON.parse(res.content[0]!.text);
    expect(data.truncated).toBe(false);
    expect(data.byteCount).toBe(
      Buffer.byteLength(JSON.stringify({ hello: "world" }), "utf8"),
    );
  });
});

describe("isRoutableAddress classification", () => {
  const rejectedV4 = [
    "0.0.0.1",
    "0.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.1.1",
    "169.254.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "192.168.255.255",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ];
  const rejectedV6 = [
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "100::1",
    "100::ffff",
    "2001:db8::1",
    "2001:db8:ffff::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "ff00::1",
  ];
  const accepted = [
    "8.8.8.8",
    "93.184.216.34",
    "1.1.1.1",
    "142.250.0.1",
    "2606:4700::1111",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81f::200e",
  ];

  for (const ip of rejectedV4) {
    it(`rejects v4 ${ip}`, () => {
      expect(isRoutableAddress(ip)).toBe(false);
    });
  }
  for (const ip of rejectedV6) {
    it(`rejects v6 ${ip}`, () => {
      expect(isRoutableAddress(ip)).toBe(false);
    });
  }
  for (const ip of accepted) {
    it(`accepts ${ip}`, () => {
      expect(isRoutableAddress(ip)).toBe(true);
    });
  }

  it("rejects non-global unicast v6 like ::ffff:0:0 with public embedded but other rejected ranges", () => {
    expect(isRoutableAddress("::ffff:192.168.1.1")).toBe(false);
  });
});

describe("pinnedLookup unit", () => {
  it("filters mixed results yielding only routable", async () => {
    const resolver = async () => [
      { address: "127.0.0.1", family: 4 as const },
      { address: "93.184.216.34", family: 4 as const },
    ];
    const lookup = createPinnedLookup(resolver);
    await new Promise<void>((resolve, reject) => {
      lookup("example.com", { all: true }, (err, addresses) => {
        try {
          expect(err).toBeNull();
          expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      lookup("example.com", {}, (err, address, family) => {
        try {
          expect(err).toBeNull();
          expect(address).toBe("93.184.216.34");
          expect(family).toBe(4);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("yields guard error when all private", async () => {
    const resolver = async () => [
      { address: "127.0.0.1", family: 4 as const },
      { address: "10.0.0.1", family: 4 as const },
    ];
    const lookup = createPinnedLookup(resolver);
    await new Promise<void>((resolve, reject) => {
      lookup("example.com", { all: true }, (err) => {
        try {
          expect(err).toBeInstanceOf(Error);
          expect(err!.message).toMatch(/SSRF guard/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("respects family filter", async () => {
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "2606:4700::1111", family: 6 as const },
    ];
    const lookup = createPinnedLookup(resolver);
    await new Promise<void>((resolve, reject) => {
      lookup("example.com", { family: 6, all: true }, (err, addresses) => {
        try {
          expect(err).toBeNull();
          expect(addresses).toEqual([
            { address: "2606:4700::1111", family: 6 },
          ]);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});

describe("redirect-SSRF: blocks before hop", () => {
  it("blocks redirect to localhost without calling transport for that hop", async () => {
    let calls = 0;
    const handler = async ({ url }: { url: URL }) => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 302,
          headers: { location: "https://localhost:9999/evil" },
          body: "",
          truncated: false,
        };
      }
      return { status: 200, headers: {}, body: "evil", truncated: false };
    };
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/start",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SSRF guard/);
    expect(calls).toBe(1);
  });

  it("blocks cross-scheme downgrade https->http", async () => {
    const handler = async () => ({
      status: 302,
      headers: { location: "http://example.com/downgrade" },
      body: "",
      truncated: false,
    });
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/start",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/non-https|SSRF guard/);
  });

  it("blocks credential-bearing redirect", async () => {
    const handler = async () => ({
      status: 302,
      headers: { location: "https://user:pass@example.com/" },
      body: "",
      truncated: false,
    });
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://example.com/start",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/credentials|SSRF guard/);
  });
});

describe("SSRF proofs through REAL default transport", () => {
  let server: http.Server;
  let port: number;
  let connections = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = server.address() as { port: number };
    port = addr.port;
    server.on("connection", () => {
      connections += 1;
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const blockedUrls = (p: number) => [
    `https://127.0.0.1:${p}/`,
    `https://[::1]:${p}/`,
    `https://10.0.0.9:${p}/x`,
    `https://192.168.1.9:${p}/x`,
    `https://169.254.169.254:${p}/x`,
    `https://[fc00::1]:${p}/x`,
  ];

  for (const maker of [blockedUrls]) {
    it(`blocks literal non-routable hosts with zero connections`, async () => {
      for (const url of maker(port)) {
        connections = 0;
        const tools = createWebTools({
          searxngUrl: "https://searx.example.com",
        });
        const fetch = tools.find((t) => t.name === "web_fetch")!;
        const f3 = fetch as unknown as {
          execute: (
            a: string,
            b: unknown,
          ) => Promise<{
            content: { type: string; text: string }[];
          }>;
        };
        let threw = false;
        let msg = "";
        try {
          await f3.execute("test-id", { url });
        } catch (err) {
          threw = true;
          msg = err instanceof Error ? err.message : String(err);
        }
        expect(threw).toBe(true);
        expect(msg).toMatch(/SSRF guard/);
        expect(connections).toBe(0);
      }
    });
  }

  it("blocks localhost hostname (needs DNS lookup) with zero connections", async () => {
    connections = 0;
    const tools = createWebTools({ searxngUrl: "https://searx.example.com" });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: `https://localhost:${port}/`,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SSRF guard/);
    expect(connections).toBe(0);
  });

  it("simulated rebinding: injected resolver returns loopback for normal hostname → blocked zero connections", async () => {
    const evilResolver = async () => [
      { address: "127.0.0.1", family: 4 as const },
    ];
    connections = 0;
    const transport = createNodeHttpsTransport(evilResolver);
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: `https://example.com:${port}/rebind`,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SSRF guard/);
    expect(connections).toBe(0);
  });

  it("private via resolver also blocked", async () => {
    const privResolver = async () => [
      { address: "10.1.2.3", family: 4 as const },
    ];
    connections = 0;
    const transport = createNodeHttpsTransport(privResolver);
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: `https://normal.example:${port}/`,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SSRF guard/);
    expect(connections).toBe(0);
  });
});

describe("web_fetch literal IP validation", () => {
  it("blocks literal private IP even with injected transport", async () => {
    let called = false;
    const handler: HttpTransport = async () => {
      called = true;
      return { status: 200, headers: {}, body: "ok", truncated: false };
    };
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const res = await callTool(fetch as unknown as never, {
      url: "https://192.168.1.1/secret",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SSRF guard/);
    expect(called).toBe(false);
  });

  it("blocks http scheme immediately", async () => {
    const handler = async () => ({
      status: 200,
      headers: {},
      body: "ok",
      truncated: false,
    });
    const tools = createWebTools({
      searxngUrl: "https://searx.example.com",
      transport: handler as unknown as HttpTransport,
    });
    const fetch = tools.find((t) => t.name === "web_fetch")!;
    const f = fetch as unknown as {
      execute: (
        a: string,
        b: unknown,
      ) => Promise<{
        content: { type: string; text: string }[];
      }>;
    };
    let threw = false;
    let msg = "";
    try {
      await f.execute("test-id", { url: "http://example.com/" });
    } catch (err) {
      threw = true;
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toBe(true);
    expect(msg).toMatch(/https/);
  });
});
