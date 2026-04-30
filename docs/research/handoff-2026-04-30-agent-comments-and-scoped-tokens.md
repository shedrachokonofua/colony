# Handoff — Agent ticket-comments + per-task scoped GitLab tokens (2026-04-30)

You are picking up a focused two-piece hardening + UX initiative. Phase 3 unattended is done (see `docs/research/handoff-2026-04-29.md` for the prior state). This handoff is self-contained — read cold, then start.

## TL;DR

Two pieces of work that ship together:

1. **Per-task scoped GitLab token** — replace the master `GITLAB_TOKEN` baked into every clone URL with a project access token minted at task-claim time, scoped to one project, narrow scopes, with TTL. Revoked at task close.
2. **Typed `post_progress_note` tool** — give the developer (and likely reviewer/architect) Pi-runtime agents a one-arg tool to post running notes to the task's provider issue / MR, using the per-task token for auth.

They pair because the comment tool needs `api` scope on the token, and scoping the token first makes the comment tool safe-by-construction.

The motivating constraint, set in this session: **ephemeral running notes belong in the envelope or the provider ticket, NEVER as files in the repo. Long-term doc artifacts (ADRs, READMEs, API refs) get checked in only when the packet's acceptance criteria explicitly require it.** This rule is now in `buildDeveloperSystemPrompt` (commit `ad09f92`). The comment tool gives "running notes" a real home so the rule doesn't just suppress signal — it redirects it.

## Recent commits (reference)

- `ad09f92` Phase 3 unattended pass + tighter dev/reviewer/architect prompts
- `b6f5ba2` Rework bench-runners into a developer work-product bench

Both pushed to `origin/main`. typecheck + lint clean, 134 unit tests pass.

## Why this work, in order

### Threat model — the current state

`packages/agent-runtime/src/pi-coding-agent-runner.ts:332-345` (`buildAuthenticatedRepoUrl`):

```ts
const token =
  process.env["GITLAB_TOKEN"] ?? process.env["GITLAB_BOT_ENGINE_TOKEN"];
if (token && (url.protocol === "https:" || url.protocol === "http:")) {
  url.username = "oauth2";
  url.password = token;
}
```

This master token is pulled from the worker's process env (sourced from `secrets/dev.yaml` via sops), baked into every clone URL across all tasks, scopes, and projects. The agent has `bash` in its toolset (`DEFAULT_DEVELOPER_TOOLS` in the same file), can `git remote get-url origin` or `cat .git/config` to read the token, and can `curl` anywhere on the internet. **The master token can touch every project the colony bot account has access to on the GitLab instance, with no expiry.** Blast radius if the agent (or a prompt-injection from a provider comment) goes rogue: everything, indefinitely.

There is a `sanitizeSecret` helper (line 349) that redacts the secret from logged tool outputs, but that's log hygiene, not a security boundary.

### Target state

- **Token**: project access token, scoped to the single target project, scopes `write_repository` (push) + `api` (comments), TTL ≈ task lifetime + small buffer (e.g., 1 hour). Minted by the supervisor at claim, baked into the clone URL the runner sees, revoked at task close.
- **Comment tool**: typed Pi tool, agent calls `post_progress_note(body)` with auto-prefix (task ID), light rate-limit, body sanitization (defense-in-depth — even if the per-task token is short-lived, no point shipping it in a comment by accident).

If the agent leaks the per-task token via the comment tool, bash, or a malicious commit message, the leak is bounded to one project for one task window (≤ ~1 hour).

## Why this pairs naturally

- The comment tool needs `api` scope on the GitLab token. We have to touch the token plumbing anyway.
- Stronger prompt rule about "no notes/docs in the diff" (just shipped) needs an alternative channel for the agent's running commentary, otherwise the agent may either (a) sneak notes into commit messages or rationale prose, or (b) lose useful intermediate state that humans actually want to see.
- The Symphony research note (`docs/research/openai-symphony-learnings.md`) makes a similar point: trackers are the right place for running state, not the repo or the envelope.

---

## Piece A — Per-task scoped GitLab token

### What GitLab gives us

