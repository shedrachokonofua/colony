# Project skills

Status: v1 implemented (2026-09-28). Shipped: `skill_sources` column
(migration 19), `GET/PUT /projects/:name/skills`, per-run resolution with a
SHA-keyed checkout cache (`apps/colonyd/src/runs/skills.ts`), `skills_resolved`
run events, materialization to `.colony/skills/project/<name>/`
(`materializeProjectSkills`), and the listing appended to every role's packet
body (implementer, architect, reviewer, plan reviewer; subagents share the
workspace). Deferred: cache eviction, console settings section, `colony
skills` CLI verb, resume re-resolution (resume reconnects to the existing
sandbox, so skills already written stay).
Date: 2026-09-27

## Goal

A Colony project declares a set of **skills** — instruction directories with a
`SKILL.md`, optionally with sibling reference files — sourced from a git
repository. Every run of that project materializes the skills into the agent
workspace and tells the agent what each one is and when to read it. Example
source: `seven30/meta@main:skills/s30-*` (Seven30's shared `s30-*` skills).

Non-goals: the human-facing Colony CLI skill
(`docs/superpowers/specs/2026-09-27-colony-agent-interface-design.md` uses
"skill" for a different thing — how outside agents drive Colony, not what
Colony's run agents read); skills loaded through the pi SDK's own `loadSkills`
mechanism; per-task skill selection; skill authoring tooling.

## Today (verified against the tree)

### Built-in playbooks

- `COLONY_SKILLS` (`packages/agent-runtime/src/colony-skills.ts:298`): five
  built-ins, each `{file, trigger, content}`.
- `seedPlaybooks()` (`packages/agent-runtime/src/pi-runner-common.ts:269`)
  writes all of them into `.colony/skills/` in the workspace before the engine
  ships it to the sandbox pod, and git-excludes `.colony/` (and
  `.colony/project/`) via `.git/info/exclude`
  (`pi-runner-common.ts:287-301`).
- Role prompts list them via `playbookPrompt()`
  (`colony-skills.ts:328`) as
  `- .colony/skills/<file> — read it <trigger>.`:
  implementer (`pi-runner-common.ts:1122`), architect (`:1193`), reviewer
  (`:1639`), subagent (`:1665`). The plan reviewer gets no playbooks
  (`PLAN_REVIEW_SYSTEM_PROMPT`, `packages/agent-runtime/src/architect-stages.ts:631`).
- The delivery note at `colony-skills.ts:8-12` is load-bearing: the pi SDK's
  skills loader advertises paths on the daemon filesystem, but Colony routes
  the read tool into the sandbox pod, so those paths are unreadable there.
  Colony instead writes files into the workspace, which the pod sees verbatim.

### Project reference files (the precedent to reuse)

- Store: `projects` (`packages/core/src/schema.sql:6`, `context_doc` is the
  brief) and `project_files` (`schema.sql:130`: filename, media_type,
  content, byte_size, sha256). Types `Project` / `ProjectFile`
  (`packages/core/src/store.ts:34`, `:58`).
- HTTP (`apps/colonyd/src/http.ts:497-748`): `GET/PUT
/projects/:name/context` (brief), `GET/POST/PUT/DELETE
/projects/:name/files` (reference files). Limits `MAX_FILE_BYTES = 262144`
  per file and `MAX_PROJECT_FILE_BYTES = 2097152` per project
  (`http.ts:225-226`).
- Packet: `packetProject()` (`apps/colonyd/src/runs/packets.ts:177`) lists
  each file with `path: .colony/project/<filename>`; content rides as a
  **non-enumerable** property so `PACKET.json` and packet bodies stay
  content-free (`packets.ts:205-212`). Prompt:
  `projectFilesSection()` (`:218`) renders
  `## Project reference files (read on demand)`.
- Workspace: `materializeProjectFiles()` (`pi-runner-common.ts:316`) writes
  the files read-only (0444), drops stale files on re-provision, and refuses
  reserved prefixes (`packet.json`, `.colony`, `.git`, `.env`,
  `pi-runner-common.ts:306`) so nothing clobbers `PACKET.json` or the skills
  dirs.
- All five packet builders embed both sections; callers pass
  `store.listProjectFiles(scope.project_name)`
  (`apps/colonyd/src/main.ts:861-902`, `runs/implement.ts:221`,
  `runs/architect.ts:236`, `runs/review.ts:175`, `runs/plan-loop.ts:134`).

### The unwired skill registry

- `discoverSkillRegistry({sourcePaths, mountRoot = "/colony/skills"})`
  (`packages/agent-runtime/src/skill-registry.ts:21`) walks source paths for
  directories containing `SKILL.md`, parses `name` (frontmatter `name` →
  first heading → directory name) and `description` (frontmatter
  `description` → first paragraph), computes a `sha256:` content hash and a
  `mountPath`, and asserts name/mount-path uniqueness (`skill-registry.ts:44-52`).
  `selectSkillMounts()`
  (`:55`) maps names to `SandboxSkillMount`s. Callers: its own tests only.
- `SandboxRunExtensions.skillMounts` (`packages/sandbox/src/run-extensions.ts:36`)
  is validated (read-only, under `/colony/skills`) and carried on the sandbox
  profile (`packages/sandbox/src/sandbox-profile.ts:66`, `:179-180`), but no
  sandbox implementation consumes it: the k8s sandbox mounts exactly one
  volume, the workspace (`packages/sandbox-k8s/src/contract.ts:284`). Mounts
  are a dead end today.

## Design

### 1. Declaration: project skill sources

`projects` gains one nullable JSON column, `skill_sources`. Each entry:

```json
{ "repo_path": "seven30/meta", "ref": "main", "paths": ["skills/s30-*"] }
```

- `repo_path`: GitLab project path on the same GitLab instance the provider
  adapter talks to. Readable with the daemon's existing token (§7).
- `ref`: branch, tag, or full SHA. Branches move; runs pin (§2).
- `paths`: glob patterns relative to the repo root, matched against skill
  directories (directories containing `SKILL.md`). Only `SKILL.md`
  directories are skills; loose files are never picked up.

HTTP, following the context routes' auth/audit conventions:

- `GET /projects/:name/skills` → `{ "skill_sources": [...] }`
- `PUT /projects/:name/skills` → `{ "skill_sources": [...] }` (replace-all;
  `[]` clears). Zod `.strict()` validation; audited as
  `project.skills_updated`. Reads are not audited, like file reads.

Limits on the declaration: at most 8 sources, at most 32 `paths` entries
total. The settings surface (`docs/superpowers/specs/2026-09-04-project-settings-revamp-design.md`)
gains a fourth section, "Skills", listing configured sources; `colony skills
get|set` on the CLI mirrors `colony context`. v1 can ship with just the HTTP
routes and be driven by `colony skills` or curl.

**Name collisions fail resolution**: two skills resolving to the same
registry name (the registry already asserts this,
`skill-registry.ts:47-52`), or a project skill named like a built-in
playbook file stem (`debugging`, `design`, `code-review`, `task-specs`,
`clean-code`) — one namespace under `.colony/skills/`.

### 2. Resolution and caching (daemon side)

New module `apps/colonyd/src/runs/skills.ts`, called where packets are built
(the same call sites that fetch `store.listProjectFiles`); the packet
builders (`packets.ts:240` onward, via `packetProject()`) attach the resolved
manifest. Per source, at packet-build time:

1. **Pin.** `ref` → full commit SHA through the provider adapter's existing
   `commits.get(repo, ref)` (`packages/provider-gitlab/src/index.ts:639`;
   already used for run base SHAs at `apps/colonyd/src/runs/architect.ts:224`
   and `runs/implement.ts:188`). A `ref` that is already a full SHA passes
   through. No provider extension is needed.
2. **Fetch.** Shallow-fetch the pinned SHA into a daemon cache directory
   `data/skills-cache/<repo_path>/<sha>/` (`git fetch --depth 1 origin <sha>`
   - checkout; same git plumbing as `provisionRepoWorkspace`,
     `pi-runner-common.ts:397-493`, clone URL via `resolvePacketCloneUrl`
     `:578-627`). A SHA-pinned cache entry is immutable: a cache hit means no
     network and no invalidation logic. Eviction: simple LRU by mtime, capped
     (e.g. 64 entries). Multi-node alternative: key the entries into the
     existing `ArtifactStore` (`packages/core/src/artifacts.ts`, local
     `data/artifacts` or S3/R2, `packages/config/src/colony-config.ts:199-224`);
     v1's per-node directory cache is enough for a single daemon.
3. **Select + parse.** Filter directories under the cache entry by the
   `paths` globs, then run `discoverSkillRegistry({ sourcePaths: [...] })`
   on the survivors — the registry stays the single authority for name,
   description, and content hash. The manifest carries **every file** of each
   skill directory (`SKILL.md` + siblings; skills like the `s30-*` family
   ship reference files), enumerated from `contentPath`'s directory.
4. **Enforce limits** (§6), **emit evidence**, attach the manifest.

**Pinning and evidence.** Each run records one event through the run audit
sink (`appendEvent`, `packages/agent-runtime/src/audit-sink.ts:22`) as
`skills_resolved`:

```json
{
  "sources": [
    {
      "repo_path": "seven30/meta",
      "ref": "main",
      "resolved_sha": "<full sha>",
      "skills": [{ "name": "s30-db", "hash": "sha256:…", "bytes": 12345 }]
    }
  ]
}
```

The same manifest (including `resolved_sha` per source) is attached to the
packet, so `PACKET.json` is the reproducibility record and run resume
(`packages/agent-runtime/src/run-resume.ts`) replays byte-identical skills.
Each run resolves independently, so skills can drift between the architect
run and a later implementer run exactly like project reference files can
today; pinning per scope is an upgrade, not v1 (Open questions).

**Failure policy.** Declared skill sources are operator intent; a silently
half-delivered set changes what the agents are. Resolution failures fail the
run before it starts, with a precise reason: unresolvable ref, unreadable
repo, an unmatched `paths` entry, name collision, or over-limit. The only
best-effort provisioning left is the built-in playbooks
(`pi-runner-common.ts:302`).

### 3. Reaching the sandbox

**Materialize, do not mount.** `materializeProjectSkills(dir, packet)`
lands next to `materializeProjectFiles` (`pi-runner-common.ts:316`) and is
called from `provisionScratchDir` (`:257`) and `provisionRepoWorkspace`
(`:462`):

- writes `.colony/skills/project/<skill-name>/<files>` read-only (0444),
  whole skill directories including siblings;
- stale-clean and path-safety rules mirror `materializeProjectFiles`
  (skill names are registry slugs, already safe);
- `.colony/` is already git-excluded by `seedPlaybooks`
  (`pi-runner-common.ts:284-289`), so agents can never commit the skills.

Why not the registry mounts: `skillMounts` are validated but nothing consumes
them (§ Today), and the SDK's skills loader is unusable for the same reason
the playbooks carry their delivery note (`colony-skills.ts:8-12`). Writing
into the workspace is the one path every tool in the pod can already read.
`discoverSkillRegistry` earns its place as the metadata + hash authority;
`selectSkillMounts` and `skillMounts` stay unwired and this design does not
touch them.

Packet manifest, mirroring project files:
`project.skills: [{ name, description, hash, path: ".colony/skills/project/<name>", files: [{ path, byte_size, content? }] }]`
— `content` non-enumerable, so `PACKET.json` stays content-free (the
`packets.ts:205-212` trick).

### 4. In the prompt

`projectSkillsPrompt(skills)` beside `playbookPrompt`
(`colony-skills.ts:328`):

```text
# Project skills
- `.colony/skills/project/s30-db/SKILL.md` — read it <trigger>.
```

`<trigger>` is the registry description (frontmatter `description` or first
paragraph, `skill-registry.ts:101-136`), clamped to ~200 chars so a long
description cannot eat the prompt. Same laziness contract as playbooks: the
prompt lists name + trigger, the agent reads the file when the situation
arises.

### 5. Roles

Every repo-required role (`workspaceMode: "repo-required"`,
`pi-base-agent-runner.ts:2273-2360`) gets the files and the listing:
implementer (`buildImplementerSystemPrompt`, `pi-runner-common.ts:1073`),
architect (`:1163`, and `buildArchitectExtensionSystemPrompt`,
`packages/agent-runtime/src/architect-extension.ts:209` — today it carries
neither project sections nor playbooks; the listing goes in anyway since the
extension workspace materializes the same files), reviewer (`:1588`), plan
reviewer (`PLAN_REVIEW_SYSTEM_PROMPT`, `architect-stages.ts:631` — gains the
section even though it has no playbooks today), and subagents
(`buildSubagentSystemPrompt`, `:1650` — they share the delegating agent's
workspace clone, so the files are already visible; the listing keeps them
discoverable). Review dimension subagents inherit the reviewer's workspace
the same way.

### 6. Size limits

Reuse the project-file numbers so operators hold one model
(`apps/colonyd/src/http.ts:225-226`):

- 256 KiB per file;
- 2 MiB total across all skills of a project (SKILL.md + siblings counted);
- at most 32 skills per project, 8 sources per project, 16 files per skill
  directory.

Over limit is a resolution failure (§2). Project reference files keep their
own 2 MiB budget.

### 7. Auth

One token, already configured: `GITLAB_TOKEN` (+ `GITLAB_BASE_URL`), declared
in `packages/config/src/index.ts:33` and wired to `GitLabProviderAdapter` at
daemon start (`apps/colonyd/src/main.ts:141-143`). Packet clone credentials
are separate: per-run minted project access tokens
(`apps/colonyd/src/runs/tokens.ts:22-53`, falling back to the shared token in
single-token mode) spread into `repo.credentials` at packet build
(`packets.ts:27-30`). Skill resolution runs daemon-side with the adapter
token, in API headers or the existing `resolvePacketCloneUrl` helper
(`pi-runner-common.ts:578-627`) — it never enters the packet, the prompt, the
workspace, or evidence. v1: skill sources live on the same GitLab instance
as the project's repositories; other forges need a provider extension and
are out of scope.

### 8. Tests

Unit (bun:test, existing conventions):

- Resolution (`apps/colonyd/src/runs/skills.ts` tests) with a fake provider:
  ref→SHA pinning (branch resolved, full SHA passthrough), glob→skill-dir
  matching (non-`SKILL.md` dirs skipped, unmatched pattern fails), collisions
  (across sources; project vs built-in), limit enforcement, `skills_resolved`
  event shape.
- Cache: hit skips fetch, distinct SHAs coexist, LRU eviction.
- Materialization (extend `project-files-materialize.test.ts` patterns):
  read-only files at `.colony/skills/project/<name>/`, stale dir dropped on
  re-provision, reserved prefixes, `JSON.stringify(packet)` contains no
  content.
- Prompt: `projectSkillsPrompt` clamping and presence in the four role
  prompts + subagent prompt (extend existing prompt tests); registry
  behavior stays pinned by `run-extensions.test.ts`.

Integration: a packet-build test with the fake runtime
(`main.ts:139` fake path) asserting manifest + evidence row; one
runner-level test that `provisionRepoWorkspace` writes the skills beside the
playbooks (extend `colony-skills.test.ts` patterns).

## Alternatives considered

- **CI sync**: a job in the skills repo upserting `SKILL.md`s into Colony
  project reference files. Rejected: no SHA pinning or run evidence, content
  duplicated out of its source of truth, no name/description triggers,
  removals need a bot run. (Nothing of this was implemented — see the
  delivery report.)
- **Mounting via `SandboxSkillMount`**: nothing consumes mounts (§ Today);
  per-skill k8s volumes would make skills a pod-spec concern for no gain over
  workspace files.
- **Fetching inside the sandbox**: puts the GitLab token in the pod and makes
  every run mid-flight network-dependent.
- **Per-task skill selection**: config surface with no demonstrated need;
  skills are small and read on demand.

## Dogfooding: a Colony scope against Colony's own repo

Yes. The colony repo is a provider repo like any other, so a scope against it
works: goal "implement project skills per `docs/designs/001-project-skills.md`"
produces an architect DAG (core schema + migration, provider-gitlab
`resolveCommit`, colonyd `runs/skills.ts` + routes, agent-runtime
materialize + prompt + tests), implementers land it on a branch, review
loops, colonyd opens the MR. Notes: (1) the design doc lives in-repo, so the
architect reads it during mandatory exploration — no reference file needed;
(2) acceptance commands must run in the minimal validation sandbox, which
the architect's acceptance format already demands; (3) `colony.gate.yaml`
(frozen install, lint, typecheck, unit tests) is the merge standard; (4) the
smoke test is self-hosted: point a demo project's `skill_sources` at
`seven30/meta@main:skills/s30-*`, open a scope, and verify the workspace,
the prompt listing, and the `skills_resolved` evidence row.

## Open questions

- Per-scope pinning: resolve once when the scope opens and reuse for all its
  runs (needs a place to store the resolved SHA — a scope column or a
  `scope_skill_sources` row). Consistency win; v1 resolves per run.
- Cache GC metrics and disk cap in production ops.
- Whether the plan reviewer should also get the built-in playbooks (today it
  gets none). Independent of this design.
