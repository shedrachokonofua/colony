import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("@colony/api", () => {
  it("serves /openapi.json", async () => {
    const app = buildApp();
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { info: { title: string } };
    expect(doc.info.title).toBe("Colony API");
  });

  it("returns a structured health response even when DB is unavailable", async () => {
    // Point at an address that cannot resolve so pingDatabase fails fast.
    process.env.DATABASE_URL = "postgres://nope:nope@127.0.0.1:1/colony";
    const { resetEnvCache } = await import("@colony/config");
    resetEnvCache();
    const app = buildApp();
    const res = await app.request("/health");
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as { service: string; db: { ok: boolean } };
    expect(body.service).toBe("colony-api");
    expect(typeof body.db.ok).toBe("boolean");
  });
});
