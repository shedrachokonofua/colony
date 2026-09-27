import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { parseArgs, UsageError } from "../args.js";
import { credentialsPath, readCredentials } from "../auth.js";
import { stubFetch } from "../fakes.js";
import type { FetchLike, PollClock } from "../oidc.js";
import { login, logout, type LoginDeps } from "./login.js";

const ISSUER = "https://auth.test/realms/aether";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_URL = "https://auth.test/token";
const DEVICE_URL = "https://auth.test/device";
const DISCOVERY = {
  token_endpoint: TOKEN_URL,
  device_authorization_endpoint: DEVICE_URL,
};
const ACCESS_TOKEN = "TOP-SECRET-ACCESS-TOKEN";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "colony-cli-home-"));
  dirs.push(home);
  return home;
}

interface Harness {
  deps: LoginDeps;
  out: string[];
  sleeps: number[];
}

function deps(fetchFn: FetchLike): Harness {
  const out: string[] = [];
  const sleeps: number[] = [];
  const clock: PollClock = {
    now: () => Date.now(),
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return {
    out,
    sleeps,
    deps: { fetchFn, clock, out: (text) => void out.push(text) },
  };
}

describe("login --client-credentials", () => {
  it("mints and stores the client secret for later re-minting", async () => {
    const home = emptyHome();
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: { access_token: ACCESS_TOKEN, expires_in: 300 },
    });
    const { deps: d, out } = deps(fetchFn);
    const code = await login(
      parseArgs([
        "login",
        "--client-credentials",
        "--client-id",
        "op",
        "--client-secret",
        "s3cret",
        "--issuer",
        ISSUER,
      ]),
      home,
      {},
      d,
    );
    expect(code).toBe(0);
    expect(calls[1]?.body.get("grant_type")).toBe("client_credentials");
    expect(calls[1]?.body.get("client_secret")).toBe("s3cret");
    const saved = readCredentials(home);
    expect(saved).toMatchObject({
      issuer: ISSUER,
      client_id: "op",
      grant: "client_credentials",
      access_token: ACCESS_TOKEN,
      client_secret: "s3cret",
    });
    expect(saved?.expires_at).toBeGreaterThan(Date.now());
    expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
    expect(out.join("")).not.toContain(ACCESS_TOKEN);
  });

  it("takes the client id and secret from the environment", async () => {
    const home = emptyHome();
    const { fetchFn } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: { access_token: ACCESS_TOKEN, expires_in: 300 },
    });
    const { deps: d } = deps(fetchFn);
    const code = await login(
      parseArgs(["login", "--client-credentials"]),
      home,
      {
        COLONY_CLIENT_ID: "op-env",
        COLONY_CLIENT_SECRET: "env-secret",
        COLONY_OIDC_ISSUER: ISSUER,
      },
      d,
    );
    expect(code).toBe(0);
    expect(readCredentials(home)?.client_id).toBe("op-env");
  });

  it("rejects a missing client secret", async () => {
    const { deps: d } = deps(stubFetch({}).fetchFn);
    await expect(
      login(
        parseArgs(["login", "--client-credentials", "--client-id", "op"]),
        emptyHome(),
        {},
        d,
      ),
    ).rejects.toThrow(UsageError);
  });
});

describe("login (device flow)", () => {
  const DEVICE_CODE_RESPONSE = {
    device_code: "dev-1",
    user_code: "ABCD-1234",
    verification_uri: "https://auth.test/device",
    verification_uri_complete: "https://auth.test/device?user_code=ABCD-1234",
    expires_in: 600,
    interval: 1,
  };

  it("prints the verification URL and code, polls, and stores tokens", async () => {
    const home = emptyHome();
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [DEVICE_URL]: DEVICE_CODE_RESPONSE,
      [TOKEN_URL]: [
        { error: "authorization_pending" },
        { access_token: ACCESS_TOKEN, refresh_token: "rt-1", expires_in: 300 },
      ],
    });
    const { deps: d, out, sleeps } = deps(fetchFn);
    const code = await login(
      parseArgs(["login", "--issuer", ISSUER]),
      home,
      {},
      d,
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("https://auth.test/device");
    expect(text).toContain("ABCD-1234");
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(sleeps).toEqual([1000, 1000]);
    const polls = calls.slice(2);
    expect(polls).toHaveLength(2);
    expect(polls[0]?.body.get("client_id")).toBe("colony-cli");
    expect(readCredentials(home)).toMatchObject({
      issuer: ISSUER,
      client_id: "colony-cli",
      grant: "device",
      access_token: ACCESS_TOKEN,
      refresh_token: "rt-1",
    });
    expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
  });

  it("honors COLONY_OIDC_CLIENT_ID", async () => {
    const home = emptyHome();
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [DEVICE_URL]: DEVICE_CODE_RESPONSE,
      [TOKEN_URL]: { access_token: ACCESS_TOKEN, expires_in: 300 },
    });
    const { deps: d } = deps(fetchFn);
    await login(
      parseArgs(["login"]),
      home,
      {
        COLONY_OIDC_CLIENT_ID: "custom-cli",
        COLONY_OIDC_ISSUER: ISSUER,
      },
      d,
    );
    expect(readCredentials(home)?.client_id).toBe("custom-cli");
    expect(calls[2]?.body.get("client_id")).toBe("custom-cli");
  });
});

describe("logout", () => {
  it("removes stored credentials and is idempotent", () => {
    const home = emptyHome();
    mkdirSync(join(home, ".config", "colony"), { recursive: true });
    writeFileSync(credentialsPath(home), "{}");
    const out: string[] = [];
    expect(logout(home, (text) => void out.push(text))).toBe(0);
    expect(existsSync(credentialsPath(home))).toBe(false);
    expect(logout(home, (text) => void out.push(text))).toBe(0);
    expect(out.join("")).toContain("logged out");
    expect(out.join("")).toContain("not logged in");
  });
});
