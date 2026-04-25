import { describe, expect, it } from "vitest";
import type { ActorId } from "@colony/domain";
import {
  auditProviderCredentialDecision,
  buildApp,
  resolvePackageAccess,
  resolveProviderCredential,
  type ToolGatewayAuditRecord,
} from "./app.js";

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

  it("audits provider credential decisions without exposing token values", async () => {
    const audit: ToolGatewayAuditRecord[] = [];
    const app = buildApp({
      resolveIdentity: () =>
        Promise.resolve({
          actor: "bot:engine" as ActorId,
          provider: "gitlab",
          provider_user_id: "1",
          provider_username: "colony-engine",
          role: "developer",
          is_bot: true,
          allowed_namespaces: ["so"],
        }),
      tokenForRole: () => "sensitive-token",
      audit: (record) => {
        audit.push(record);
      },
    });

    const response = await app.request(
      "http://x/internal/provider/credential",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: "bot:engine",
          capability: "provider.branches.push",
          provider: "gitlab",
          project: { id: "49", path: "so/colony" },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token: "sensitive-token",
    });
    expect(JSON.stringify(audit)).not.toContain("sensitive-token");
    expect(audit[0]).toMatchObject({
      action: "tool.provider.credential",
      capability: "provider.branches.push",
      allowed: true,
      evidence: {
        bot_actor: "bot:engine",
        token: "<redacted>",
      },
    });
  });

  it("builds redacted provider credential audit records", () => {
    const record = auditProviderCredentialDecision({
      actor: "bot:engine" as ActorId,
      capability: "provider.branches.push",
      resolved: {
        allowed: true,
        credential: {
          provider: "gitlab",
          bot_actor: "bot:engine",
          provider_user_id: "1",
          token: "secret",
        },
      },
    });

    expect(JSON.stringify(record)).not.toContain("secret");
    expect(record.evidence).toMatchObject({ token: "<redacted>" });
  });
});

describe("package registry allowlist", () => {
  it("allows exact, scope, and prefix package patterns", () => {
    const allowlist = [
      {
        registry: "npm",
        packagePatterns: ["typescript", "@colony/*", "eslint-*"],
      },
    ];

    expect(
      resolvePackageAccess({
        allowlist,
        registry: "npm",
        packageName: "typescript",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolvePackageAccess({
        allowlist,
        registry: "npm",
        packageName: "@colony/domain",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolvePackageAccess({
        allowlist,
        registry: "npm",
        packageName: "eslint-config-example",
      }),
    ).toEqual({ allowed: true });
  });

  it("denies unauthorized packages and writes an audit record over HTTP", async () => {
    const audit: ToolGatewayAuditRecord[] = [];
    const app = buildApp({
      resolveIdentity: () => Promise.resolve(null),
      tokenForRole: () => undefined,
      packageAllowlist: [{ registry: "npm", packagePatterns: ["typescript"] }],
      audit: (record) => {
        audit.push(record);
      },
    });

    const response = await app.request("http://x/internal/package/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "bot:engine",
        registry: "npm",
        package_name: "left-pad",
      }),
    });

    expect(response.status).toBe(403);
    expect(audit[0]).toMatchObject({
      actor: "bot:engine",
      action: "tool.package.access",
      capability: "tool.call",
      allowed: false,
      reason: "package_denied",
    });
    expect(JSON.stringify(audit)).not.toMatch(/token|secret/i);
  });
});
