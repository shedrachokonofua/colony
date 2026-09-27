import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { UsageError } from "./args.js";
import {
  DEFAULT_ISSUER,
  DEFAULT_SERVER,
  credentialsPath,
  deleteCredentials,
  describeTokenSource,
  parseCredentials,
  readCredentials,
  resolveActor,
  resolveCredentials,
  resolveIssuer,
  resolveServer,
  serializeCredentials,
  writeCredentials,
  type CredentialOps,
  type StoredCredentials,
} from "./auth.js";
import { stubFetch } from "./fakes.js";
import { credentialOps } from "./oidc.js";

const ISSUER = "https://auth.test/realms/aether";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_URL = "https://auth.test/token";
const DISCOVERY = { token_endpoint: TOKEN_URL };

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

function homeWithCredentials(creds: StoredCredentials): string {
  const home = homeWithToken();
  writeCredentials(home, creds);
  return home;
}

function clientCredentials(
  extra?: Partial<StoredCredentials>,
): StoredCredentials {
  return {
    issuer: ISSUER,
    client_id: "op",
    grant: "client_credentials",
    access_token: "stored-token",
    expires_at: Date.now() + 3_600_000,
    client_secret: "s3cret",
    ...extra,
  };
}

/** Ops that must never run: asserts a path performs no network work. */
function denyOps(): CredentialOps {
  return {
    mint: () => Promise.reject(new Error("unexpected mint")),
    refresh: () => Promise.reject(new Error("unexpected refresh")),
  };
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

describe("resolveIssuer", () => {
  it("prefers --issuer over COLONY_OIDC_ISSUER and strips trailing slashes", () => {
    expect(
      resolveIssuer(
        { issuer: "https://issuer.test/" },
        { COLONY_OIDC_ISSUER: "https://env.test" },
      ),
    ).toBe("https://issuer.test");
  });

  it("uses COLONY_OIDC_ISSUER, then the default issuer", () => {
    expect(resolveIssuer({}, { COLONY_OIDC_ISSUER: "https://env.test/" })).toBe(
      "https://env.test",
    );
    expect(resolveIssuer({}, {})).toBe(DEFAULT_ISSUER);
  });
});

describe("resolveCredentials precedence", () => {
  it("prefers --token and reports the flag source", async () => {
    const home = homeWithToken("file-token");
    expect(
      await resolveCredentials(
        { token: "flag-token" },
        { COLONY_TOKEN: "env-token" },
        home,
        denyOps(),
      ),
    ).toEqual({ token: "flag-token", source: "flag" });
  });

  it("prefers COLONY_TOKEN over stored credentials and the token file", async () => {
    const home = homeWithCredentials(clientCredentials());
    expect(
      await resolveCredentials(
        {},
        { COLONY_TOKEN: "env-token" },
        home,
        denyOps(),
      ),
    ).toEqual({ token: "env-token", source: "env" });
  });

  it("prefers credentials.json over the legacy token file", async () => {
    const home = homeWithCredentials(clientCredentials());
    writeFileSync(join(home, ".config", "colony", "token"), "legacy-token");
    expect(await resolveCredentials({}, {}, home, denyOps())).toEqual({
      token: "stored-token",
      source: "credentials",
    });
  });

  it("prefers the legacy token file over env client credentials", async () => {
    const home = homeWithToken("legacy-token\n");
    expect(
      await resolveCredentials(
        {},
        { COLONY_CLIENT_ID: "op", COLONY_CLIENT_SECRET: "s3cret" },
        home,
        denyOps(),
      ),
    ).toEqual({ token: "legacy-token", source: "file" });
  });

  it("reads <home>/.config/colony/token as the file source", async () => {
    const home = homeWithToken("file-token\n");
    expect(await resolveCredentials({}, {}, home, denyOps())).toEqual({
      token: "file-token",
      source: "file",
    });
  });

  it("throws UsageError when no source yields a token", async () => {
    await expect(
      resolveCredentials({}, {}, homeWithToken(), denyOps()),
    ).rejects.toThrow(/no API token/);
    await expect(
      resolveCredentials(
        {},
        {},
        join(homeWithToken(), "does-not-exist"),
        denyOps(),
      ),
    ).rejects.toThrow(UsageError);
  });
});

describe("resolveCredentials with env client credentials", () => {
  it("mints in memory without writing a file", async () => {
    const home = homeWithToken();
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: { access_token: "mint-1", expires_in: 300 },
    });
    expect(
      await resolveCredentials(
        {},
        {
          COLONY_CLIENT_ID: "op",
          COLONY_CLIENT_SECRET: "s3cret",
          COLONY_OIDC_ISSUER: ISSUER,
        },
        home,
        credentialOps(fetchFn),
      ),
    ).toEqual({ token: "mint-1", source: "env-client-credentials" });
    expect(calls[1]?.body.get("grant_type")).toBe("client_credentials");
    expect(existsSync(credentialsPath(home))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it("ignores a half-set pair", async () => {
    await expect(
      resolveCredentials(
        {},
        { COLONY_CLIENT_ID: "op" },
        homeWithToken(),
        denyOps(),
      ),
    ).rejects.toThrow(/no API token/);
  });
});

describe("resolveCredentials with stored client credentials", () => {
  it("caches a fresh token and re-mints near expiry", async () => {
    const home = homeWithCredentials(
      clientCredentials({
        access_token: "old-token",
        expires_at: Date.now() + 30_000,
      }),
    );
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: [
        { access_token: "mint-1", expires_in: 300 },
        { access_token: "mint-2", expires_in: 300 },
      ],
    });
    const ops = credentialOps(fetchFn);

    expect(await resolveCredentials({}, {}, home, ops)).toEqual({
      token: "mint-1",
      source: "credentials",
    });
    expect(calls[1]?.body.get("grant_type")).toBe("client_credentials");
    expect(calls[1]?.body.get("client_secret")).toBe("s3cret");
    const saved = readCredentials(home);
    expect(saved?.access_token).toBe("mint-1");
    expect(saved?.client_secret).toBe("s3cret");
    expect(saved?.expires_at).toBeGreaterThan(Date.now());

    // Cached while fresh: no further network.
    expect(await resolveCredentials({}, {}, home, ops)).toEqual({
      token: "mint-1",
      source: "credentials",
    });
    expect(calls).toHaveLength(2);

    // Near expiry again: re-mints with the stored secret.
    writeCredentials(home, {
      ...(saved as StoredCredentials),
      expires_at: Date.now() + 10_000,
    });
    expect(await resolveCredentials({}, {}, home, ops)).toEqual({
      token: "mint-2",
      source: "credentials",
    });
    expect(calls).toHaveLength(4);
  });

  it("fails with a login hint when the grant is rejected", async () => {
    const home = homeWithCredentials(
      clientCredentials({ expires_at: Date.now() + 10_000 }),
    );
    const { fetchFn } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: { error: "invalid_client", error_description: "no" },
    });
    await expect(
      resolveCredentials({}, {}, home, credentialOps(fetchFn)),
    ).rejects.toThrow(/run `colony login`/);
  });
});

