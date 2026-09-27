import { describe, expect, it } from "bun:test";
import { stubFetch } from "./fakes.js";
import {
  DEVICE_GRANT_TYPE,
  OidcError,
  clientCredentialsLogin,
  deviceAuthorize,
  discover,
  pollDeviceToken,
  refreshLogin,
  type PollClock,
} from "./oidc.js";

const ISSUER = "https://auth.test/realms/aether";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_URL = "https://auth.test/token";
const DEVICE_URL = "https://auth.test/device";

const DISCOVERY = {
  token_endpoint: TOKEN_URL,
  device_authorization_endpoint: DEVICE_URL,
};

function fakeClock(): PollClock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => Date.now(),
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

describe("discover", () => {
  it("strips trailing slashes and reads the token endpoint", async () => {
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
    });
    const endpoints = await discover(`${ISSUER}///`, fetchFn);
    expect(calls[0]?.url).toBe(DISCOVERY_URL);
    expect(endpoints.token_endpoint).toBe(TOKEN_URL);
    expect(endpoints.device_authorization_endpoint).toBe(DEVICE_URL);
  });

  it("throws when the document has no token_endpoint", async () => {
    const { fetchFn } = stubFetch({ [DISCOVERY_URL]: {} });
    await expect(discover(ISSUER, fetchFn)).rejects.toThrow(OidcError);
  });
});

describe("clientCredentialsLogin", () => {
  it("mints via the client_credentials grant and returns expiry", async () => {
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 300,
      },
    });
    const minted = await clientCredentialsLogin({
      issuer: ISSUER,
      clientId: "op",
      clientSecret: "s3cret",
      fetchFn,
    });
    expect(minted.accessToken).toBe("at-1");
    expect(minted.refreshToken).toBe("rt-1");
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
    const form = calls[1]?.body;
    expect(form?.get("grant_type")).toBe("client_credentials");
    expect(form?.get("client_id")).toBe("op");
    expect(form?.get("client_secret")).toBe("s3cret");
  });

  it("surfaces the OAuth error code and description", async () => {
    const { fetchFn } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: {
        error: "invalid_client",
        error_description: "unknown client",
      },
    });
    try {
      await clientCredentialsLogin({
        issuer: ISSUER,
        clientId: "op",
        clientSecret: "bad",
        fetchFn,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OidcError);
      expect((err as OidcError).code).toBe("invalid_client");
      expect((err as OidcError).message).toContain("unknown client");
    }
  });
});

describe("refreshLogin", () => {
  it("trades the refresh token via the refresh_token grant", async () => {
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [TOKEN_URL]: {
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_in: 300,
      },
    });
    const minted = await refreshLogin({
      issuer: ISSUER,
      clientId: "colony-cli",
      refreshToken: "rt-1",
      fetchFn,
    });
    expect(minted.accessToken).toBe("at-2");
    expect(minted.refreshToken).toBe("rt-2");
    const form = calls[1]?.body;
    expect(form?.get("grant_type")).toBe("refresh_token");
    expect(form?.get("refresh_token")).toBe("rt-1");
    expect(form?.get("client_id")).toBe("colony-cli");
  });
});

