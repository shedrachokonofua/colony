import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, createClient, withQuery } from "./client.js";

interface Captured {
  url: string;
  init?: RequestInit;
}

const calls: Captured[] = [];
const originalFetch = globalThis.fetch;

function stubFetch(respond: (req: Request) => Promise<Response> | Response) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    calls.push({ url: req.url, init });
    return Promise.resolve(respond(req));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

const client = createClient({
  baseUrl: "https://colony.test/",
  token: "tok",
  actor: "human:ada",
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createClient", () => {
  it("builds URLs and serializes query params, omitting undefined", async () => {
    stubFetch(() => json({ ok: true }));
    await client.get("/scopes", { limit: 25, offset: undefined, project: "colony" });
    expect(calls[0]!.url).toBe(
      "https://colony.test/scopes?limit=25&project=colony",
    );
  });

  it("omits the query string entirely when no value survives", async () => {
    stubFetch(() => json({ ok: true }));
    await client.get("/health", { scope_id: undefined });
    expect(calls[0]!.url).toBe("https://colony.test/health");
  });

  it("sends the bearer token and actor headers on every request", async () => {
    stubFetch(() => json({ ok: true }));
    await client.get("/health");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-actor-id")).toBe("human:ada");
    expect(headers.get("x-actor")).toBe("human:ada");
  });

  it("posts and puts a JSON body", async () => {
    stubFetch(() => json({ ok: true }));
    await client.post("/projects/colony/context", { context_doc: "hi" });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe('{"context_doc":"hi"}');
    await client.put("/projects/colony/context", { context_doc: null });
    expect(calls[1]!.init?.method).toBe("PUT");
    expect(calls[1]!.init?.body).toBe('{"context_doc":null}');
  });

  it("throws ApiError with parsed code and message on 4xx", async () => {
    stubFetch(() =>
      json({ error: { code: "NOT_FOUND", message: "scope not found" } }, 404),
    );
    const err = await client.get("/scopes/nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.status).toBe(404);
    expect(api.code).toBe("NOT_FOUND");
    expect(api.message).toBe("scope not found");
  });

  it("falls back to HTTP_<status> when the body is unparseable", async () => {
    stubFetch(() => new Response("not json", { status: 502 }));
    const err = await client.get("/scopes").catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("HTTP_502");
  });

  it("throws ApiError on 401 so the caller can name the credential source", async () => {
    stubFetch(() =>
      json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } }, 401),
    );
    const err = await client.get("/scopes").catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).toBe("UNAUTHORIZED");
  });

  it("returns the raw response for artifact downloads", async () => {
    stubFetch(() => new Response("bytes", { status: 200 }));
    const res = await client.raw("/runs/r1/artifacts/a1");
    expect(await res.text()).toBe("bytes");
  });
});

describe("withQuery", () => {
  it("returns the path untouched without a query", () => {
    expect(withQuery("/audit")).toBe("/audit");
  });

  it("stringifies numbers", () => {
    expect(withQuery("/audit", { limit: 10, before_id: 3 })).toBe(
      "/audit?limit=10&before_id=3",
    );
  });
});
