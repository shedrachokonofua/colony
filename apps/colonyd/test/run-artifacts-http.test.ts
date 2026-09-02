import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  createLocalArtifactStore,
  createS3ArtifactStore,
  Store,
} from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Env = { Variables: { actor: string } };

interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  key: string;
  ref: string;
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  created_at: string;
}

interface ListEnvelope {
  items: ArtifactRow[];
  total: number;
  limit: number;
  offset: number;
}

function fakeCtx(
  store: Store,
  artifacts: ColonydContext["artifacts"],
): ColonydContext {
  return {
    store,
    provider: {} as ColonydContext["provider"],
    config: {
      reviewMode: "required",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    artifacts,
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
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => false },
    requestTick() {},
  };
}

const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };

function setup(artifacts?: ColonydContext["artifacts"]): {
  app: Hono<Env>;
  store: Store;
} {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-artifacts-http-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  const local =
    artifacts ?? createLocalArtifactStore(join(dir, "artifact-files"));
  return { app: buildApp(fakeCtx(store, local)), store };
}

function createRun(store: Store, goal: string): string {
  const scope = store.createScope({
    goal,
    provider_repo_id: "1",
    provider_repo_path: "so/colony",
  });
  return store.startRun({
    scope_id: scope.id,
    kind: "implement",
    lease_ttl_ms: 60_000,
  }).id;
}

describe("GET /runs/:id/artifacts", () => {
  it("lists a run's artifacts with the paginated envelope", async () => {
    const { app, store } = setup();
    const runId = createRun(store, "list artifacts");
    for (let i = 1; i <= 3; i++) {
      store.recordRunArtifact(runId, {
        kind: "log",
        key: `runs/${runId}/log-${i}.txt`,
        ref: `runs/${runId}/log-${i}.txt`,
        sha256: `hash${i}`,
        bytes: 10 * i,
        contentType: "text/plain",
      });
    }
    const res = await app.request(`/runs/${runId}/artifacts`, ACTOR);
    expect(res.status).toBe(200);
    const page = (await res.json()) as ListEnvelope;
    expect(page.total).toBe(3);
    expect(page.limit).toBe(200);
    expect(page.offset).toBe(0);
    expect(page.items).toHaveLength(3);
    expect(page.items[0]!.content_type).toBe("text/plain");
    // limit/offset params are honored.
    const window = await app.request(
      `/runs/${runId}/artifacts?limit=2&offset=1`,
      ACTOR,
    );
    expect(window.status).toBe(200);
    const win = (await window.json()) as ListEnvelope;
    expect(win.items).toHaveLength(2);
    expect(win.total).toBe(3);
    expect(win.offset).toBe(1);
  });

  it("404s for an unknown run and rejects bad limit", async () => {
    const { app, store } = setup();
    const missing = await app.request("/runs/nope/artifacts", ACTOR);
    expect(missing.status).toBe(404);
    // An existing run with an invalid query is a 400, not a 404.
    const runId = createRun(store, "bad query");
    const bad = await app.request(`/runs/${runId}/artifacts?limit=0`, ACTOR);
    expect(bad.status).toBe(400);
    const huge = await app.request(
      `/runs/${runId}/artifacts?limit=1001`,
      ACTOR,
    );
    expect(huge.status).toBe(400);
  });
});

describe("GET /runs/:id/artifacts/:artifact_id", () => {
  it("streams local bytes with the stored content type", async () => {
    const artifacts = createLocalArtifactStore(
      mkdtempSync(join(tmpdir(), "colonyd-artifacts-local-")),
    );
    const { app, store } = setup(artifacts);
    const runId = createRun(store, "download artifact");
    const payload = new TextEncoder().encode("artifact-bytes-123");
    const stored = await artifacts.put(`runs/${runId}/out.bin`, payload, {
      contentType: "application/x-binary",
    });
    const row = store.recordRunArtifact(runId, {
      kind: "report",
      key: `runs/${runId}/out.bin`,
      ref: stored.ref,
      sha256: "abc",
      bytes: stored.bytes,
      contentType: "application/x-binary",
    });

    const res = await app.request(`/runs/${runId}/artifacts/${row.id}`, ACTOR);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-binary");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
  });

  it("answers ARTIFACT_REMOTE JSON on the s3 backend without presigning", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      return new Response("should not be fetched", { status: 200 });
    }) as typeof fetch;
    const s3 = createS3ArtifactStore(
      {
        endpoint: "http://minio.home:9000",
        bucket: "colony",
        region: "us-east-1",
        access_key_env: "AK",
        secret_key_env: "SK",
      },
      fetchImpl,
    );
    const { app, store } = setup(s3);
    const runId = createRun(store, "remote artifact");
    const row = store.recordRunArtifact(runId, {
      kind: "report",
      key: "runs/r/out.bin",
      ref: "http://minio.home:9000/colony/runs/r/out.bin",
      contentType: "application/x-binary",
    });
    const res = await app.request(`/runs/${runId}/artifacts/${row.id}`, ACTOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: string; message: string; ref: string };
    };
    expect(body.error.code).toBe("ARTIFACT_REMOTE");
    expect(body.error.ref).toBe("http://minio.home:9000/colony/runs/r/out.bin");
    // No network call was made to serve this request.
    expect(calls).toHaveLength(0);
  });

  it("404s when the run or the artifact row is unknown", async () => {
    const { app, store } = setup();
    const runId = createRun(store, "not found");
    const missingRun = await app.request(`/runs/nope/artifacts/ra-abc`, ACTOR);
    expect(missingRun.status).toBe(404);
    const missingRow = await app.request(
      `/runs/${runId}/artifacts/ra-missing`,
      ACTOR,
    );
    expect(missingRow.status).toBe(404);
  });

  it("404s when the local bytes are gone but the row exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-artifacts-vanish-"));
    dirs.push(dir);
    const artifacts = createLocalArtifactStore(dir);
    const { app, store } = setup(artifacts);
    const runId = createRun(store, "vanished");
    const stored = await artifacts.put(
      "gone.txt",
      new TextEncoder().encode("x"),
      {
        contentType: "text/plain",
      },
    );
    const row = store.recordRunArtifact(runId, {
      kind: "file",
      key: "gone.txt",
      ref: stored.ref,
      contentType: "text/plain",
    });
    rmSync(join(dir, "gone.txt"));
    const res = await app.request(`/runs/${runId}/artifacts/${row.id}`, ACTOR);
    expect(res.status).toBe(404);
  });
});
