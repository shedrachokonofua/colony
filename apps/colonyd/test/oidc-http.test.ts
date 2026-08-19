import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import { createOidcVerifier } from "../src/oidc.js";

const ISSUER = "https://auth.test/realms/aether";
const CLIENT = "colony";
const KID = "test-key";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function fakeFetch(url: string | URL | Request): Promise<Response> {
  const href = String(url);
  if (href === `${ISSUER}/.well-known/openid-configuration`) {
    return Promise.resolve(Response.json({ jwks_uri: `${ISSUER}/jwks` }));
  }
  if (href === `${ISSUER}/jwks`) {
    const jwk = publicKey.export({ format: "jwk" });
    return Promise.resolve(Response.json({ keys: [{ ...jwk, kid: KID }] }));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function signToken(claims: Record<string, unknown>, header?: object): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid: KID, ...header })}.${encode({
    iss: ISSUER,
    azp: CLIENT,
    aud: "account",
    exp: Math.floor(Date.now() / 1000) + 300,
    preferred_username: "shdrch",
    email: "op@shdr.ch",
    realm_access: { roles: ["admin"] },
    ...claims,
  })}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(body), privateKey);
  return `${body}.${signature.toString("base64url")}`;
}

const verifier = createOidcVerifier({
  issuer: ISSUER,
  clientId: CLIENT,
  requiredRole: "admin",
  fetchImpl: fakeFetch,
});

describe("oidc verifier", () => {
  it("accepts a signed admin token and extracts the identity", async () => {
    const identity = await verifier.verify(signToken({}));
    expect(identity).toEqual({ username: "shdrch", email: "op@shdr.ch" });
  });

  it("rejects an expired token", async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) - 120 });
    await expect(verifier.verify(token)).rejects.toThrow("expired");
  });

  it("rejects a token issued to another client", async () => {
    const token = signToken({ azp: "grafana", aud: "grafana" });
    await expect(verifier.verify(token)).rejects.toThrow("not issued");
  });

  it("rejects a token missing the required realm role", async () => {
    const token = signToken({ realm_access: { roles: ["memos-user"] } });
    await expect(verifier.verify(token)).rejects.toThrow("missing required");
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = signToken({}).split(".");
    const forged = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        azp: CLIENT,
        exp: Math.floor(Date.now() / 1000) + 300,
        preferred_username: "intruder",
        realm_access: { roles: ["admin"] },
      }),
    ).toString("base64url");
    await expect(verifier.verify(`${h}.${forged}.${s}`)).rejects.toThrow(
      "signature",
    );
  });

  it("rejects non-RS256 tokens outright", async () => {
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none" })}.${encode({ iss: ISSUER })}.`;
    await expect(verifier.verify(token)).rejects.toThrow("unsupported");
  });
});

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function oidcApp() {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-oidc-"));
  dirs.push(dir);
  const ctx: ColonydContext = {
    store: new Store(join(dir, "test.db")),
    provider: {} as ColonydContext["provider"],
    config: {
      reviewMode: "off",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    logger: { info() {}, warn() {}, error() {} },
    oidcVerifier: verifier,
    env: {
      gitlabBaseUrl: "https://gitlab.home.shdr.ch",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 1,
      maxAttempts: 3,
      oidcIssuer: ISSUER,
      oidcClientId: CLIENT,
      oidcRequiredRole: "admin",
    },
    requestTick() {},
  };
  return buildApp(ctx);
}

describe("oidc-gated API", () => {
  it("publishes the oidc config for the console", async () => {
    const res = await oidcApp().request("/ui/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oidc: unknown };
    expect(body.oidc).toEqual({ issuer: ISSUER, client_id: CLIENT });
  });

  it("rejects API calls without a bearer token", async () => {
    const res = await oidcApp().request("/scopes");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("ignores X-Actor-Id when OIDC is enabled", async () => {
    const res = await oidcApp().request("/scopes", {
      headers: { "X-Actor-Id": "human:imposter" },
    });
    expect(res.status).toBe(401);
  });

  it("derives the actor from a valid token", async () => {
    const app = oidcApp();
    const res = await app.request("/scopes", {
      headers: { Authorization: `Bearer ${signToken({})}` },
    });
    expect(res.status).toBe(200);
  });

  it("still serves the console shell without a token", async () => {
    const res = await oidcApp().request("/");
    expect(res.status).toBe(200);
  });
});
