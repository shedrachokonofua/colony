import type { ColonyClient } from "../client.js";
import type { ParsedCommand } from "../args.js";
import { renderTable } from "../render.js";
import { stringFlag } from "../args.js";
import { readTextInput } from "../input.js";

export interface ProjectRow {
  name: string;
  context_doc: string | null;
  created_at: string;
  updated_at: string;
  scope_count?: number;
  file_count?: number;
}

interface ProjectsResponse {
  projects: ProjectRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const name = cmd.positional[0];
  if (!name) return list(client, io);
  const res = await client.get<{ project: ProjectRow }>(
    `/projects/${encodeURIComponent(name)}`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  const { project } = res;
  const lines = [
    `${project.name}`,
    `created: ${project.created_at}`,
    `updated: ${project.updated_at}`,
  ];
  if (project.scope_count !== undefined) lines.push(`scopes:  ${project.scope_count}`);
  if (project.file_count !== undefined) lines.push(`files:   ${project.file_count}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function list(
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const res = await client.get<ProjectsResponse>("/projects", {
    limit: 50,
    offset: 0,
  });
  if (io.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  if (res.projects.length === 0) {
    process.stdout.write("no projects\n");
    return 0;
  }
  const rows = res.projects.map((p) => [
    p.name,
    p.scope_count === undefined ? "-" : String(p.scope_count),
    p.file_count === undefined ? "-" : String(p.file_count),
    p.updated_at,
  ]);
  process.stdout.write(`${renderTable(["name", "scopes", "files", "updated"], rows)}\n`);
  return 0;
}

export async function context(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const name = cmd.positional[0];
  const set = stringFlag(cmd.flags, "set");
  if (set !== undefined) {
    const markdown = await readTextInput(set);
    const res = await client.put<{ project: ProjectRow }>(
      `/projects/${encodeURIComponent(name)}/context`,
      { context_doc: markdown },
    );
    if (io.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`updated context for ${name}\n`);
    return 0;
  }
  const res = await client.get<{ context_doc: string | null }>(
    `/projects/${encodeURIComponent(name)}/context`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(res.context_doc ? `${res.context_doc}\n` : "no context doc\n");
  return 0;
}