describe("device flow", () => {
  const DEVICE_CODE_RESPONSE = {
    device_code: "dev-1",
    user_code: "ABCD-1234",
    verification_uri: "https://auth.test/device",
    verification_uri_complete: "https://auth.test/device?user_code=ABCD-1234",
    expires_in: 600,
    interval: 1,
  };

  it("posts client_id and scope to the device endpoint", async () => {
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [DEVICE_URL]: DEVICE_CODE_RESPONSE,
    });
    const { authorization, tokenEndpoint } = await deviceAuthorize({
      issuer: ISSUER,
      clientId: "colony-cli",
      scope: "openid offline_access",
      fetchFn,
    });
    expect(tokenEndpoint).toBe(TOKEN_URL);
    expect(authorization).toEqual({
      deviceCode: "dev-1",
      userCode: "ABCD-1234",
      verificationUri: "https://auth.test/device",
      verificationUriComplete: "https://auth.test/device?user_code=ABCD-1234",
      intervalMs: 1000,
      expiresAt: expect.any(Number),
    });
    const form = calls[1]?.body;
    expect(form?.get("client_id")).toBe("colony-cli");
    expect(form?.get("scope")).toBe("openid offline_access");
  });

  it("polls through authorization_pending and slow_down", async () => {
    const { fetchFn, calls } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [DEVICE_URL]: DEVICE_CODE_RESPONSE,
      [TOKEN_URL]: [
        { error: "authorization_pending" },
        { error: "authorization_pending" },
        { error: "slow_down" },
        { access_token: "at-3", refresh_token: "rt-3", expires_in: 300 },
      ],
    });
    const clock = fakeClock();
    const { authorization } = await deviceAuthorize({
      issuer: ISSUER,
      clientId: "colony-cli",
      scope: "openid offline_access",
      fetchFn,
    });
    const minted = await pollDeviceToken({
      tokenEndpoint: TOKEN_URL,
      clientId: "colony-cli",
      authorization,
      fetchFn,
      clock,
    });
    expect(minted.accessToken).toBe("at-3");
    expect(minted.refreshToken).toBe("rt-3");
    // RFC 8628 §3.5: sleep the interval before each poll; slow_down
    // increases the current interval by 5s for all subsequent requests.
    expect(clock.sleeps).toEqual([1000, 1000, 1000, 6000]);
    const polls = calls.slice(2);
    expect(polls).toHaveLength(4);
    for (const poll of polls) {
      expect(poll.url).toBe(TOKEN_URL);
      expect(poll.body.get("grant_type")).toBe(DEVICE_GRANT_TYPE);
      expect(poll.body.get("device_code")).toBe("dev-1");
      expect(poll.body.get("client_id")).toBe("colony-cli");
    }
  });

  it("fails when the device code expires", async () => {
    const { fetchFn } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [DEVICE_URL]: DEVICE_CODE_RESPONSE,
      [TOKEN_URL]: { error: "expired_token" },
    });
    const clock = fakeClock();
    const { authorization } = await deviceAuthorize({
      issuer: ISSUER,
      clientId: "colony-cli",
      fetchFn,
    });
    try {
      await pollDeviceToken({
        tokenEndpoint: TOKEN_URL,
        clientId: "colony-cli",
        authorization,
        fetchFn,
        clock,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OidcError);
      expect((err as OidcError).code).toBe("expired_token");
    }
  });

  it("fails when the user denies authorization", async () => {
    const { fetchFn } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [DEVICE_URL]: DEVICE_CODE_RESPONSE,
      [TOKEN_URL]: { error: "access_denied" },
    });
    const clock = fakeClock();
    const { authorization } = await deviceAuthorize({
      issuer: ISSUER,
      clientId: "colony-cli",
      fetchFn,
    });
    try {
      await pollDeviceToken({
        tokenEndpoint: TOKEN_URL,
        clientId: "colony-cli",
        authorization,
        fetchFn,
        clock,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OidcError);
      expect((err as OidcError).code).toBe("access_denied");
    }
  });

  it("stops polling once the device code TTL passes", async () => {
    const { fetchFn } = stubFetch({
      [DISCOVERY_URL]: DISCOVERY,
      [DEVICE_URL]: { ...DEVICE_CODE_RESPONSE, interval: 0 },
    });
    const { authorization } = await deviceAuthorize({
      issuer: ISSUER,
      clientId: "colony-cli",
      fetchFn,
    });
    const clock: PollClock = {
      now: () => authorization.expiresAt + 1,
      sleep: () => Promise.resolve(),
    };
    try {
      await pollDeviceToken({
        tokenEndpoint: TOKEN_URL,
        clientId: "colony-cli",
        authorization,
        fetchFn,
        clock,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OidcError);
      expect((err as OidcError).code).toBe("expired_token");
    }
  });
});
