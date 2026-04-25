import { describe, expect, it } from "vitest";
import { createOAuthAuthStorage } from "./oauth-auth-storage.js";
import type {
  OAuthCredentialRepository,
  OAuthConnection,
  OAuthConnectionMetadata,
} from "@colony/db";

interface PiAuth {
  readonly access_token: string;
  readonly refresh_token: string;
}

function makeFakeRepo(initial?: OAuthConnection<PiAuth>): {
  repo: OAuthCredentialRepository;
  state: {
    activeConnection: OAuthConnection<PiAuth> | null;
    refreshes: Array<{ id: string; payload: PiAuth }>;
    upserts: Array<{ providerKey: string; payload: PiAuth }>;
  };
} {
  const state = {
    activeConnection: initial ?? null,
    refreshes: [] as Array<{ id: string; payload: PiAuth }>,
    upserts: [] as Array<{ providerKey: string; payload: PiAuth }>,
  };
  // Strip the payload field from `initial` so the metadata mirror has the
  // shape OAuthConnectionMetadata callers expect.
  const metaWithoutPayload: OAuthConnectionMetadata | null = initial
    ? (() => {
        const { payload, ...rest } = initial;
        void payload;
        return rest;
      })()
    : null;
  let nextId = 2;
  const repo: Partial<OAuthCredentialRepository> = {
    getActiveConnection<T>() {
      return Promise.resolve(
        (state.activeConnection as OAuthConnection<T> | null) ?? null,
      );
    },
    getConnectionMetadata() {
      return Promise.resolve(metaWithoutPayload);
    },
    recordRefresh<T>(input: { id: string; payload: T }) {
      if (!state.activeConnection || state.activeConnection.id !== input.id) {
        return Promise.resolve(null);
      }
      state.activeConnection = {
        ...state.activeConnection,
        payload: input.payload as unknown as PiAuth,
        refreshedAt: new Date().toISOString(),
      };
      state.refreshes.push({
        id: input.id,
        payload: input.payload as unknown as PiAuth,
      });
      const { payload, ...rest } = state.activeConnection;
      void payload;
      return Promise.resolve(rest);
    },
    upsertConnection<T>(input: {
      providerKey: string;
      providerApi: string;
      payload: T;
    }) {
      const id = `oauth-fake-${nextId++}`;
      state.activeConnection = {
        id,
        providerKey: input.providerKey,
        providerApi: input.providerApi as OAuthConnection<T>["providerApi"],
        payload: input.payload as unknown as PiAuth,
        status: "active",
        grantedBy: "human:op-1",
        grantedAt: new Date().toISOString(),
        refreshedAt: null,
        expiresAt: null,
        revokedAt: null,
      };
      state.upserts.push({
        providerKey: input.providerKey,
        payload: input.payload as unknown as PiAuth,
      });
      const { payload, ...rest } = state.activeConnection;
      void payload;
      return Promise.resolve(rest);
    },
  };
  return { repo: repo as OAuthCredentialRepository, state };
}

describe("createOAuthAuthStorage", () => {
  it("load() returns null when no active connection exists", async () => {
    const { repo } = makeFakeRepo();
    const storage = createOAuthAuthStorage<PiAuth>({
      providerKey: "openai_codex",
      repo,
    });
    expect(await storage.load()).toBeNull();
  });

  it("load() returns the decrypted payload for an active connection", async () => {
    const { repo } = makeFakeRepo({
      id: "oauth-1",
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "at-1", refresh_token: "rt-1" },
      status: "active",
      grantedBy: "human:op-1",
      grantedAt: new Date().toISOString(),
      refreshedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    const storage = createOAuthAuthStorage<PiAuth>({
      providerKey: "openai_codex",
      repo,
    });
    expect(await storage.load()).toEqual({
      access_token: "at-1",
      refresh_token: "rt-1",
    });
  });

  it("save() routes to recordRefresh on the cached id after load()", async () => {
    const { repo, state } = makeFakeRepo({
      id: "oauth-1",
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "at-1", refresh_token: "rt-1" },
      status: "active",
      grantedBy: "human:op-1",
      grantedAt: new Date().toISOString(),
      refreshedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    const storage = createOAuthAuthStorage<PiAuth>({
      providerKey: "openai_codex",
      repo,
    });
    await storage.load();
    await storage.save({ access_token: "at-2", refresh_token: "rt-2" });
    expect(state.refreshes).toEqual([
      {
        id: "oauth-1",
        payload: { access_token: "at-2", refresh_token: "rt-2" },
      },
    ]);
    expect(state.upserts).toHaveLength(0);
  });

  it("save() falls back to upsertConnection when no row was loaded", async () => {
    const { repo, state } = makeFakeRepo({
      id: "oauth-1",
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "old", refresh_token: "old" },
      status: "active",
      grantedBy: "human:op-1",
      grantedAt: new Date().toISOString(),
      refreshedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    const storage = createOAuthAuthStorage<PiAuth>({
      providerKey: "openai_codex",
      repo,
    });
    // No load() before save() — cachedId is null.
    await storage.save({ access_token: "fresh", refresh_token: "fresh" });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toEqual({
      providerKey: "openai_codex",
      payload: { access_token: "fresh", refresh_token: "fresh" },
    });
  });

  it("save() raises when there is no metadata to fall back on", async () => {
    const { repo } = makeFakeRepo();
    const storage = createOAuthAuthStorage<PiAuth>({
      providerKey: "openai_codex",
      repo,
    });
    await expect(
      storage.save({ access_token: "x", refresh_token: "x" }),
    ).rejects.toThrow(/no active connection/);
  });
});
