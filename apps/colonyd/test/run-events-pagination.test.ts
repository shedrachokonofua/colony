import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Store } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Env = { Variables: { actor: string } };

function fakeCtx(store: Store): ColonydContext {
  return {
    store,
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

function appAndStore(): { app: Hono<Env>; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-pagination-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  return { app: buildApp(fakeCtx(store)), store };
}

interface EventRow {
  id: number;
  event: string;
  detail_json: string;
  /** Audit rows carry run_id; run_events rows do not. */
  run_id?: string | null;
}

interface Envelope {
  events: EventRow[];
  has_more: boolean;
  oldest_id: number | null;
  newest_id: number | null;
}

async function createRun(store: Store, goal: string) {
  const scope = store.createScope({
    goal,
    title: goal,
    provider_repo_id: "1",
    provider_repo_path: "so/colony",
  });
  return store.startRun({
    scope_id: scope.id,
    kind: "implement",
    lease_ttl_ms: 60_000,
  });
}

const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };

describe("run events cursor pagination over HTTP", () => {
  it("returns the 200 newest rows by default with has_more true", async () => {
    const { app, store } = appAndStore();
    const run = await createRun(store, "paginate events");
    for (let i = 1; i <= 250; i++) {
      store.appendRunEvent(run.id, `event_${i}`, { i });
    }
    const res = await app.request(`/runs/${run.id}/events`, ACTOR);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Envelope;
    expect(page.events).toHaveLength(200);
    expect(page.has_more).toBe(true);
    // Newest 200 of 250: ids 51..250 ascending.
    expect(page.oldest_id).toBe(51);
    expect(page.newest_id).toBe(250);
  });

  it("walks older pages ascending from before_id", async () => {
    const { app, store } = appAndStore();
    const run = await createRun(store, "walk events back");
    for (let i = 1; i <= 250; i++) {
      store.appendRunEvent(run.id, `event_${i}`, { i });
    }
    const firstRes = await app.request(`/runs/${run.id}/events`, ACTOR);
    const first = (await firstRes.json()) as Envelope;
    const res = await app.request(
      `/runs/${run.id}/events?before_id=${first.oldest_id}&limit=50`,
      ACTOR,
    );
    expect(res.status).toBe(200);
    const older = (await res.json()) as Envelope;
    // Exclusive cursor: ids 1..50, ascending.
    expect(older.events.map((e) => e.id)).toEqual(
      Array.from({ length: 50 }, (_, k) => k + 1),
    );
    expect(older.has_more).toBe(false);
    expect(older.newest_id).toBe(50);
    expect(older.oldest_id).toBe(1);
  });

  it("rejects invalid before_id and limit values with badBody", async () => {
    const { app, store } = appAndStore();
    const run = await createRun(store, "validate query params");
    store.appendRunEvent(run.id, "only_event", {});
    for (const query of [
      "?before_id=nope",
      "?limit=0",
      "?limit=1001",
      "?limit=-5",
      "?limit=1.5",
      "?before_id=3&limit=nope",
    ]) {
      const res = await app.request(`/runs/${run.id}/events${query}`, ACTOR);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("INVALID_BODY");
    }
  });

  it("404s for an unknown run", async () => {
    const { app } = appAndStore();
    const res = await app.request("/runs/nope/events?limit=5", ACTOR);
    expect(res.status).toBe(404);
  });
});

describe("audit cursor pagination over HTTP", () => {
  it("filters to one run and paginates with before_id", async () => {
    const { app, store } = appAndStore();
    const runA = await createRun(store, "audit run a");
    const runB = await createRun(store, "audit run b");
    for (let i = 1; i <= 30; i++) {
      store.audit("test", `a.step_${i}`, { run_id: runA.id });
    }
    store.audit("test", "b.step", { run_id: runB.id });

    const all = (await (await app.request("/audit", ACTOR)).json()) as Envelope;
    expect(all.events).toHaveLength(31);
    expect(all.has_more).toBe(false);

    const filtered = (await (
      await app.request(`/audit?run_id=${runA.id}`, ACTOR)
    ).json()) as Envelope;
    expect(filtered.events).toHaveLength(30);
    expect(filtered.events.every((row) => row.run_id === runA.id)).toBe(true);
    expect(filtered.oldest_id).toBe(filtered.events[0]!.id);

    const page = (await (
      await app.request(`/audit?run_id=${runA.id}&limit=10`, ACTOR)
    ).json()) as Envelope;
    expect(page.events).toHaveLength(10);
    expect(page.has_more).toBe(true);
    expect(page.newest_id).toBe(30);
    expect(page.oldest_id).toBe(page.events[0]!.id);

    const cursor = page.events[0]!.id;
    const older = (await (
      await app.request(
        `/audit?run_id=${runA.id}&before_id=${cursor}&limit=10`,
        ACTOR,
      )
    ).json()) as Envelope;
    expect(older.events.map((r) => r.id)).toEqual(
      Array.from({ length: 10 }, (_, k) => cursor - 10 + k),
    );
    expect(older.has_more).toBe(true);
  });

  it("rejects invalid audit query values with badBody", async () => {
    const { app, store } = appAndStore();
    const run = await createRun(store, "audit validation");
    store.audit("test", "one", { run_id: run.id });
    for (const query of [
      "?before_id=nope",
      "?limit=0",
      "?limit=1001",
      "?run_id=&limit=nope",
    ]) {
      const res = await app.request(`/audit${query}`, ACTOR);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("INVALID_BODY");
    }
  });
});
