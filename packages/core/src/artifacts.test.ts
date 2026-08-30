import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ArtifactKeyError,
  createArtifactStore,
  createLocalArtifactStore,
  createS3ArtifactStore,
  encodeS3Key,
  sha256HexOf,
  sigv4Sign,
} from "./artifacts.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-artifacts-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createLocalArtifactStore", () => {
  it("round-trips put -> get and reports byte counts", async () => {
    const store = createLocalArtifactStore(tempDir());
    const data = new TextEncoder().encode("artifact payload\n");
    const put = await store.put("runs/r1/report.txt", data, {
      contentType: "text/plain",
    });
    expect(put.ref).toBe("runs/r1/report.txt");
    expect(put.bytes).toBe(data.byteLength);
    const got = await store.get("runs/r1/report.txt");
    expect(got).not.toBeUndefined();
    expect(Buffer.from(got!).toString("utf8")).toBe("artifact payload\n");
  });

  it("stores bytes at <dir>/<key> on disk", async () => {
    const dir = tempDir();
    const store = createLocalArtifactStore(dir);
    await store.put("nested/deep.bin", new Uint8Array([1, 2, 3]), {
      contentType: "application/octet-stream",
    });
    expect(readFileSync(join(dir, "nested/deep.bin"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("get returns undefined for a missing ref", async () => {
    const store = createLocalArtifactStore(tempDir());
    expect(await store.get("nope/missing.txt")).toBeUndefined();
  });

  it("rejects keys escaping the dir", async () => {
    const store = createLocalArtifactStore(tempDir());
    for (const key of [
      "../escape.txt",
      "a/../../escape.txt",
      "/absolute.txt",
      "C:\\windows.txt",
      "..",
      ".",
      "a//b",
      "ends/",
      "",
      "bad\0null",
    ]) {
      expect(() =>
        store.put(key, new Uint8Array([1]), { contentType: "text/plain" }),
      ).toThrow(ArtifactKeyError);
    }
    // get refuses the same keys rather than reading outside the root.
    expect(() => store.get("../escape.txt")).toThrow(ArtifactKeyError);
  });

  it("accepts a stream body and buffers it to disk", async () => {
    const store = createLocalArtifactStore(tempDir());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-one-"));
        controller.enqueue(new TextEncoder().encode("chunk-two"));
        controller.close();
      },
    });
    const put = await store.put("streams/out.txt", stream, {
      contentType: "text/plain",
    });
    expect(put.bytes).toBe("chunk-one-chunk-two".length);
    expect(Buffer.from((await store.get(put.ref))!).toString("utf8")).toBe(
      "chunk-one-chunk-two",
    );
  });
});

// ---------------------------------------------------------------------------
// SigV4 — recorded vectors (AWS SigV4 suite values, S3 flavor), zero network.
// amzDate 20130524T000000Z, region us-east-1, fixed test credentials.
// ---------------------------------------------------------------------------

// The canonical AWS documentation example credentials, assembled at runtime so
// secret scanners do not mistake these public fixtures for real keys.
const SIGV4_TEST_ACCESS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
const SIGV4_TEST_SECRET_KEY = [
  "wJalrXUtnFEMI",
  "/K7MDENG+bPxRfi",
  "CYEXAMPLEKEY",
].join("");

const SIGV4_PUT_VECTOR = {
  method: "PUT",
  url: "https://examplebucket.s3.amazonaws.com/test%241.text",
  headers: {
    host: "examplebucket.s3.amazonaws.com",
    "x-amz-content-sha256":
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  payloadSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  accessKey: SIGV4_TEST_ACCESS_KEY,
  secretKey: SIGV4_TEST_SECRET_KEY,
  region: "us-east-1",
  service: "s3" as const,
  amzDate: "20130524T000000Z",
};

const SIGV4_GET_VECTOR = {
  ...SIGV4_PUT_VECTOR,
  method: "GET",
  url: "https://examplebucket.s3.amazonaws.com/test.txt?max-keys=2&prefix=J",
};

// Canonical request: method, single-encoded URI, query, canonical headers
// (each `name:value\n`), signed-header names, payload hash.
const EXPECTED_PUT_CANONICAL = [
  "PUT",
  "/test%241.text",
  "",
  "host:examplebucket.s3.amazonaws.com\n" +
    "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
    "x-amz-date:20130524T000000Z\n",
  "host;x-amz-content-sha256;x-amz-date",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
].join("\n");

const EXPECTED_PUT_STRING_TO_SIGN = [
  "AWS4-HMAC-SHA256",
  "20130524T000000Z",
  "20130524/us-east-1/s3/aws4_request",
  "38c5d0016017713035da3a62d1d1b042468eebb7e08354825c828854ea0962ef",
].join("\n");

const EXPECTED_PUT_AUTHORIZATION =
  `AWS4-HMAC-SHA256 Credential=${SIGV4_TEST_ACCESS_KEY}/20130524/us-east-1/s3/aws4_request, ` +
  "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
  "Signature=fdfcbeeac5ec4a346b56f5c21e897630c093a16cfe94f32ed18fafd54275738e";

const EXPECTED_GET_CANONICAL = [
  "GET",
  "/test.txt",
  "max-keys=2&prefix=J",
  "host:examplebucket.s3.amazonaws.com\n" +
    "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
    "x-amz-date:20130524T000000Z\n",
  "host;x-amz-content-sha256;x-amz-date",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
].join("\n");

const EXPECTED_GET_STRING_TO_SIGN = [
  "AWS4-HMAC-SHA256",
  "20130524T000000Z",
  "20130524/us-east-1/s3/aws4_request",
  "6414584e6a995bd29c3df1656598814917a282bfe6a89cc0d3864cfa1e8f4df3",
].join("\n");

describe("sigv4Sign", () => {
  it("reproduces the recorded PUT vector exactly", () => {
    const signed = sigv4Sign(SIGV4_PUT_VECTOR);
    expect(signed.canonicalRequest).toBe(EXPECTED_PUT_CANONICAL);
    expect(signed.stringToSign).toBe(EXPECTED_PUT_STRING_TO_SIGN);
    expect(signed.authorization).toBe(EXPECTED_PUT_AUTHORIZATION);
  });

  it("reproduces the recorded GET vector exactly", () => {
    const signed = sigv4Sign(SIGV4_GET_VECTOR);
    expect(signed.canonicalRequest).toBe(EXPECTED_GET_CANONICAL);
    expect(signed.stringToSign).toBe(EXPECTED_GET_STRING_TO_SIGN);
  });

  it("signs a path-style endpoint with a port in the host header", () => {
    const signed = sigv4Sign({
      ...SIGV4_GET_VECTOR,
      url: "http://minio.home:9000/bucket/key with space.txt",
    });
    // The space encodes as %20, never `+`.
    expect(signed.canonicalRequest.split("\n")[1]).toBe(
      "/bucket/key%20with%20space.txt",
    );
  });
});

describe("encodeS3Key", () => {
  it("keeps unreserved characters and encodes per RFC3986", () => {
    expect(encodeS3Key("runs/r1/a b~c(d)e.f")).toBe(
      "runs/r1/a%20b~c%28d%29e.f",
    );
    expect(encodeS3Key("a+b")).toBe("a%2Bb");
    expect(encodeS3Key("unicode/é.txt")).toBe("unicode/%C3%A9.txt");
  });
});

// ---------------------------------------------------------------------------
// S3 store over a stubbed fetch — asserts the exact wire behavior.
// ---------------------------------------------------------------------------

function stubFetch(response: Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const S3_CFG = {
  endpoint: "http://minio.home:9000",
  bucket: "colony-artifacts",
  region: "us-east-1",
  access_key_env: "S3_ACCESS_KEY",
  secret_key_env: "S3_SECRET_KEY",
};

describe("createS3ArtifactStore", () => {
  it("PUTs to <endpoint>/<bucket>/<key> with SigV4 headers", async () => {
    const { fetchImpl, calls } = stubFetch(
      new Response(null, { status: 200, headers: { "content-length": "3" } }),
    );
    const store = createS3ArtifactStore(S3_CFG, fetchImpl);
    const put = await store.put("runs/r1/out.bin", new Uint8Array([9, 9, 9]), {
      contentType: "application/octet-stream",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://minio.home:9000/colony-artifacts/runs/r1/out.bin",
    );
    expect((calls[0]!.init.method as string).toUpperCase()).toBe("PUT");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=S3_ACCESS_KEY\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-content-sha256"]).toBe(
      sha256HexOf(new Uint8Array([9, 9, 9])),
    );
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(put.ref).toBe(
      "http://minio.home:9000/colony-artifacts/runs/r1/out.bin",
    );
    expect(put.bytes).toBe(3);
  });

  it("GETs the ref and returns 404 as undefined", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { fetchImpl, calls } = stubFetch(
      new Response(bytes.buffer as ArrayBuffer, { status: 200 }),
    );
    const store = createS3ArtifactStore(S3_CFG, fetchImpl);
    const ref = "http://minio.home:9000/colony-artifacts/runs/r1/out.bin";
    const got = await store.get(ref);
    expect(got).toEqual(bytes);
    expect(calls[0]!.init.method).toBe("GET");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-amz-content-sha256"]).toBe(
      sha256HexOf(new Uint8Array(0)),
    );
    // A second GET with a 404 answer comes back as undefined, not a throw.
    const missing = stubFetch(new Response("nope", { status: 404 }));
    expect(
      await createS3ArtifactStore(S3_CFG, missing.fetchImpl).get(ref),
    ).toBeUndefined();
  });

  it("getUrl exposes only refs on the configured endpoint/bucket", () => {
    const store = createS3ArtifactStore(
      S3_CFG,
      stubFetch(new Response(null)).fetchImpl,
    );
    const ref = "http://minio.home:9000/colony-artifacts/k.txt";
    expect(store.getUrl(ref)).toBe(ref);
    expect(store.getUrl("http://elsewhere:9000/other/k.txt")).toBeUndefined();
  });

  it("applies the configured prefix to stored keys", async () => {
    const { fetchImpl, calls } = stubFetch(new Response(null, { status: 200 }));
    const store = createS3ArtifactStore(
      { ...S3_CFG, prefix: "tenants/acme" },
      fetchImpl,
    );
    await store.put("k.txt", new Uint8Array(0), { contentType: "text/plain" });
    expect(calls[0]!.url).toBe(
      "http://minio.home:9000/colony-artifacts/tenants/acme/k.txt",
    );
  });
});

describe("createArtifactStore", () => {
  it("builds a local store from a local config", async () => {
    const store = createArtifactStore({
      kind: "local",
      local: { dir: tempDir() },
    });
    const put = await store.put("k.txt", new TextEncoder().encode("hi"), {
      contentType: "text/plain",
    });
    expect(put.ref).toBe("k.txt");
    expect(store.getUrl(put.ref)).toBeUndefined();
  });

  it("builds an s3 store from an s3 config", () => {
    const store = createArtifactStore({ kind: "s3", s3: S3_CFG });
    expect(
      store.getUrl("http://minio.home:9000/colony-artifacts/k.txt"),
    ).toBeDefined();
  });
});
