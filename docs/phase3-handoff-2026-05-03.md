# Phase 3 acceptance — handoff (2026-05-03)

This doc captures the state of work-in-progress on `acceptance:phase3` after a
multi-hour session driving the new task-planning gate end-to-end against the
homelab GitLab. Pick this up by reading top-to-bottom, then follow "How to
resume" at the bottom.

## TL;DR

- The new per-task plan gate (`claimed → plan_proposed → plan_review →
in_progress`) is wired up in `apps/worker/src/task-planning.ts` and proven
  to drive a real GitLab project end-to-end. Across 8 phase3 runs, individual
  tasks completed `draft → … → closed` with merged MRs, and one task even
  exercised the plan-rework loop after the plan reviewer requested changes.
- The lifecycle, activities, packets, envelopes, audit trail, and DB
  transitions are correct against a real provider + real LLMs.
- The acceptance script (`scripts/phase3-acceptance.ts`) is currently the
  orchestrator stand-in — Temporal workflow wiring is open work
  (see Open Tasks #2).
- Three blockers were hit + fixed during this session; one is still open
  (intermittent `405 Method Not Allowed` on GitLab MR merge).
- User's design direction landed: **strict reviewer + near-unbounded refinement
  loop with reviewer feedback piped into the planner on rework**. This is
  Open Task #3 and is the next big code change.

## Continuation update

Implemented after this handoff was written:

- Planner packets now carry typed `planning_context` on rework:
  `previous_developer_plan`, `previous_plan_review`, and the latest persisted
  code-review envelope.
- Reviewer runs persist their latest review envelope on `tasks` so the next
  planner pass has concrete feedback instead of relying on audit spelunking.
- Phase 3 acceptance no longer force-approves strict reviewer rejections. It
  loops through plan → plan review → developer → code review up to a high cap.
- Temporal supervisor workflow now owns the same bounded refinement loop, with
  a `COLONY_TEMPORAL_TEST=1` SDK-backed test covering plan-gate ordering across
  a reviewer-requested rework.
- Developer plan and plan-review digests are posted back to the task issue as
  human-readable comments.
- Generated packet schemas were refreshed for the new planning context.

## What this session changed (uncommitted)

`git status --short`:

```
 M apps/worker/src/prompts/developer.ts
 M apps/worker/src/prompts/prompts.test.ts
 M apps/worker/src/prompts/reviewer.ts
 M apps/worker/src/task-planning.ts
 M packages/provider-gitlab/src/index.ts
 M scripts/phase3-acceptance.ts
```

Plus a local-only edit to `config/colony.yaml` (gitignored).

### `apps/worker/src/task-planning.ts`

- `startDeveloperPlanRun` now accepts `task.state === "plan_proposed"` as a
  valid input state (rework after plan reviewer's `changes_requested`).
  Previously only accepted `claimed` / `changes_requested`.
- When invoked from `plan_proposed`, it skips the trailing
  `updateTaskState(plan_proposed → plan_proposed)` (illegal same-state
  transition) and just refreshes the envelope.
- `PLAN_REVIEW_LOOP_CAP_DEFAULT` raised from `3` → `50` per user direction
  ("make limits high for now, we are still beginners").

### `scripts/phase3-acceptance.ts`

- After `claimTask`, drives the plan gate explicitly: calls
  `createStartDeveloperPlanRun` (using `agentRuntime.developerPlanner`) then
  `createStartPlanReviewRun` (using `agentRuntime.planReviewer`) before
  invoking the developer. Loops up to 3 times if plan review returns
  `changes_requested` (then asserts approved).
- The "force-approve for acceptance" shortcut now walks the legal state
  sequence `changes_requested → plan_proposed → plan_review → in_progress →
review_requested` instead of jumping `changes_requested → in_progress`
  (which the state machine refuses now that the plan gate is in the path).
- Merge retry loop expanded from 6 attempts × linear 1s/2s/3s/... backoff to
  8 attempts × 3s/6s/9s/... (≤108s total). Logs each retry with attempt
  number and backoff. The merge-failure assertion now surfaces
  `mergeResult.reason` (was previously a bare "merge failed for X").

### `apps/worker/src/prompts/developer.ts` + `reviewer.ts`

- Changed `post_progress_note` from "When the tool is available, use it" to
  **"You MUST call `post_progress_note` at least once before submitting"**.
- Snapshots in `prompts.test.ts` regenerated.
- **Caveat**: this prompt change is NOT sufficient on its own. In run 8 the
  coder hit `max_turns` exhaustion before reaching its wrap-up tool calls, so
  it never called `post_progress_note` _or_ `submit_developer_completion`.
  See the `max_turns` discussion below.

### `packages/provider-gitlab/src/index.ts`

- `request<T>` now includes the response body's `message` / `error` field in
  the thrown `GitLabProviderError` message. Previously the message was just
  `GitLab METHOD path returned 405` with no GitLab-side context. Now it's
  e.g. `GitLab PUT /projects/.../merge returned 405: 405 Method Not Allowed`.
  This is the only reason we know the 405 body is the literal GitLab status
  text, which informs the diagnosis below.

### `config/colony.yaml` (local-only, gitignored)

Per-role ceilings raised:

| Role      | timeout_ms           | max_turns    | max_usd_per_run |
| --------- | -------------------- | ------------ | --------------- |
| developer | 1800000 (was 900000) | 250 (was 60) | 50 (was 10)     |
| reviewer  | 1800000 (was 600000) | 200 (was 30) | 30 (was 5)      |
| architect | 1800000 (unchanged)  | 200 (was 80) | 50 (was 25)     |

Memory consolidator left unchanged.

## What's been proven in real runs

Across 8 phase3 runs:

- **Architect ↔ decomp-reviewer iteration** converges. Run 6 took 2 architect
  attempts (reviewer rejected first); run 7 + 8 converged on attempt 1.
- **Plan gate runs cleanly per task.** Each task gets its own
  `pi-developer-plan-N` runner (separate sandbox) producing a
  `developer_plan` envelope, then a `pi-plan-review-N` runner approving or
  requesting changes. State transitions:
  `claimed → plan_proposed → plan_review → in_progress`.
- **Plan-rework loop engaged.** Run 6 task 3 had its initial plan rejected by
  the plan reviewer; rework cycle ran (planner-2 produced a revised
  envelope, plan-reviewer-2 approved), task proceeded to coding.
- **Coder + code-reviewer + merge** proven on multiple tasks (run 6: tasks
  1, 2, 3 went `draft → … → closed` with merged GitLab MRs).
- **Audit trail is complete.** `audit_log` rows for force-approve overrides,
  agent-token mint/revoke, gate evaluation, MR merge — all present.
- **Plan envelope is stored and inspectable.** Pull with:
  ```
  docker exec colony-postgres psql -U colony -d colony -At -c \
    "SELECT jsonb_pretty(developer_plan_envelope) FROM tasks WHERE id = 'col-...';"
  ```
  Plan reviewer envelope similarly at `plan_review_envelope`.

## Open issues

### 1. Intermittent `405 Method Not Allowed` on MR merge (UNDIAGNOSED)

- Run 6: tasks 1, 2, 3 merged cleanly; task 4 hit 7×405. Run 7: task 1 hit
  8×405 (full retry budget exhausted). Run 8: never reached merge step due
  to issue #2 below.
- The improved error message reveals GitLab returns the literal string
  `405 Method Not Allowed` in the body — i.e. no descriptive `message` field.
  This is what GitLab returns when `PUT /merge_requests/:id/merge` is called
  on an unmergable MR.
- Likely causes (none verified yet):
  - **Pipeline-blocked merge**. Project may default to
    `only_allow_merge_if_pipeline_succeeds=true` against the homelab
    instance. Tasks may now generate `.gitlab-ci.yml` (or a CI runner
    rejection) that wasn't present in earlier runs.
  - **Merge conflicts**. Unlikely for task 1 of a fresh project.
  - **Author-cannot-approve rule**. Reviewer maps to the same GitLab user as
    developer (script only `upsertProviderIdentity` for developer actor).
    But this would have blocked all runs.
  - **Branch protection**. Same as above — should affect everything.
- Run 8 was started with `COLONY_PHASE3_KEEP_GROUP=1` specifically to keep
  the GitLab project alive for forensic inspection of the next 405. But
  run 8 failed earlier (issue #2), so we still don't have a surviving 405
  case.

  **Forensic plan**: re-run with `KEEP_GROUP=1` after fixing #2; when 405
  hits, manually query GitLab `GET /projects/:id/merge_requests/:iid` to
  see `merge_status`, `mergeable_state`, `pipeline.status`, and discussion
  state. Likely actionable from there.

### 2. Coder `max_turns` exhaustion → silent envelope (FIXED via config bump)

- Run 8 task 1: pi-coding-agent-1 hit 61 turns, runner emitted
  `pi_run_limit_exceeded` + `finalize_envelope_no_tool_call`. The agent
  never called `post_progress_note` or `submit_developer_completion`.
- The runner force-finalized with some synthetic envelope and the script
  proceeded past the developer step, then crashed on the
  `assertAgentProgressNoteOnIssue` check (which gave the user-visible
  symptom: "missing agent progress note with prefix [colony:...]").
- **Mitigation in this session**: developer `max_turns` raised 60 → 250 in
  `config/colony.yaml`. Reviewer/architect also bumped (table above).
- **Robustness gap still open**: when the runner exhausts `max_turns`
  without an envelope, it returns "succeeded" enough that the script
  proceeds. Should return `envelope_status: "failed"` and let the script
  fail fast with a clear reason. That's a runner change in
  `packages/agent-runtime/src/`, not yet done.

### 3. Reviewer too strict (DESIGN DECISION — keep strict)

- The bot reviewer (`pi-mono` runner on gpt-5.5 thinking_level=high)
  consistently returns `changes_requested` on first review of even
  reasonable code.
- The script's existing answer was a "force-approve for acceptance" shortcut
  that walked synthetic state transitions to fake an approval.
- **User decision**: keep strict reviewer. Drive the real refinement loop
  with near-unbounded iterations. Build reviewer-feedback wiring into the
  planner so the loop converges instead of cycling. See Open Task #3.

## Confirmed design decisions (from this session)

1. **Visibility**: developer plan + plan review envelopes should be posted as
   human-readable summaries on the GitLab issue. Not verbatim JSON — a
   digest. Comment is the path (UI page is not). See Open Task #1.
2. **Workflow vs script**: phase3 acceptance script is _only_ the
   orchestrator stand-in. The real Temporal workflow needs to wire the plan
   gate the same way, with a workflow-level test exercising it. See
   Open Task #2.
3. **Refinement loop**: full re-plan cycle on `changes_requested`
   (option (a) from the discussion). Planner needs reviewer feedback in its
   packet on rework — without that, planner re-runs produce the same plan
   and the loop never converges. See Open Task #3.
4. **Limits "high for beginners"**: per-role ceilings raised; iteration cap
   raised. Agent ceilings are config (already done locally); iteration cap
   is in code (already raised to 50).

## Open Tasks (in `TaskList`)

### #1 — Post human-readable plan + plan_review summaries as GitLab issue comments

In `apps/worker/src/task-planning.ts`, after `recordDeveloperPlan` and
`recordPlanReview`, render a markdown digest (rationale, approach,
files_to_touch, tests_to_add, risks, confidence, risk_level for the plan;
result + decisions/notes for the review) and call
`adapter.issues.addNote()` on the task's primary mirror. Mirrors the
existing `post_progress_note` audit pattern.

### #2 — Wire plan gate into Temporal workflow + add workflow-level lifecycle test

`packages/workflows/src/index.ts` may not yet wire the new
`developer_planner` + `plan_reviewer` activities between claim and
developer. Verify, wire if missing, and add a test in
`packages/workflows/src/index.test.ts` that drives a fake task graph
through the plan gate using `TestWorkflowEnvironment` +
`FakeAgentRuntimeAdapter`. Test must fail if plan gate is skipped.

### #3 — Real refinement loop on `changes_requested` with reviewer feedback wired into planner

The big one. Subtasks:

1. **`apps/worker/src/task-planning.ts`** — wire reviewer feedback into the
   planner packet when state is `plan_proposed` / `changes_requested`:
   - `previous_developer_plan` envelope (already on `tasks` row)
   - `previous_plan_review` envelope (already on `tasks` row)
   - **`code_review_envelope`** (the actual rejection that caused this rework
     cycle) — needs a place to be persisted; currently only in audit. Could
     add `tasks.last_code_review_envelope` column or query latest
     `task.review_envelope.recorded` audit row by `task_id`.

2. **`apps/worker/src/reviewer-run.ts`** — on `changes_requested`, persist
   the reviewer envelope where the next planner run can read it.

3. **`scripts/phase3-acceptance.ts`** — remove the force-approve shortcut.
   Replace with a real loop: if reviewer says `changes_requested`, re-enter
   the per-task lifecycle (re-plan, re-plan-review, re-code, re-review)
   until approved or a hard cap (~50). Phase3 acceptance becomes a true
   end-to-end converge-or-fail test.

4. **`apps/worker/src/prompts/developer.ts` + `reviewer.ts`** — soften the
   "MUST call `post_progress_note`" instruction back to a strong "should",
   and accept that visibility is now task #1's job (markdown summary
   posted by the orchestrator after envelope recording, not by the agent).
   Or alternatively keep "MUST" and add a runtime check that rejects
   envelopes without an accompanying progress note. Pick one.

5. **`packages/agent-runtime/src/`** — when `max_turns` exhausts without an
   envelope, return `envelope_status: "failed"` instead of synthetically
   succeeding (related to issue #2 above).

6. Tests:
   - `task-planning.ts`: rework path with reviewer envelope present in packet.
   - Update `prompts.test.ts` snapshots if prompt text changes.
   - Workflow tests if applicable.

Order: subtask 1 (planner packet wiring) is load-bearing — without it,
subtask 3 (drop force-approve) doesn't converge. Do them together.

## Environment state at handoff

- **Postgres + Temporal**: up via `task up` (containers
  `colony-postgres`, `colony-temporal`, `colony-temporal-ui`).
- **Migration `1761350000014_task-plan-gate`**: applied.
- **Dev services** (`task dev`): may or may not still be running depending
  on when this is read. Check with
  `lsof -P -iTCP -sTCP:LISTEN | grep -E ':3000|:4000|:4100|:4200'`.
- **Bao token**: cached in `~/.colony-toolbox/bao/token`. Check with
  `nix develop --command ./scripts/bao-login.sh --status`. If expired, run
  `nix develop --command task bao:login` (interactive Keycloak device
  flow — must be a human at the terminal).
- **Surviving GitLab project**: `colony-phase3-moq0jsvx` (run 8) was started
  with `COLONY_PHASE3_KEEP_GROUP=1` and not torn down. It has the spec MR
  merged and task 1's MR open (developer pushed but never submitted
  envelope due to `max_turns`). Useful for inspecting how the dev coder's
  partial-output state looks. Project lives at
  `<gitlab-base>/colony-phase3-moq0jsvx/echopress`.

## How to resume

```sh
# 1. Check stack
docker ps                           # postgres + temporal up?
nix develop --command ./scripts/bao-login.sh --status

# 2. Bring up if needed
nix develop --command task up
nix develop --command task bao:login    # if token rejected — interactive
DATABASE_URL=postgres://colony:colony@localhost:5432/colony npm run db:migrate

# 3. Restart dev services with current code
pkill -f 'tsx watch'; pkill -f 'vite dev'
nix develop --command task dev > /tmp/colony-logs/dev.log 2>&1 &

# 4. Start work on Task #3 (the big one)
#    Recommended subtask order:
#    1.  Add code_review_envelope column or persistence path (subtask 1+2).
#    2.  Wire reviewer envelope into planner packet (subtask 1).
#    3.  Drop force-approve in phase3-acceptance.ts (subtask 3).
#    4.  Decide on progress-note enforcement (subtask 4).
#    5.  Patch runner max_turns failure mode (subtask 5).
#    6.  Tests.

# 5. After Task #3, re-run phase3 with KEEP_GROUP to also catch the 405:
COLONY_PHASE3_KEEP_GROUP=1 nix develop --command task acceptance:phase3 \
  > /tmp/colony-logs/phase3.log 2>&1 &

# 6. When 405 hits, inspect:
#    GET /projects/<id>/merge_requests/<iid> → check merge_status, pipeline,
#    discussions. With KEEP_GROUP=1 the project survives the failure.
```

## Reference: what each phase3 run proved

| Run | Outcome                                                                                        | Notes                                                                                                |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Failed at `developer_run`                                                                      | `task_not_in_progress:claimed` — script didn't drive plan gate. Fixed in `phase3-acceptance.ts`.     |
| 2   | Failed at force-approve                                                                        | `changes_requested → in_progress` is illegal with plan gate. Fixed: walk legal sequence.             |
| 3   | Failed at planner rework                                                                       | `task_not_ready_for_plan:plan_proposed` — planner refused rework state. Fixed in `task-planning.ts`. |
| 4   | Failed at `assertAgentProgressNoteOnIssue`                                                     | Coder didn't post note. Mitigated via prompt tightening, but real cause was `max_turns`.             |
| 5   | Interrupted by power outage.                                                                   | —                                                                                                    |
| 6   | Tasks 1–3 ✓, **task 4 hit 405** at merge.                                                      | First evidence of the merge issue.                                                                   |
| 7   | **Task 1 hit 405** at merge.                                                                   | Confirmed the 405 isn't task-position dependent.                                                     |
| 8   | Failed at progress note assertion (`max_turns` exhaustion). KEEP_GROUP=1, never reached merge. | Surviving project for forensics.                                                                     |

## Tone

The architecture is right. Activities, packets, envelopes, state machine,
audit trail, scoped tokens, agent-runtime profile system — all good.

The two stalls hurting end-to-end convergence are:

- **Reviewer too strict** → fix is task #3 (real refinement loop).
- **GitLab 405 on merge** → undiagnosed, needs a surviving MR to inspect.

Once #3 is in and the 405 cause is named, this should be self-driving on a
real scope without script-level shortcuts.
