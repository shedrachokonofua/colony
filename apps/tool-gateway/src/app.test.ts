import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

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
