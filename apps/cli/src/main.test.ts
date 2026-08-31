import { describe, expect, it } from "bun:test";
import { COMMANDS, helpText, main } from "./main.js";

const original = globalThis.fetch;

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
}

describe("helpText", () => {
  it("lists every subcommand in the spec", () => {
    const help = helpText();
    for (const name of [
      "scopes",
      "scope",
      "open",
      "approve",
      "replan",
      "abandon",
      "revalidate",
      "task",
      "runs",
      "run",
      "logs",
      "artifacts",
      "projects",
      "project",
      "context",
      "audit",
      "status",
    ]) {
      expect(help).toContain(name);
    }
  });
});

describe("main", () => {
  it("dispatches every read command to a handler", () => {
    for (const name of [
      "scopes",
      "scope",
      "runs",
      "run",
      "logs",
      "artifacts",
      "projects",
      "project",
      "context",
      "audit",
      "status",
    ]) {
      expect(COMMANDS[name]).toBeTypeOf("function");
    }
  });

  it("names the credential source and exits 1 on a 401", async () => {
    stubFetch(401, {
      error: { code: "UNAUTHORIZED", message: "Bearer token required" },
    });
    const errors: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(["scopes", "--token", "t", "--json"]);
    } finally {
      process.stderr.write = originalWrite;
      globalThis.fetch = original;
    }
    expect(code).toBe(1);
    expect(errors.join("")).toBe(
      "auth failed (401): token from --token — check it, or set --token / ~/.config/colony/token\n",
    );
  });

  it("names the env source on a 403", async () => {
    stubFetch(403, { error: { code: "FORBIDDEN", message: "no" } });
    const errors: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;
    const env = { ...process.env, COLONY_TOKEN: "env-token" };
    const originalEnv = process.env;
    let code: number;
    try {
      process.env = env;
      code = await main(["scopes", "--json"]);
    } finally {
      process.stderr.write = originalWrite;
      process.env = originalEnv;
      globalThis.fetch = original;
    }
    expect(code).toBe(1);
    expect(errors.join("")).toContain(
      "auth failed (403): token from COLONY_TOKEN",
    );
  });

  it("exits 1 with the API code and message on other errors", async () => {
    stubFetch(404, {
      error: { code: "NOT_FOUND", message: "scope not found" },
    });
    const errors: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(["scopes", "--token", "t", "--json"]);
    } finally {
      process.stderr.write = originalWrite;
      globalThis.fetch = original;
    }
    expect(code).toBe(1);
    expect(errors.join("")).toBe("NOT_FOUND (404): scope not found\n");
  });

  it("exits 2 on a usage error", async () => {
    const errors: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(["frobnicate"]);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(code).toBe(2);
    expect(errors.join("")).toContain("unknown command 'frobnicate'");
  });

  it("exits 2 when no token is available", async () => {
    const errors: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;
    const originalEnv = process.env;
    let code: number;
    try {
      process.env = { PATH: process.env.PATH };
      code = await main(["scopes", "--json"]);
    } finally {
      process.stderr.write = originalWrite;
      process.env = originalEnv;
    }
    expect(code).toBe(2);
    expect(errors.join("")).toContain("no API token");
  });
});