describe("resolveCredentials with a refresh token", () => {
  it("refreshes near expiry and persists the rotated refresh token", async () => {
    const home = homeWithCredentials({
      issuer: ISSUER,
      client_id: "colony-cli",
      grant: "device",
      access_token: "old-token",
      refresh_token: "rt-1",
      expires_at: Date.now() + 30_000,
    });
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: {
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_in: 300,
      },
    });
    expect(
      await resolveCredentials({}, {}, home, credentialOps(fetchFn)),
    ).toEqual({ token: "at-2", source: "credentials" });
    expect(calls[1]?.body.get("grant_type")).toBe("refresh_token");
    expect(calls[1]?.body.get("refresh_token")).toBe("rt-1");
    const saved = readCredentials(home);
    expect(saved?.access_token).toBe("at-2");
    expect(saved?.refresh_token).toBe("rt-2");
    expect(saved?.grant).toBe("device");
    expect(saved?.client_secret).toBeUndefined();
  });

  it("keeps the old refresh token when the response rotates nothing", async () => {
    const home = homeWithCredentials({
      issuer: ISSUER,
      client_id: "colony-cli",
      grant: "device",
      access_token: "old-token",
      refresh_token: "rt-1",
      expires_at: Date.now() + 10_000,
    });
    const { fetchFn } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: { access_token: "at-2", expires_in: 300 },
    });
    await resolveCredentials({}, {}, home, credentialOps(fetchFn));
    expect(readCredentials(home)?.refresh_token).toBe("rt-1");
  });

  it("uses an unrefreshable token as-is while any life remains", async () => {
    const home = homeWithCredentials({
      issuer: ISSUER,
      client_id: "colony-cli",
      grant: "device",
      access_token: "last-gasp",
      expires_at: Date.now() + 10_000,
    });
    expect(await resolveCredentials({}, {}, home, denyOps())).toEqual({
      token: "last-gasp",
      source: "credentials",
    });
  });

  it("throws UsageError once an unrefreshable token is expired", async () => {
    const home = homeWithCredentials({
      issuer: ISSUER,
      client_id: "colony-cli",
      grant: "device",
      access_token: "dead",
      expires_at: Date.now() - 1,
    });
    await expect(resolveCredentials({}, {}, home, denyOps())).rejects.toThrow(
      /expired.*colony login/,
    );
  });
});

describe("credentials file", () => {
  it("round-trips through serialize and parse", () => {
    const creds = clientCredentials({ refresh_token: "rt" });
    expect(parseCredentials(serializeCredentials(creds))).toEqual(creds);
  });

  it("reads malformed documents as absent", () => {
    expect(parseCredentials("not json")).toBeUndefined();
    expect(parseCredentials("[]")).toBeUndefined();
    expect(parseCredentials('{"issuer":"x"}')).toBeUndefined();
    expect(
      parseCredentials('{"issuer":"x","client_id":"y","access_token":"z"}'),
    ).toBeUndefined();
    expect(readCredentials(homeWithToken())).toBeUndefined();
  });

  it("is written mode 0600, even over a lax pre-existing file", () => {
    const home = homeWithToken();
    writeCredentials(home, clientCredentials());
    const path = credentialsPath(home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    writeCredentials(home, clientCredentials({ access_token: "again" }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("s3cret");
  });

  it("deletes on logout and reports whether a file was removed", () => {
    const home = homeWithCredentials(clientCredentials());
    expect(deleteCredentials(home)).toBe(true);
    expect(existsSync(credentialsPath(home))).toBe(false);
    expect(deleteCredentials(home)).toBe(false);
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
    expect(describeTokenSource("credentials")).toContain(
      "~/.config/colony/credentials.json",
    );
    expect(describeTokenSource("file")).toContain("~/.config/colony/token");
    expect(describeTokenSource("env-client-credentials")).toContain(
      "COLONY_CLIENT_ID",
    );
  });
});
