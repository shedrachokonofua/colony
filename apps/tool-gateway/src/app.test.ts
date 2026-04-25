import { describe, expect, it } from "vitest";
import type { ActorId } from "@colony/domain";
import { buildApp, resolveProviderCredential } from "./app.js";

describe("@colony/tool-gateway HTTP integration", () => {
  it("serves health and OpenAPI endpoints", async () => {
    const app = buildApp();

    const health = await app.request("http://x/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      service: "colony-tool-gateway",
    });

    const openapi = await app.request("http://x/openapi.json");
    expect(openapi.status).toBe(200);
    await expect(openapi.json()).resolves.toMatchObject({
      info: { title: "Colony Tool Gateway" },
      paths: { "/health": expect.any(Object) as unknown },
    });
  });
});

describe("provider credential resolution", () => {
  it("denies merge for developer and allows integrator with the integrator token", () => {
    const developer = resolveProviderCredential({
      identity: {
        actor: "bot:engine" as ActorId,
        provider: "gitlab",
        provider_user_id: "1",
        role: "developer",
        is_bot: true,
        allowed_namespaces: [],
      },
      capability: "provider.mr.merge",
      tokenForRole: () => "engine-token",
    });
    expect(developer).toEqual({
      allowed: false,
      reason: "missing_capability",
    });

    const integrator = resolveProviderCredential({
      identity: {
        actor: "bot:integrator" as ActorId,
        provider: "gitlab",
        provider_user_id: "2",
        provider_username: "colony-integrator",
        role: "integrator",
        is_bot: true,
        allowed_namespaces: [],
      },
      capability: "provider.mr.merge",
      tokenForRole: (role) =>
        role === "integrator" ? "integrator-token" : undefined,
    });
    expect(integrator).toMatchObject({
      allowed: true,
      credential: {
        bot_actor: "bot:integrator",
        token: "integrator-token",
      },
    });
  });

  it("enforces namespace allowlists before returning a token", () => {
    const denied = resolveProviderCredential({
      identity: {
        actor: "bot:engine" as ActorId,
        provider: "gitlab",
        provider_user_id: "1",
        role: "developer",
        is_bot: true,
        allowed_namespaces: ["colony"],
      },
      capability: "provider.mr.open",
      projectPath: "other-org/api",
      tokenForRole: () => "engine-token",
    });
    expect(denied).toEqual({ allowed: false, reason: "namespace_denied" });

    const allowed = resolveProviderCredential({
      identity: {
        actor: "bot:engine" as ActorId,
        provider: "gitlab",
        provider_user_id: "1",
        role: "developer",
        is_bot: true,
        allowed_namespaces: [],
      },
      capability: "provider.mr.open",
      projectPath: "other-org/api",
      tokenForRole: () => "engine-token",
    });
    expect(allowed).toMatchObject({ allowed: true });
  });
});
