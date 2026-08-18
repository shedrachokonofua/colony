import { describe, it, expect } from "bun:test";
import { resolveWebToolsConfig } from "../src/agent-runtime.js";
import { env, resetEnvCache } from "@colony/config";

describe("resolveWebToolsConfig", () => {
  it("returns undefined for unset/empty", () => {
    expect(resolveWebToolsConfig(undefined)).toBeUndefined();
    expect(resolveWebToolsConfig("")).toBeUndefined();
    expect(resolveWebToolsConfig("   ")).toBeUndefined();
  });

  it("returns config object for valid https URL", () => {
    const cfg = resolveWebToolsConfig("https://searxng.home.shdr.ch");
    expect(cfg).toEqual({ searxngUrl: "https://searxng.home.shdr.ch" });
    expect(
      resolveWebToolsConfig("https://searxng.home.shdr.ch/"),
    ).toBeDefined();
    expect(
      resolveWebToolsConfig(" https://searxng.home.shdr.ch "),
    ).toBeDefined();
  });

  it("throws for http scheme", () => {
    expect(() => resolveWebToolsConfig("http://searxng.home.shdr.ch")).toThrow(
      /COLONY_SEARXNG_URL must be an https:\/\/ URL without embedded credentials/,
    );
    expect(() => resolveWebToolsConfig("http://example.com/search")).toThrow(
      /COLONY_SEARXNG_URL must be an https:\/\/ URL without embedded credentials/,
    );
  });

  it("throws for credentialed URL", () => {
    expect(() =>
      resolveWebToolsConfig("https://user:pass@searxng.home.shdr.ch"),
    ).toThrow(
      /COLONY_SEARXNG_URL must be an https:\/\/ URL without embedded credentials/,
    );
    expect(() =>
      resolveWebToolsConfig("https://user@searxng.home.shdr.ch"),
    ).toThrow(
      /COLONY_SEARXNG_URL must be an https:\/\/ URL without embedded credentials/,
    );
  });

  it("throws for invalid URL", () => {
    expect(() => resolveWebToolsConfig("not-a-url")).toThrow(
      /COLONY_SEARXNG_URL must be an https:\/\/ URL without embedded credentials/,
    );
  });
});

describe("COLONY_SEARXNG_URL env contract", () => {
  const KEY = "COLONY_SEARXNG_URL";
  let prev: string | undefined;

  function stash() {
    prev = process.env[KEY];
  }
  function restore() {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    resetEnvCache();
  }

  it("parses as optional non-empty: unset → undefined", () => {
    stash();
    try {
      delete process.env[KEY];
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("parses as optional non-empty: empty/blank → undefined", () => {
    stash();
    try {
      process.env[KEY] = "   ";
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBeUndefined();
      process.env[KEY] = "";
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("parses a set https URL as-is (validation is in resolveWebToolsConfig)", () => {
    stash();
    try {
      process.env[KEY] = "https://searxng.home.shdr.ch";
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBe("https://searxng.home.shdr.ch");
    } finally {
      restore();
    }
  });
});
