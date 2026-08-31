import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { UsageError } from "./args.js";
import {
  DEFAULT_SERVER,
  describeTokenSource,
  resolveActor,
  resolveCredentials,
  resolveServer,
} from "./auth.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function homeWithToken(token?: string): string {
  const home = mkdtempSync(join(tmpdir(), "colony-cli-home-"));
  dirs.push(home);
  if (token !== undefined) {
    mkdirSync(join(home, ".config", "colony"), { recursive: true });
    writeFileSync(join(home, ".config", "colony", "token"), token);
  }
  return home;
}

describe("resolveServer", () => {
  it("prefers --server over COLONY_URL", () => {
    expect(
      resolveServer(
        { server: "http://localhost:8080" },
        { COLONY_URL: "https://env" },
      ),
    ).toBe("http://localhost:8080");
  });

  it("uses COLONY_URL when no flag is given", () => {
    expect(resolveServer({}, { COLONY_URL: "https://env" })).toBe(
      "https://env",
    );
  });

  it("falls back to the default server", () => {
    expect(resolveServer({}, {})).toBe(DEFAULT_SERVER);
  });

  it("ignores an empty COLONY_URL", () => {
    expect(resolveServer({}, { COLONY_URL: "  " })).toBe(DEFAULT_SERVER);
  });
});

describe("resolveCredentials", () => {
  it("prefers --token and reports the flag source", () => {
    const home = homeWithToken("file-token");
    expect(
      resolveCredentials(
        { token: "flag-token" },
        { COLONY_TOKEN: "env-token" },
        home,
      ),
    ).toEqual({ token: "flag-token", source: "flag" });
  });

  it("prefers COLONY_TOKEN over the token file", () => {
    const home = homeWithToken("file-token");
    expect(resolveCredentials({}, { COLONY_TOKEN: "env-token" }, home)).toEqual(
      {
        token: "env-token",
        source: "env",
      },
    );
  });

  it("reads <home>/.config/colony/token as the file source", () => {
    const home = homeWithToken("file-token\n");
    expect(resolveCredentials({}, {}, home)).toEqual({
      token: "file-token",
      source: "file",
    });
  });

  it("treats an unreadable or missing file as absent", () => {
    expect(() => resolveCredentials({}, {}, homeWithToken())).toThrow(
      UsageError,
    );
    expect(() =>
      resolveCredentials({}, {}, join(homeWithToken(), "does-not-exist")),
    ).toThrow(UsageError);
  });

  it("throws UsageError when no source yields a token", () => {
    expect(() => resolveCredentials({}, {}, homeWithToken())).toThrow(
      /no API token/,
    );
  });
});

describe("resolveActor", () => {
  it("prefers --actor over COLONY_ACTOR and USER", () => {
    expect(
      resolveActor({ actor: "svc:bot" }, { COLONY_ACTOR: "env", USER: "user" }),
    ).toBe("svc:bot");
  });

  it("falls back through COLONY_ACTOR, USER, then unknown", () => {
    expect(resolveActor({}, { COLONY_ACTOR: "env", USER: "user" })).toBe("env");
    expect(resolveActor({}, { USER: "user" })).toBe("user");
    expect(resolveActor({}, {})).toBe("unknown");
  });
});

describe("describeTokenSource", () => {
  it("names each source for auth failure messages", () => {
    expect(describeTokenSource("flag")).toContain("--token");
    expect(describeTokenSource("env")).toContain("COLONY_TOKEN");
    expect(describeTokenSource("file")).toContain("~/.config/colony/token");
  });
});
