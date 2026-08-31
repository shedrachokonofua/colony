import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../args.js";
import {
  captureStdout,
  fakeClient,
  json,
  parseJsonOut,
  response,
} from "../fakes.js";
import { run, type ArtifactRow } from "./artifacts.js";

const IO = { json: false, isTty: false };

const ARTIFACTS: ArtifactRow[] = [
  {
    id: "art-1",
    run_id: "x",
    kind: "log",
    key: "run.log",
    ref: "file:///tmp/run.log",
    sha256: "deadbeef",
    bytes: 128,
    content_type: "text/plain",
    created_at: "2026-08-30T10:00:00.000Z",
  },
  {
    id: "art-2",
    run_id: "x",
    kind: "diff",
    key: "patch.diff",
    ref: "file:///tmp/patch.diff",
    sha256: null,
    bytes: null,
    content_type: null,
    created_at: "2026-08-30T10:01:00.000Z",
  },
];

let tempDir: string | undefined;

function tempPath(name: string): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "colony-artifacts-"));
  return join(tempDir, name);
}

afterEach(() => {
  if (tempDir === undefined) return;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function listRoutes(items: ArtifactRow[] = ARTIFACTS) {
  return {
    "get /runs/x/artifacts": json({
      items,
      total: items.length,
      limit: 100,
      offset: 0,
    }),
  };
}

describe("artifacts", () => {
  it("lists with limit 100 offset 0 and renders id/kind/key/bytes/type", async () => {
    const { client, calls } = fakeClient(listRoutes());
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["artifacts", "x"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/runs/x/artifacts");
    expect(calls[0]!.query).toEqual({ limit: 100, offset: 0 });
    expect(out.text()).toBe(
      [
        "id     kind  key         bytes  type",
        "art-1  log   run.log     128    text/plain",
        "art-2  diff  patch.diff  -      -",
        "",
      ].join("\n"),
    );
  });

  it("lists the honest API JSON with --json", async () => {
    const { client } = fakeClient(listRoutes());
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["artifacts", "x", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    const parsed = parseJsonOut(out.text()) as {
      items: ArtifactRow[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(parsed).toEqual({
      items: ARTIFACTS,
      total: 2,
      limit: 100,
      offset: 0,
    });
  });

  it("writes the raw bytes to -o FILE", async () => {
    const target = tempPath("out.bin");
    const { client, calls } = fakeClient({
      "get /runs/x/artifacts/art-1": response(new Response("bytes")),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["artifacts", "x", "get", "art-1", "-o", target]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/runs/x/artifacts/art-1");
    expect(readFileSync(target, "utf8")).toBe("bytes");
    expect(out.text()).toBe(`wrote 5 bytes to ${target}\n`);
  });

  it("reports a remote artifact and writes no file", async () => {
    const target = tempPath("remote.bin");
    const payload = {
      error: { code: "ARTIFACT_REMOTE", message: "m", ref: "s3://bucket/key" },
    };
    const { client } = fakeClient({
      "get /runs/x/artifacts/art-1": response(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["artifacts", "x", "get", "art-1", "-o", target]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text()).toBe("artifact is remote: s3://bucket/key\n");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects `get` without -o at parse time", () => {
    expect(() => parseArgs(["artifacts", "x", "get", "art-1"])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(["artifacts", "x", "get", "art-1"])).toThrow(
      "artifacts get requires --o",
    );
  });
});
