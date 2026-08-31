import { writeFileSync } from "node:fs";
import type { ColonyClient } from "../client.js";
import { stringFlag, type ParsedCommand, UsageError } from "../args.js";
import { renderTable } from "../render.js";

export interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  key: string;
  ref: string;
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  created_at: string;
}

interface ArtifactList {
  items: ArtifactRow[];
  total: number;
  limit: number;
  offset: number;
}

interface ArtifactRemote {
  error: { code: string; message: string; ref?: string };
}

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const runId = cmd.positional[0];
  const verb = cmd.positional[1];

  if (verb === "get") return download(cmd, client, io);
  return list(runId, client, io);
}

async function list(
  runId: string,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const res = await client.get<ArtifactList>(
    `/runs/${encodeURIComponent(runId)}/artifacts`,
    { limit: 100, offset: 0 },
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  if (res.items.length === 0) {
    process.stdout.write("no artifacts\n");
    return 0;
  }
  const rows = res.items.map((a) => [
    a.id,
    a.kind,
    a.key,
    a.bytes === null ? "-" : String(a.bytes),
    a.content_type ?? "-",
  ]);
  process.stdout.write(`${renderTable(["id", "kind", "key", "bytes", "type"], rows)}\n`);
  return 0;
}

async function download(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const runId = cmd.positional[0];
  const artifactId = cmd.positional[2];
  const out = stringFlag(cmd.flags, "o") ?? stringFlag(cmd.flags, "output");
  if (!out) throw new UsageError("artifacts get requires -o FILE");

  const res = await client.raw(
    `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await res.json()) as ArtifactRemote;
    if (body?.error?.code === "ARTIFACT_REMOTE") {
      if (io.json) {
        process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      } else {
        process.stdout.write(`artifact is remote: ${body.error.ref ?? body.error.message}\n`);
      }
      return 0;
    }
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, bytes);
  if (io.json) {
    process.stdout.write(
      `${JSON.stringify({ path: out, bytes: bytes.byteLength }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`wrote ${bytes.byteLength} bytes to ${out}\n`);
  }
  return 0;
}
