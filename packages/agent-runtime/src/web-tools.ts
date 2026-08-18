import * as https from "node:https";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants & bounds
// ---------------------------------------------------------------------------

export const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
export const SEARCH_MAX_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_FETCH_MAX_BYTES = 200_000;
export const DEFAULT_MAX_RESULTS = 8;
export const DEFAULT_MAX_REDIRECTS = 5;

export const WEB_SEARCH_TOOL_NAME = "web_search" as const;
export const WEB_FETCH_TOOL_NAME = "web_fetch" as const;
export const WEB_TOOL_NAMES = [
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
] as const;

const MAX_SEARCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_TIMEOUT_MS = 60_000;
const MAX_FETCH_MAX_BYTES = 1_000_000;
const MAX_MAX_RESULTS = 20;
const MAX_MAX_REDIRECTS = 10;

// ---------------------------------------------------------------------------
// Address routability
// ---------------------------------------------------------------------------

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return null;
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function ipv6Bytes(address: string): Uint8Array | null {
  let addr = address.toLowerCase();
  let embedded: number[] | null = null;
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const dotted = addr.slice(lastColon + 1);
    const octs = dotted.split(".").map(Number);
    if (
      octs.length !== 4 ||
      octs.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
    )
      return null;
    embedded = octs;
    const h1 = ((octs[0] << 8) | octs[1]).toString(16);
    const h2 = ((octs[2] << 8) | octs[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${h1}:${h2}`;
  }
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  let left: string[] = [];
  let right: string[] = [];
  if (parts.length === 1) {
    left = parts[0] ? parts[0].split(":") : [];
    if (left.length === 1 && left[0] === "") left = [];
  } else {
    left = parts[0] ? parts[0].split(":") : [];
    right = parts[1] ? parts[1].split(":") : [];
    if (left.length === 1 && left[0] === "") left = [];
    if (right.length === 1 && right[0] === "") right = [];
  }
  const total = left.length + right.length;
  if (total > 8) return null;
  if (parts.length === 1 && total !== 8) return null;
  const missing = 8 - total;
  const hextets: number[] = [];
  for (const p of left) {
    if (p === "") return null;
    const v = parseInt(p, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    hextets.push(v);
  }
  for (let i = 0; i < missing; i++) hextets.push(0);
  for (const p of right) {
    if (p === "") return null;
    const v = parseInt(p, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    hextets.push(v);
  }
  if (hextets.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (hextets[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = hextets[i] & 0xff;
  }
  if (embedded) {
    bytes[12] = embedded[0];
    bytes[13] = embedded[1];
    bytes[14] = embedded[2];
    bytes[15] = embedded[3];
  }
  return bytes;
}

export function isRoutableAddress(address: string): boolean {
  const fam = net.isIP(address);
  if (fam === 4) {
    const octs = parseIpv4(address);
    if (!octs) return false;
    const [a, b, c] = octs as [number, number, number, number];

    // 0.0.0.0/8
    if (a === 0) return false;
    // 10/8
    if (a === 10) return false;
    // 100.64/10 CGNAT 100.64-127
    if (a === 100 && b >= 64 && b <= 127) return false;
    // 127/8
    if (a === 127) return false;
    // 169.254/16
    if (a === 169 && b === 254) return false;
    // 172.16/12 172.16-31
    if (a === 172 && b >= 16 && b <= 31) return false;
    // 192.0.0/24
    if (a === 192 && b === 0 && c === 0) return false;
    // 192.0.2/24 TEST-NET-1
    if (a === 192 && b === 0 && c === 2) return false;
    // 192.88.99/24 6to4 relay
    if (a === 192 && b === 88 && c === 99) return false;
    // 192.168/16
    if (a === 192 && b === 168) return false;
    // 198.18/15 benchmark 198.18-19
    if (a === 198 && (b === 18 || b === 19)) return false;
    // 198.51.100/24 TEST-NET-2
    if (a === 198 && b === 51 && c === 100) return false;
    // 203.0.113/24 TEST-NET-3
    if (a === 203 && b === 0 && c === 113) return false;
    // 224/4 multicast 224-239
    if (a >= 224 && a <= 239) return false;
    // 240/4 reserved 240-255 incl broadcast
    if (a >= 240 && a <= 255) return false;

    return true;
  }
  if (fam === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;

    // ::  unspecified
    let allZero = true;
    for (let i = 0; i < 16; i++)
      if (bytes[i] !== 0) {
        allZero = false;
        break;
      }
    if (allZero) return false;

    // ::1 loopback
    let isLoopback = true;
    for (let i = 0; i < 15; i++)
      if (bytes[i] !== 0) {
        isLoopback = false;
        break;
      }
    if (isLoopback && bytes[15] === 1) return false;

    // ::ffff:0:0/96  and 64:ff9b::/96  check embedded IPv4
    const isFfff =
      bytes[0] === 0 &&
      bytes[1] === 0 &&
      bytes[2] === 0 &&
      bytes[3] === 0 &&
      bytes[4] === 0 &&
      bytes[5] === 0 &&
      bytes[6] === 0 &&
      bytes[7] === 0 &&
      bytes[8] === 0 &&
      bytes[9] === 0 &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;
    if (isFfff) {
      const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      return isRoutableAddress(v4);
    }
    const isNat64 =
      bytes[0] === 0x00 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b &&
      bytes[4] === 0 &&
      bytes[5] === 0 &&
      bytes[6] === 0 &&
      bytes[7] === 0 &&
      bytes[8] === 0 &&
      bytes[9] === 0 &&
      bytes[10] === 0 &&
      bytes[11] === 0;
    if (isNat64) {
      const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      return isRoutableAddress(v4);
    }

    // 100::/64 discard
    if (
      bytes[0] === 0x01 &&
      bytes[1] === 0x00 &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x00 &&
      bytes[4] === 0x00 &&
      bytes[5] === 0x00 &&
      bytes[6] === 0x00 &&
      bytes[7] === 0x00
    )
      return false;

    // 2001:db8::/32 documentation
    if (
      bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8
    )
      return false;

    // fc00::/7 ULA
    if ((bytes[0] & 0xfe) === 0xfc) return false;

    // fe80::/10 link-local
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;

    // ff00::/8 multicast
    if (bytes[0] === 0xff) return false;

    // global unicast 2000::/3  (001)
    if ((bytes[0] & 0xe0) !== 0x20) return false;

    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolver / Transport
// ---------------------------------------------------------------------------

export type AddressResolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>;

export interface HttpTransportRequest {
  url: URL;
  timeoutMs: number;
  maxBytes: number;
  guard: "strict" | "trusted";
}

export interface HttpTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export type HttpTransport = (
  req: HttpTransportRequest,
) => Promise<HttpTransportResponse>;

export interface WebToolsDeps {
  resolver?: AddressResolver;
  transport?: HttpTransport;
}

export interface WebToolsConfig {
  searxngUrl?: string;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
  fetchMaxBytes?: number;
  maxResults?: number;
  maxRedirects?: number;
  resolver?: AddressResolver;
  transport?: HttpTransport;
  deps?: WebToolsDeps;
}

function defaultResolver(
  hostname: string,
): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  return dns.lookup(hostname, { all: true }) as Promise<
    ReadonlyArray<{ address: string; family: 4 | 6 }>
  >;
}

function clamp(
  value: number | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return def;
  const n = Math.floor(value);
  return Math.min(max, Math.max(min, n));
}

export function createPinnedLookup(
  resolver: AddressResolver = defaultResolver,
): (
  hostname: string,
  options: unknown,
  callback: (
    err: Error | null,
    address?: string | ReadonlyArray<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void {
  return (
    hostname: string,
    options: unknown,
    callback: (
      err: Error | null,
      address?: string | ReadonlyArray<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    let opts: { all?: boolean; family?: number } = {};
    let cb: typeof callback | undefined;
    if (typeof options === "function") {
      cb = options as typeof callback;
      opts = {};
    } else {
      opts = (options as { all?: boolean; family?: number }) ?? {};
      cb = callback;
    }
    if (!cb) return;
    const all = opts.all === true;
    const familyOpt = opts.family as 4 | 6 | undefined;
    resolver(hostname)
      .then((results) => {
        let filtered = results.filter((r) => isRoutableAddress(r.address));
        if (familyOpt === 4 || familyOpt === 6) {
          filtered = filtered.filter((r) => r.family === familyOpt);
        }
        if (filtered.length === 0) {
          cb(
            new Error(
              "host resolves only to non-public addresses (SSRF guard)",
            ),
          );
          return;
        }
        if (all) {
          cb(
            null,
            filtered.map((r) => ({
              address: r.address,
              family: r.family,
            })),
          );
        } else {
          const first = filtered[0]!;
          cb(null, first.address, first.family);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        cb(new Error(msg));
      });
  };
}

export const pinnedLookup = createPinnedLookup();

export function createNodeHttpsTransport(
  resolver: AddressResolver = defaultResolver,
): HttpTransport {
  const pinned = createPinnedLookup(resolver);
  return async ({
    url,
    timeoutMs,
    maxBytes,
    guard,
  }: HttpTransportRequest): Promise<HttpTransportResponse> => {
    if (url.protocol !== "https:") {
      throw new Error(
        `web_fetch blocked: unsupported protocol ${url.protocol} (SSRF guard)`,
      );
    }
    if (url.username || url.password) {
      throw new Error(
        "web_fetch blocked: URL contains credentials (SSRF guard)",
      );
    }
    if (guard === "strict") {
      const host = normalizedHostname(url);
      if (isBlockedHostname(host)) {
        throw new Error(
          "host resolves only to non-public addresses (SSRF guard)",
        );
      }
      const fam = net.isIP(host);
      if (fam !== 0) {
        if (!isRoutableAddress(host)) {
          throw new Error(
            "host resolves only to non-public addresses (SSRF guard)",
          );
        }
      }
    }

    const lookupOpt = guard === "strict" ? pinned : undefined;

    return await new Promise<HttpTransportResponse>((resolve, reject) => {
      let settled = false;
      let absoluteTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTimer = () => {
        if (absoluteTimer !== undefined) {
          clearTimeout(absoluteTimer);
          absoluteTimer = undefined;
        }
      };

      const req = https.request(
        url,
        {
          method: "GET",
          // @ts-expect-error lookup is accepted by Node's connect opts but not in our lib type
          lookup: lookupOpt,
          headers: {
            "User-Agent": "colony-agent/1.0",
            Accept: "*/*",
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
            else if (v !== undefined) headers[k.toLowerCase()] = String(v);
          }

          const chunks: Buffer[] = [];
          let storedBytes = 0;
          let truncated = false;

          res.on("data", (chunk: Buffer) => {
            const buf = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as unknown as string);
            if (truncated) return;
            if (storedBytes + buf.length > maxBytes) {
              const remaining = maxBytes - storedBytes;
              if (remaining > 0) chunks.push(buf.subarray(0, remaining));
              storedBytes = maxBytes;
              truncated = true;
              res.destroy();
            } else {
              chunks.push(buf);
              storedBytes += buf.length;
            }
          });

          res.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimer();
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              status,
              headers,
              body,
              truncated,
            });
          });

          res.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimer();
            reject(err);
          });

          res.on("close", () => {
            if (settled) return;
            if (truncated) {
              settled = true;
              clearTimer();
              const body = Buffer.concat(chunks).toString("utf8");
              resolve({
                status,
                headers,
                body,
                truncated,
              });
            }
          });
        },
      );

      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimer();
        reject(err);
      });

      // Absolute deadline — bounds total request time regardless of socket activity
      absoluteTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error(
          `timed out after ${timeoutMs}ms fetching ${url.toString()}`,
        );
        req.destroy(err);
        reject(err);
      }, timeoutMs);

      req.end();
    });
  };
}

export const defaultHttpTransport: HttpTransport = createNodeHttpsTransport();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const webSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(400),
  })
  .strict();

export const webFetchInputSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(
        (v) => {
          try {
            const u = new URL(v);
            return u.protocol === "https:";
          } catch {
            return false;
          }
        },
        { message: "url must be https://" },
      ),
  })
  .strict();

export const searxngResponseSchema = z
  .object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        content: z.string().optional(),
      }),
    ),
  })
  .passthrough();

export const webSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
    }),
  ),
  resultCount: z.number().int().nonnegative(),
});

export const webFetchOutputSchema = z.object({
  url: z.string().url(),
  status: z.number().int(),
  contentType: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  byteCount: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeSnippet(s: string, max = 120): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function boundMessage(msg: string, limit = 500): string {
  return msg.length > limit ? msg.slice(0, limit) : msg;
}

function normalizedHostname(url: URL): string {
  let h = url.hostname;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  return false;
}

function extractText(body: string, contentType: string): string {
  const raw = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (raw === "text/html" || raw === "application/xhtml+xml") {
    let t = body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
    t = t.replace(/<[^>]+>/g, "");
    t = t
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&nbsp;/gi, " ");
    t = t.replace(/\r\n/g, "\n");
    t = t.replace(/\n{3,}/g, "\n\n");
    return t;
  }
  if (raw.startsWith("text/") || raw === "application/json") {
    return body;
  }
  return body;
}

function makeZodPrepare<T>(schema: z.ZodType<T>): (args: unknown) => T {
  return (args: unknown) => {
    const parsed = schema.safeParse(args);
    if (parsed.success) return parsed.data;
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`,
    );
    throw new Error(`Envelope failed schema validation:\n${lines.join("\n")}`);
  };
}

function validateSearxngUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(
      `invalid searxngUrl: must be a valid URL (got ${sanitizeSnippet(raw)})`,
    );
  }
  if (u.protocol !== "https:") {
    throw new Error(`invalid searxngUrl: must be https:// (got ${u.protocol})`);
  }
  if (u.username || u.password) {
    throw new Error("invalid searxngUrl: must not contain credentials");
  }
  return u;
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  urlStr: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms fetching ${urlStr}`));
    }, timeoutMs);

    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs}ms fetching ${urlStr}`));
        return;
      }
      onAbort = () => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs}ms fetching ${urlStr}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createWebTools(config: WebToolsConfig): ToolDefinition[] {
  const rawUrl = config.searxngUrl?.trim() ?? "";
  if (!rawUrl) return [];

  const baseUrl = validateSearxngUrl(rawUrl);

  const resolver: AddressResolver | undefined =
    config.resolver ?? config.deps?.resolver;
  const injectedTransport: HttpTransport | undefined =
    config.transport ?? config.deps?.transport;

  const searchTimeoutMs = clamp(
    config.searchTimeoutMs,
    DEFAULT_SEARCH_TIMEOUT_MS,
    1,
    MAX_SEARCH_TIMEOUT_MS,
  );
  const fetchTimeoutMs = clamp(
    config.fetchTimeoutMs,
    DEFAULT_FETCH_TIMEOUT_MS,
    1,
    MAX_FETCH_TIMEOUT_MS,
  );
  const fetchMaxBytes = clamp(
    config.fetchMaxBytes,
    DEFAULT_FETCH_MAX_BYTES,
    1,
    MAX_FETCH_MAX_BYTES,
  );
  const maxResults = clamp(
    config.maxResults,
    DEFAULT_MAX_RESULTS,
    1,
    MAX_MAX_RESULTS,
  );
  const maxRedirects = clamp(
    config.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    0,
    MAX_MAX_REDIRECTS,
  );

  const transport: HttpTransport =
    injectedTransport ?? createNodeHttpsTransport(resolver ?? defaultResolver);

  const webSearchParams = Type.Object({
    query: Type.String({
      minLength: 1,
      maxLength: 400,
      description: "search query",
    }),
  });

  const webFetchParams = Type.Object({
    url: Type.String({ description: "https URL to fetch" }),
  });

  const searchPrepare = makeZodPrepare(webSearchInputSchema);
  const fetchPrepare = makeZodPrepare(webFetchInputSchema);

  const webSearchTool: ToolDefinition = {
    name: WEB_SEARCH_TOOL_NAME,
    label: "Web search",
    description:
      "Search the web via SearXNG. Input { query } 1-400 chars. Returns { query, results: [{title,url,content}], resultCount }.",
    parameters: webSearchParams,
    prepareArguments: searchPrepare as (args: unknown) => never,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: unknown,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      void toolCallId;
      const args = params as { query: string };
      const abortSignal = signal instanceof AbortSignal ? signal : undefined;
      const base = baseUrl.toString().replace(/\/+$/, "");
      const url = new URL(
        `${base}/search?q=${encodeURIComponent(args.query)}&format=json`,
      );

      let res: HttpTransportResponse;
      try {
        res = await withDeadline(
          transport({
            url,
            timeoutMs: searchTimeoutMs,
            maxBytes: SEARCH_MAX_BYTES,
            guard: "trusted",
          }),
          searchTimeoutMs,
          url.toString(),
          abortSignal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timed out after")) {
          throw new Error(boundMessage(`web_search failed: ${msg}`));
        }
        if (msg.includes("SSRF guard") || msg.includes("non-public")) {
          throw new Error(
            boundMessage(
              `web_search blocked: host resolves only to non-public addresses (SSRF guard)`,
            ),
          );
        }
        const snippet = sanitizeSnippet(msg);
        throw new Error(
          boundMessage(
            `web_search failed: ${snippet} fetching ${url.toString()}`,
          ),
        );
      }

      if (res.status < 200 || res.status >= 300) {
        const snippet = sanitizeSnippet(res.body);
        const baseMsg = `web_search failed: upstream HTTP ${res.status} from ${url.toString()}`;
        const withSnippet = snippet ? `${baseMsg} (${snippet})` : baseMsg;
        throw new Error(boundMessage(withSnippet));
      }

      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new Error(
          boundMessage(
            `web_search failed: SearXNG returned malformed JSON (HTTP ${res.status})`,
          ),
        );
      }

      const parsed = searxngResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          boundMessage(
            `web_search failed: SearXNG returned malformed JSON (HTTP ${res.status})`,
          ),
        );
      }

      const mapped = parsed.data.results.slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content ?? "",
      }));

      const output = {
        query: args.query,
        results: mapped,
        resultCount: mapped.length,
      };

      const validated = webSearchOutputSchema.parse(output);

      return {
        content: [{ type: "text", text: JSON.stringify(validated) }],
        details: validated,
      } as unknown as never;
    },
  } as unknown as ToolDefinition;

  const webFetchTool: ToolDefinition = {
    name: WEB_FETCH_TOOL_NAME,
    label: "Web fetch",
    description:
      "Fetch a https URL, follow up to 5 redirects, extract text, cap at 200k bytes. Input { url } must be https://.",
    parameters: webFetchParams,
    prepareArguments: fetchPrepare as (args: unknown) => never,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: unknown,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      void toolCallId;
      const args = params as { url: string };
      const abortSignal = signal instanceof AbortSignal ? signal : undefined;
      let currentUrl: URL;
      try {
        currentUrl = new URL(args.url);
      } catch {
        throw new Error(
          boundMessage(
            `web_fetch failed: invalid URL ${sanitizeSnippet(args.url)}`,
          ),
        );
      }

      if (currentUrl.protocol !== "https:") {
        throw new Error(
          boundMessage(
            `web_fetch failed: url must be https:// (got ${currentUrl.protocol})`,
          ),
        );
      }
      if (currentUrl.username || currentUrl.password) {
        throw new Error(
          boundMessage(
            `web_fetch blocked: URL contains credentials (SSRF guard)`,
          ),
        );
      }
      if (currentUrl.hash) {
        throw new Error(
          boundMessage(
            `web_fetch blocked: URL must not contain fragment (SSRF guard)`,
          ),
        );
      }
      const initialHost = normalizedHostname(currentUrl);
      if (isBlockedHostname(initialHost)) {
        throw new Error(
          boundMessage(
            `web_fetch blocked: host resolves only to non-public addresses (SSRF guard)`,
          ),
        );
      }
      const famInit = net.isIP(initialHost);
      if (famInit !== 0 && !isRoutableAddress(initialHost)) {
        throw new Error(
          boundMessage(
            `web_fetch blocked: host resolves only to non-public addresses (SSRF guard)`,
          ),
        );
      }

      let redirects = 0;
      let finalRes: HttpTransportResponse | null = null;
      let finalUrl = currentUrl;

      while (true) {
        let res: HttpTransportResponse;
        try {
          res = await withDeadline(
            transport({
              url: currentUrl,
              timeoutMs: fetchTimeoutMs,
              maxBytes: fetchMaxBytes,
              guard: "strict",
            }),
            fetchTimeoutMs,
            currentUrl.toString(),
            abortSignal,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("timed out after")) {
            throw new Error(boundMessage(`web_fetch failed: ${msg}`));
          }
          if (msg.includes("SSRF guard") || msg.includes("non-public")) {
            throw new Error(
              boundMessage(
                `web_fetch blocked: host resolves only to non-public addresses (SSRF guard)`,
              ),
            );
          }
          if (
            msg.includes("unsupported protocol") ||
            msg.includes("credentials")
          ) {
            throw new Error(
              boundMessage(
                `web_fetch blocked: ${sanitizeSnippet(msg)} (SSRF guard)`,
              ),
            );
          }
          const snippet = sanitizeSnippet(msg);
          throw new Error(
            boundMessage(
              `web_fetch failed: ${snippet} fetching ${currentUrl.toString()}`,
            ),
          );
        }

        const isRedirect =
          [301, 302, 303, 307, 308].includes(res.status) &&
          !!res.headers["location"];

        if (isRedirect) {
          if (redirects >= maxRedirects) {
            throw new Error(
              boundMessage(
                `web_fetch failed: too many redirects (${maxRedirects}) fetching ${currentUrl.toString()}`,
              ),
            );
          }
          const loc = res.headers["location"]!;
          let nextUrl: URL;
          try {
            nextUrl = new URL(loc, currentUrl);
          } catch {
            throw new Error(
              boundMessage(
                `web_fetch failed: invalid redirect location ${sanitizeSnippet(loc)} from ${currentUrl.toString()}`,
              ),
            );
          }

          if (nextUrl.protocol !== "https:") {
            throw new Error(
              boundMessage(
                `web_fetch blocked: redirect to non-https URL ${nextUrl.toString()} (SSRF guard)`,
              ),
            );
          }
          if (nextUrl.username || nextUrl.password) {
            throw new Error(
              boundMessage(
                `web_fetch blocked: redirect URL contains credentials (SSRF guard)`,
              ),
            );
          }
          if (nextUrl.hash) {
            throw new Error(
              boundMessage(
                `web_fetch blocked: redirect URL must not contain fragment (SSRF guard)`,
              ),
            );
          }
          const host = normalizedHostname(nextUrl);
          if (isBlockedHostname(host)) {
            throw new Error(
              boundMessage(
                `web_fetch blocked: host resolves only to non-public addresses (SSRF guard)`,
              ),
            );
          }
          const fam = net.isIP(host);
          if (fam !== 0 && !isRoutableAddress(host)) {
            throw new Error(
              boundMessage(
                `web_fetch blocked: host resolves only to non-public addresses (SSRF guard)`,
              ),
            );
          }

          currentUrl = nextUrl;
          redirects += 1;
          continue;
        }

        if (res.status < 200 || res.status >= 300) {
          const snippet = sanitizeSnippet(res.body);
          const baseMsg = `web_fetch failed: upstream HTTP ${res.status} from ${currentUrl.toString()}`;
          const withSnippet = snippet ? `${baseMsg} (${snippet})` : baseMsg;
          throw new Error(boundMessage(withSnippet));
        }

        finalRes = res;
        finalUrl = currentUrl;
        break;
      }

      if (!finalRes) {
        throw new Error(
          boundMessage(
            `web_fetch failed: no response from ${currentUrl.toString()}`,
          ),
        );
      }

      const contentType = finalRes.headers["content-type"] ?? "";
      const extracted = extractText(finalRes.body, contentType);

      let byteCount: number;
      if (finalRes.truncated) {
        byteCount = fetchMaxBytes;
      } else {
        byteCount = Buffer.byteLength(finalRes.body, "utf8");
      }

      let content = extracted;
      const contentBytes = Buffer.byteLength(content, "utf8");
      let truncated = finalRes.truncated;
      if (contentBytes > fetchMaxBytes) {
        content = Buffer.from(content, "utf8")
          .subarray(0, fetchMaxBytes)
          .toString("utf8");
        truncated = true;
        byteCount = fetchMaxBytes;
      }

      const output = {
        url: finalUrl.toString(),
        status: finalRes.status,
        contentType,
        content,
        truncated,
        byteCount,
      };

      const validated = webFetchOutputSchema.parse(output);

      return {
        content: [{ type: "text", text: JSON.stringify(validated) }],
        details: validated,
      } as unknown as never;
    },
  } as unknown as ToolDefinition;

  return [webSearchTool, webFetchTool];
}