- **Project access tokens** are the right primitive: scoped to a single project, custom scopes, custom expiry. Available on self-managed Free tier as of GitLab 14.7 (homelab is current).
- API: `POST /projects/:id/access_tokens` to mint, `DELETE /projects/:id/access_tokens/:token_id` to revoke. Body for mint:
  ```json
  {
    "name": "colony-task-<task_id>",
    "scopes": ["api", "write_repository"],
    "access_level": 30, // Developer; Maintainer (40) only if you need to edit protected branches
    "expires_at": "2026-05-01" // YYYY-MM-DD; max ~1 year, will round up to end-of-day
  }
  ```
- The minting credentials must have Maintainer/Owner perms on the project. Today's master `GITLAB_TOKEN` already does — use it on the supervisor side.

**Caveats from the GitLab docs / our adapter**:

- `expires_at` is date-only (no time). Smallest TTL is ~24h. That's fine — we still revoke explicitly at task close; expiry is the safety net for the orphan case.
- The minted token's project ID is exposed in the response — store it on the task row so revoke can find it.
- Project access tokens count against the project's bot-user quota. Homelab has ample headroom; SaaS tenants will not. Budget concern, not a blocker.

### Architecture sketch

**Supervisor side (worker activity layer)**:

1. New activity `mintTaskAccessToken({ taskId, projectId })` → returns `{ token, tokenId, expiresAt }`. Called by the supervisor when transitioning a task `ready → claimed`.
2. Persist on the task row: new columns `agent_token_id` (the GitLab token's numeric ID, for revoke), `agent_token_expires_at`. Don't persist the secret itself — pass it through to the runner via env, never write it to Postgres.
3. New activity `revokeTaskAccessToken({ taskId })` → called from `closeTask` and from the `closeScope` failure path / sweeper. Idempotent (404 → ok).
4. Sweeper: a periodic job that scans `tasks` for `state IN ('closed', 'merged')` with non-null `agent_token_id` and revokes them. Belt and suspenders for the case where the close-time revoke failed.

**Adapter side**:

- `ProviderAdapter` already has `repos.*`, `mergeRequests.*`, `issues.*`, etc. Add `accessTokens.{mint,revoke}` to the GitLab adapter (`packages/provider-gitlab/src/...` — find the existing adapter shape, mirror it).
- For non-GitLab providers (none today, but the abstraction matters): `accessTokens` is optional; if absent, fall back to the master-token path. Document that fallback as "not for production multi-tenant."

**Runner side (`packages/agent-runtime/src/pi-coding-agent-runner.ts`)**:

- `buildAuthenticatedRepoUrl` currently reads `process.env["GITLAB_TOKEN"]`. Change it to take the token from `request.packet.repo.credentials?.token` (or similar — pick a packet field that's already plumbed, or add one). The supervisor injects the per-task token into the packet before invoking the runner.
- Update `developer-run.ts` (`apps/worker/src/developer-run.ts`) to mint at the right state transition, attach the token to the packet, and revoke after envelope handling.
- Logging: keep `sanitizeSecret` running; the per-task token is short-lived but should still never appear in logs.

### Open design decisions for whoever picks this up

1. **Where does the token live in the packet?** Adding a `credentials` field to the task packet schema (`@colony/schemas`) is the cleanest answer but it's a versioned schema bump. The lazy answer is sneaking it through env var on the runner subprocess. The right answer is the schema bump — packets are the durable record of "what was the agent told?" and credentials are part of that.
2. **One token per task, or one per scope?** Per-task is cleaner (revoke at close, narrow blast radius). Per-scope is fewer GitLab API round-trips. Recommend per-task — round-trips are cheap, blast radius is the point.
3. **TTL strategy.** GitLab's date-only `expires_at` forces ≥24h. Recommend mint at claim with `expires_at = today + 2 days`, revoke explicitly at close, sweeper cleans orphans daily. The 2-day window handles overnight-stuck tasks without needing a renewal flow.
4. **Acceptance-script throwaway projects.** `scripts/phase3-acceptance.ts` deletes the entire group at the end. Project-scoped tokens die with the project — explicit revoke is unnecessary in that path but harmless. Keep the revoke call; it makes the prod path the same as the test path.
5. **Failure modes.** Mint fails → task can't claim. Revoke fails → orphan token (sweeper handles, but watch for token-quota exhaustion alerts). Token expires mid-run → push fails halfway through. Mitigate (4) via the 2-day TTL; observe via supervisor metric on `mint_failed` / `revoke_failed`.

### Code touch points

- `packages/agent-runtime/src/pi-coding-agent-runner.ts` (lines 320-355) — `buildAuthenticatedRepoUrl`, `provisionDeveloperWorkspace`. Stop reading `GITLAB_TOKEN` from env; take the token from the packet.
- `packages/schemas/src/...` — add `credentials` to the relevant packet schema(s). Generate JSON schema (`npm run schemas:generate`).
- `packages/provider/src/...` — extend `ProviderAdapter` with `accessTokens` namespace.
- `packages/provider-gitlab/src/...` — implement against GitLab's `/projects/:id/access_tokens` endpoint. There are existing patterns here for paginated GET and POST-with-body — follow them.
- `apps/worker/src/developer-run.ts` — mint before runner invocation, revoke after.
- `packages/db/src/repository.ts` (or equivalent — find it via grep for `markTaskClaimed`) — add the new columns and update the query helpers.
- New migration: `db/migrations/<n>-task-agent-token.sql` adding `agent_token_id`, `agent_token_expires_at` to `tasks`. Run `task db:migrate`.
- New activity: `apps/worker/src/activities/sweep-orphan-tokens.ts` (mirror an existing periodic activity for shape).

### Test plan

- Unit: mock the adapter, verify `mintTaskAccessToken` is called with the right params at claim, `revokeTaskAccessToken` at close, both are idempotent on retry.
- Integration: real Postgres + a faux provider that records mint/revoke calls. Drive a task through claim → close, assert one mint call, one revoke call, in order.
- Live (extend `acceptance:phase3`): assert that after task close, `GET /projects/:id/access_tokens/:tokenId` returns 404. Assert the runner workspace's `git remote get-url origin` no longer matches the master token.
- Negative: mint fails → task stays `ready`, supervisor logs `mint_failed`. Revoke fails → token stays, sweeper picks it up next tick.

---

## Piece B — `post_progress_note` tool for runners

### Tool shape

Pi tool definition (mirror the pattern in `packages/agent-runtime/src/pi-runner-common.ts` — see `createDeveloperSubmitTool` for a complete example):

```ts
{
  name: "post_progress_note",
  label: "Post a progress note to the task ticket",
  description:
    "Post a short note to the task's provider issue (and MR if open). " +
    "Use this for running commentary — what you tried, what you found, what you're doing next. " +
    "DO NOT use it for the final result — that goes in the envelope summary. " +
    "Treat the note as public; never include secrets, tokens, or env values.",
  parameters: { type: "object", properties: {
    body: { type: "string", minLength: 1, maxLength: 2000 },
  }, required: ["body"] },
  executionMode: "sequential",
  execute: async (_toolCallId, params) => {
    // 1. Sanitize: redact known secret-shaped strings (token from env, etc.)
    // 2. Auto-prefix: "[colony:<task_id>] " + body
    // 3. POST to GitLab REST: /projects/:id/issues/:iid/notes (and MR notes if open)
    // 4. Light rate limit: max ~6 calls per run, return a "rate_limited" error to the agent if exceeded.
    // 5. Return { ok: true, note_id } so the agent sees confirmation.
  }
}
```

### Plumbing

- Tool needs: project ID, issue IID (and MR IID once opened), the per-task token. All three are available in the runner from the packet. **No callback into `developer-run.ts` is required** — handler runs in the runner's Node process and POSTs directly. This is the simplification the user (correctly) flagged: the comment is "over the network anyway."
- Register the tool alongside `submit_developer_completion` in `PiCodingAgentRunner.run` (`packages/agent-runtime/src/pi-coding-agent-runner.ts`). Same pattern as `developerTools`.
- Reviewer + architect runners — they don't have a working tree but they do have a packet with provider IDs. Worth giving them the same tool; reviewer in particular benefits from "I'm checking acceptance criterion 3 against `src/x.ts`" running notes. Low cost to add since the tool is self-contained.

### Prompt updates

In `buildDeveloperSystemPrompt`, after the docs-policy bullet, add something like:

> Use `post_progress_note(body)` for running commentary as you work — what you're checking, what you tried, where you're stuck, what you're doing next. Keep notes terse (one or two sentences). The note is public and untrusted readers may see it; never include secrets, env values, or tokens. Final results still go in the envelope summary, not in notes.

Mirror in `buildReviewerSystemPrompt` and `buildArchitectSystemPrompt` (with role-appropriate examples).

### Open design decisions

1. **Rate limit specifics.** Hard cap ~6 per run is a guess. Watch real runs; tune. Worse than too-restrictive is no cap (the agent could spam the issue with one comment per turn, drowning human reviewers).
2. **Issue vs MR vs both.** The packet identifies the task issue (always exists at runner start) and may identify an MR (only after `developer-run.ts` opens it). Suggest: post to issue always; also post to MR if `packet.mr_id` is set. Two REST calls per note is fine for the rate cap.
3. **Reviewer note ergonomics.** Reviewer reads MRs; they probably want notes on the MR, not the task issue. Decide whether reviewer notes go to MR-only.
4. **Sanitization.** Cheap defense: redact any substring matching the token from env, or matching a known token shape (`/glpat-[A-Za-z0-9_-]{20,}/` for GitLab project access tokens). Belt-and-suspenders given Piece A makes leakage less catastrophic anyway.
5. **Surface in the UI.** The web UI already renders provider issue/MR comments via the mirror tables. Confirm the new agent-posted notes flow through the existing webhook → mirror path so they show up alongside human comments. Likely free, but worth verifying.

### Code touch points

- `packages/agent-runtime/src/pi-runner-common.ts` — new `createPostProgressNoteTool(options)` helper next to the submit-tool factories.
- `packages/agent-runtime/src/pi-coding-agent-runner.ts` — register the new tool when packet has the required provider IDs.
- `packages/agent-runtime/src/pi-runner-common.ts` — three system prompts get the new bullet.
- `apps/worker/src/prompts/developer.ts` + `reviewer.ts` — mirror the rule (these are the worker-side prompts that govern envelope construction; keep guidance consistent).
- New unit test in `packages/agent-runtime/src/pi-runner.test.ts` — assert the tool sanitizes a known-token-shaped string, respects rate limit, returns the right error shape.

### Test plan

- Unit: mock fetch, assert the right URL, headers, body. Assert sanitization. Assert rate-limit returns a structured error to the agent rather than throwing.
- Integration: faux-provider variant that captures notes; drive a fake developer run that calls the tool 3 times; assert notes are persisted and rate-limited.
- Live (extend `acceptance:phase3`): assert at least one note exists on the task issue after the developer step. Assert the note body starts with the auto-prefix.

---

## Where to start

Order matters: do Piece A first, then Piece B. Piece B uses Piece A's token — building B on the master token would just create work to undo.

Suggested first session:

1. Read this whole doc.
2. Read `packages/agent-runtime/src/pi-coding-agent-runner.ts` cold (especially the `buildAuthenticatedRepoUrl` / `provisionDeveloperWorkspace` block).
3. Read the GitLab provider adapter for the existing namespace shape.
4. Decide: schema-bump path (recommended) or env-var path for the token. If schema-bump, write the migration + `@colony/schemas` change first — everything downstream falls out.
5. Implement `accessTokens.{mint,revoke}` in the GitLab adapter against a real homelab project. Verify against `GET /projects/:id/access_tokens` between mint and revoke.
6. Wire mint at claim, revoke at close in `developer-run.ts`. Run `acceptance:phase3` end-to-end.
7. Sweeper second. Then Piece B.

## Things to keep in mind

- `secrets/dev.yaml` has `GITLAB_TOKEN`. That's the supervisor's mint credential — keep it. The agent should never see it after this work lands.
- The acceptance script (`scripts/phase3-acceptance.ts`) deletes the throwaway group at the end. A bug in token revoke won't leak forever in that path; in real use, the sweeper is the safety net.
- Don't push to a real shared GitLab project while testing — homelab only. The mint flow burns project-token quota even if the task fails.
- The runner's `bash` tool is unconstrained inside the cwd. The agent could in principle exfil the per-task token via the comment tool to itself. That's fine — same blast radius as if it pushed a malicious commit. The threat model is "compromised model output," not "trusted agent enforcing the boundary."

## Open punch list (not blocking either piece)

- Token rotation for the supervisor's master mint credential — out of scope here, but worth noting that shrinking the agent's blast radius makes the supervisor's master token the new juicy target. Consider a Vault-issued short-lived credential for the worker process itself, separate effort.
- `provider_oauth_connections` (Codex / Claude Pro OAuth) — unrelated, but the same threat model applies. The OAuth refresh token currently lives in a DB row keyed by user. If you're already in this area, fine to think about, but don't bundle.
- `.claude/scheduled_tasks.lock` is in the repo root — probably needs a `.gitignore` entry for `.claude/`. Untracked today, but easy to forget.
