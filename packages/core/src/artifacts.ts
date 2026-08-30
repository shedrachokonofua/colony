import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type {
  ResolvedArtifactsConfig,
  S3ArtifactBackendConfig,
} from "@colony/config";

/**
 * Durable artifact storage for runs: two backends behind one interface.
 *
 * - local: bytes under `<dir>/<key>`; `ref` is the relative key path.
 * - s3:    path-style PUT/GET via `fetch` with an in-tree SigV4 signer
 *          (no AWS SDK); `ref` is `<endpoint>/<bucket>/<key>`.
 */

export interface ArtifactStore {
  put(
    key: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    meta: { contentType: string; sha256?: string },
  ): Promise<{ ref: string; bytes: number }>;
  get(ref: string): Promise<Uint8Array | undefined>;
  /** Plain HTTP URL for `ref`, when the backend exposes one. */
  getUrl(ref: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Key hygiene (shared by both backends)
// ---------------------------------------------------------------------------

/**
 * Artifact keys are relative paths under the backend root. Anything that
 * escapes it — absolute paths, drive letters, `..` segments, backslashes,
 * empty or trailing separators — is rejected rather than sanitized, so a
 * stored `ref` always names the same object the caller put.
 */
export function assertSafeArtifactKey(key: string): void {
  if (key.length === 0 || key.startsWith("/") || key.endsWith("/")) {
    throw new ArtifactKeyError(key);
  }
  if (isAbsolute(key) || /^[A-Za-z]:/.test(key)) {
    throw new ArtifactKeyError(key);
  }
  if (key.includes("\0")) throw new ArtifactKeyError(key);
  const parts = key.split(/[\\/]/);
  if (parts.some((p) => p.length === 0 || p === "." || p === "..")) {
    throw new ArtifactKeyError(key);
  }
}

/** A key that would escape the backend root; never a filesystem message. */
export class ArtifactKeyError extends Error {
  constructor(readonly key: string) {
    super(`artifact key escapes the store root: ${key}`);
    this.name = "ArtifactKeyError";
  }
}

/** Storage-layer failure (non-2xx S3 response, IO error) for a valid key. */
export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

// ---------------------------------------------------------------------------
// Local filesystem backend
// ---------------------------------------------------------------------------

/** Local backend: bytes at `<dir>/<key>`, `ref` is the relative key. */
export function createLocalArtifactStore(dir: string): ArtifactStore {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const underRoot = (relative: string): string => {
    const full = resolve(root, relative);
    // Defense in depth: assertSafeArtifactKey already rejected `..`;
    // a resolved path outside root still refuses to be read or written.
    if (full !== root && !full.startsWith(root + sep)) {
      throw new ArtifactKeyError(relative);
    }
    return full;
  };
  return {
    async put(key, data, meta) {
      assertSafeArtifactKey(key);
      const bytes = await toBytes(data);
      const full = underRoot(key);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
      void meta;
      return { ref: key, bytes: bytes.byteLength };
    },
    async get(ref) {
      assertSafeArtifactKey(ref);
      try {
        return new Uint8Array(readFileSync(underRoot(ref)));
      } catch (err: unknown) {
        if (isNotFoundFsError(err)) return undefined;
        throw err;
      }
    },
    getUrl() {
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// S3 backend (path-style, in-tree SigV4, no AWS SDK)
// ---------------------------------------------------------------------------

/**
 * S3 backend over `fetch` with SigV4. The signer (`sigv4Sign`) is pure and
 * fixture-testable; this store only assembles requests and reads responses.
 * `ref` is `<endpoint>/<bucket>/<key>` — the exact URL the object was PUT
 * to, so `get` can replay it byte-for-byte with fresh signatures.
 */
export function createS3ArtifactStore(
  cfg: S3ArtifactBackendConfig,
  fetchImpl: typeof fetch = fetch,
): ArtifactStore {
  const region = cfg.region ?? "us-east-1";
  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  const prefix = cfg.prefix ? `${cfg.prefix.replace(/\/+$/, "")}/` : "";
  const refFor = (key: string): string =>
    `${endpoint}/${cfg.bucket}/${encodeS3Key(prefix + key)}`;

  return {
    async put(key, data, meta) {
      assertSafeArtifactKey(key);
      const bytes = await toBytes(data);
      const payloadSha256 = meta.sha256 ?? sha256HexOf(bytes);
      const res = await signedFetch(
        fetchImpl,
        { url: refFor(key), method: "PUT", body: bytes },
        {
          accessKey: cfg.access_key_env,
          secretKey: cfg.secret_key_env,
          region,
          payloadSha256,
          extraHeaders: { "content-type": meta.contentType },
        },
      );
      if (!res.ok) {
        throw new ArtifactStoreError(`s3 put failed: ${res.status}`);
      }
      const header = res.headers.get("content-length");
      return {
        ref: refFor(key),
        bytes: header ? Number(header) : bytes.byteLength,
      };
    },
    async get(ref) {
      const res = await signedFetch(
        fetchImpl,
        { url: ref, method: "GET" },
        {
          accessKey: cfg.access_key_env,
          secretKey: cfg.secret_key_env,
          region,
          payloadSha256: EMPTY_SHA256,
        },
      );
      if (res.status === 404) return undefined;
      if (!res.ok) {
        throw new ArtifactStoreError(`s3 get failed: ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    getUrl(ref) {
      return ref.startsWith(`${endpoint}/${cfg.bucket}/`) ? ref : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

const ALGORITHM = "AWS4-HMAC-SHA256";

/** SHA256 of the empty payload, the GET-with-no-body constant. */
const EMPTY_SHA256 = sha256HexOf(new Uint8Array(0));

/** Lowercase hex sha256 of `data`. */
export function sha256HexOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * One SigV4 signing step, pure: the caller supplies the canonical pieces and
 * the exact `amzDate` (`YYYYMMDDTHHMMSSZ`); the result carries the canonical
 * request, the string-to-sign and the finished Authorization header, so
 * recorded vectors can assert every intermediate string.
 *
 * `headers` may carry `host` and `x-amz-content-sha256`; `host` is derived
 * from the URL when absent, and `x-amz-date`/`x-amz-content-sha256` are set
 * here — exactly these lowercase-sorted headers are signed.
 */
export function sigv4Sign(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  payloadSha256: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service: "s3";
  amzDate: string;
}): { canonicalRequest: string; stringToSign: string; authorization: string } {
  const url = new URL(input.url);

  // Dynamic header assembly: lowercase-name map, then sort for canonical
  // ordering. Values are trimmed per SigV4.
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    lower[name.toLowerCase()] = value.trim();
  }
  if (!("host" in lower)) {
    lower["host"] = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  }
  lower["x-amz-date"] = input.amzDate;
  lower["x-amz-content-sha256"] = input.payloadSha256;

  const names = Object.keys(lower).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${lower[name]}\n`)
    .join("");
  const signedHeaders = names.join(";");

  // Canonical URI: the pathname as the URL already encodes it (single
  // encoding, `%24` stays `%24`) — never re-encoded, per the S3 flavor.
  const canonicalRequest = [
    input.method,
    url.pathname,
    url.search.replace(/^\?/, ""),
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join("\n");

  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    input.amzDate,
    scope,
    sha256HexOf(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const kDate = hmac(`AWS4${input.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${input.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { canonicalRequest, stringToSign, authorization };
}

interface SignedRequest {
  url: string;
  method: string;
  body?: Uint8Array;
}

async function signedFetch(
  fetchImpl: typeof fetch,
  req: SignedRequest,
  opts: {
    accessKey: string;
    secretKey: string;
    region: string;
    payloadSha256: string;
    extraHeaders?: Record<string, string>;
  },
): Promise<Response> {
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const headers: Record<string, string> = {
    ...opts.extraHeaders,
    "x-amz-content-sha256": opts.payloadSha256,
  };
  const { authorization } = sigv4Sign({
    method: req.method,
    url: req.url,
    headers,
    payloadSha256: opts.payloadSha256,
    accessKey: opts.accessKey,
    secretKey: opts.secretKey,
    region: opts.region,
    service: "s3",
    amzDate,
  });
  // `host` signs but is never sent: fetch derives it from the URL, and it
  // is a forbidden header name on the client side anyway.
  const sent: Record<string, string> = { ...headers, authorization };
  delete sent["host"];
  return fetchImpl(req.url, {
    method: req.method,
    headers: sent,
    ...(req.body === undefined ? {} : { body: req.body }),
  });
}

// ---------------------------------------------------------------------------
// Factory + shared helpers
// ---------------------------------------------------------------------------

/** Build the store matching the resolved artifacts config. */
export function createArtifactStore(
  cfg: ResolvedArtifactsConfig,
): ArtifactStore {
  return cfg.kind === "s3"
    ? createS3ArtifactStore(cfg.s3)
    : createLocalArtifactStore(cfg.local.dir);
}

/**
 * S3 single-encoding of an object key: RFC3986 unreserved characters stay
 * bare, `/` separators survive verbatim. The same encoded form is used in
 * the request URL and therefore in the canonical request (the URL parser
 * keeps it as-is).
 */
export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

async function toBytes(
  data: Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  const chunks: Uint8Array[] = [];
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isNotFoundFsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
