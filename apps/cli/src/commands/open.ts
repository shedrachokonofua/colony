import type { ColonyClient } from "../client.js";
import { stringFlag, UsageError, type ParsedCommand } from "../args.js";
import { readText } from "../io.js";
import type { ProjectRow } from "./projects.js";

interface ProjectsResponse {
  projects?: ProjectRow[];
  items?: ProjectRow[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedScope {
  id: string;
  title: string | null;
  status: string;
}

/** Page size for the known-project scan; the server caps limit at 100. */
const PROJECT_PAGE = 100;

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  // Validate every flag before any I/O: a missing --repo must exit 2 even
  // when the goal would come from a hanging stdin.
  const repoPath = stringFlag(cmd.flags, "repo");
  if (repoPath === undefined) {
    throw new UsageError(
      "open requires --repo PATH (the git repository to work in)",
    );
  }
  const goal = await readText(cmd.positional[0]!);
  if (goal.trim() === "") {
    throw new UsageError(
      "goal is empty — pass a markdown file or `-` for stdin",
    );
  }
  const title = stringFlag(cmd.flags, "title");
  const project = stringFlag(cmd.flags, "project");
  if (project !== undefined && cmd.flags["create-project"] !== true) {
    const known = await knownProjects(client);
    if (!known.includes(project)) {
      process.stderr.write(
        `unknown project "${project}" — known projects: ${known.join(", ") || "(none)"}\n`,
      );
      return 2;
    }
  }

  const scope = await client.post<CreatedScope>("/scopes", {
    goal,
    ...(title !== undefined ? { title } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(cmd.flags.manual === true ? { approvals: "manual" } : {}),
    repo: { path: repoPath },
  });

  if (io.json) {
    process.stdout.write(`${JSON.stringify(scope, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `opened ${scope.id}${scope.title ? ` — ${scope.title}` : ""} (${scope.status})\n`,
  );
  return 0;
}

/** Every live project name, walking all pages of GET /projects. */
async function knownProjects(client: ColonyClient): Promise<string[]> {
  const names: string[] = [];
  let offset = 0;
  for (;;) {
    const res = await client.get<ProjectsResponse>("/projects", {
      limit: PROJECT_PAGE,
      offset,
    });
    const items = res.items ?? res.projects ?? [];
    names.push(...items.map((p) => p.name));
    offset += items.length;
    if (items.length === 0 || offset >= res.total) return names;
  }
}
