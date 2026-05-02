# ADR-008: Agent autonomy vs orchestration code

**Status:** Proposed
**Date:** 2026-04-30

## Context

The colony worker has accumulated decision logic that duplicates judgment the
agents should be making. Examples currently in `apps/worker/src/`:

- `task-planning.ts:319-369` — `inferFilesToTouch()`, `inferTestsToAdd()`, and
  `planFindings()` are regex/heuristic versions of judgment the developer and
  plan-reviewer agents should make. The plan-reviewer system prompt and
  envelope schema already exist (`apps/worker/src/prompts/plan-reviewer.ts`),
  but the worker bypasses the agent and synthesizes the envelope itself.
- `task-rework.ts:108-129` — the rework loop cap silently refuses at the cap
  and parks the task; no agent gets to look at the loop's last few iterations
  and decide whether to escalate, abandon, or raise the cap.
- `decomposition-review-run.ts:517-560` — `postSpecReviewComment()` renders
  ~30 lines of hardcoded markdown ("**Spec/DAG reviewer requests changes.**"
  - bulleted findings + footer) on the reviewer's behalf, leaving no slot
    for the agent to qualify its verdict.
- `architect-run.ts:603-693` — `renderSpecMarkdown()` and `renderMrDescription()`
  generate the architect's spec MR content from templates instead of letting
  the architect agent author it.
- `architect-run.ts:726-745` — `defaultTaskTargetMapping()` defaults every
  proposed task to the primary project because the envelope doesn't carry
  per-task target hints; comment in code admits this is a stub.
- `developer-run.ts:346-358` — calls `mergeRequests.open` blindly with no
  existing-MR lookup; rerunning a developer task collides on the stable
  branch name. The architect side does the upsert correctly
  (`architect-run.ts:508-601`); the pattern is duplicated and inconsistent.

The common shape: the worker is doing the agent's _judgment_ (what files,
what severity, what wording, whether to retry) while also doing the work
that legitimately belongs in code (state transitions, idempotency, schema
validation, token lifecycle, capability gates).

## Decision

Adopt the following split as the durable rule for colony:

- **Agents decide content and recommend routing via prompts + sandbox
  workspace access + small graph/provider read primitives + one
  state-advancing terminal tool per run/phase.** Judgment lives in the
  system prompt; repository observation lives in the sandbox filesystem;
  graph/provider observation lives in safe idempotent read tools; state-
  changing recommendations funnel through a single schema-validated terminal
  tool.
- **Code owns invariants and lifecycle.** State preconditions, idempotency,
  schema + freshness validation, capability/policy gates, token mint/revoke,
  audit, single-writer transactions, hard resource ceilings.

The split test: _if removing the branch would let a malicious or buggy agent
break an invariant (lose money, double-merge, leak token, corrupt state),
keep it in code; if removing it just means the agent might make a worse
judgment call, it's a tool, not a gate._

This ADR records the decision. Implementation rolls out as five focused
changes (see Consequences → Rollout).

## Alternatives Considered

- **Option A — Status quo.** Keep encoding judgment in workers as a safety
  net behind the agent. Cheap, deterministic, but duplicates LLM judgment
  the system already pays for, makes prompts irrelevant (the worker
  overrides them), and forces every nuance through enum/template diffs.
- **Option B — Wholesale agent supervisor.** Replace the heartbeat tick
  with a supervisor agent that reads scope/task state via tools and decides
  what to fire next. Right long-term direction but too large a change in
  one go; risks correctness regressions on the lifecycle invariants that
  _are_ legitimately code-shaped.
- **Option C (chosen) — Agent for judgment, code for invariants.** Cut
  duplicated decisions out of the worker, keep the lifecycle scaffolding,
  and migrate one surface at a time. Preserves blast-radius safety
  properties while letting the agents that already exist do their job.

## Rationale

The plan-reviewer case is the proof: the system prompt and envelope schema
were built, but the runtime path still never calls a plan-reviewer agent —
the worker re-derives the verdict from regex. That pattern recurs. Once the
agent surface exists, the worker's shadow judgment is pure cost: tokens spent
generating content the worker overwrites, prompts that drift from real
behavior, and an enum bottleneck that prevents nuance.

The opposite extreme (Option B) discards work that is genuinely earning
its keep — `task-graph.ts:215-278` idempotency middleware, freshness echo
verification, token lifecycle in `finally` blocks, optimistic
concurrency on `state_version`. These are not judgment; they are
correctness scaffolding that an agent shouldn't be asked to remember.

Option C lets us delete the duplication without disturbing the
correctness scaffolding, and produces a uniform shape (read primitives +
one state-advancing terminal tool + thin wrapper) that future roles can
clone.

## Consequences

### Tool surface principles

For each agent role:

- **Read primitives**: small, scoped, idempotent, observation-only for
  Colony graph/provider state. Examples: `get_task_packet`, `get_freshness`,
  `get_rework_budget`, `get_proposal`, `list_prior_findings`. Read tools
  never change state and never accept identifiers the agent isn't already
  scoped to (the run context determines `task_id`/`scope_id`).
- **Repository/filesystem inspection happens inside the sandbox workspace.**
  A run may receive one or more checked-out repos in its own filesystem
  (Kubernetes sandbox in prod; Docker/Firecracker/local equivalent in dev).
  Agents use ordinary filesystem/CLI tools (`read`, `grep`, `find`, `ls`,
  `bash`) there instead of Colony-specific `read_repo_file`/`grep_repo`
  tools. The isolation boundary is the sandbox, not a bespoke repo-read API.
- **Exactly one state-advancing terminal write tool per run/phase**,
  schema-validated at the boundary, idempotent on retry. The terminal call
  is what advances state. Examples: `submit_developer_plan`,
  `submit_plan_review`, `submit_decomposition`,
  `submit_decomposition_review`, `submit_work`, `escalate_blocked`.
- **Auxiliary write tools may exist only when they do not advance Task Graph
  state.** Example: `post_progress_note` can write terse provider comments,
  but it is rate-limited, scoped to the current issue/MR, and cannot decide
  routing or lifecycle.
- **Agent-authored lifecycle prose passes through the terminal tool.**
  Review comment bodies, MR descriptions, spec markdown — all fields on
  the terminal envelope, not rendered by the worker.

### What code keeps doing

- State preconditions (`scope.state === "draft"` before architect run, etc.) —
  safety floors against double-firing, not duplicated judgment.
- Schema validation + freshness echo check on every terminal envelope —
  cryptographic invariant.
- Routing and assignment authority. Agents may recommend `next_action`; the
  Supervisor validates and performs the actual transition/assignment.
- Capability/policy gates at the tool boundary.
- Token mint in entry, revoke in `finally`.
- Hard resource ceilings (rework cap as a `>= cap` backstop) even when
  the agent also reads the budget. Runaway-spend is a safety issue.
- Single-writer atomicity via `state_version`.
- Audit on prompt prepared, tool call, terminal submission, state transition.
- Idempotency middleware on the HTTP boundary.

### Rollout (in order, smallest blast radius first)

1. **`submit_work` in `developer-run.ts`.** Collapse "create CR vs update
   MR" into one tool the developer agent calls. Fixes a latent rerun-MR
   collision bug. Terminal tool implementation:
   look up mirror by `(colony_id=task.id, entity_kind=mr_pr)` →
   create-or-update MR → upsert mirror → write audit → advance
   `in_progress → review_requested`. Idempotent on `head_commit_sha`.
   Delete `openOrFindMergeRequest` and the post-run state transition;
   the terminal tool owns the causal chain.

2. **`submit_decomposition_review` with agent-authored comment.** Reviewer
   envelope grows an `mr_comment_body` field. Worker validates +
   records + posts the agent's comment + auto-approves on
   `result === "approved"`. Delete `postSpecReviewComment` (lines
   517-560). System prompt absorbs the format guidance.

3. **Plan + plan-review redesign.** Sketch in
   `apps/worker/src/prompts/plan-reviewer.ts` is already complete on
   the prompt side. Add planner system prompt; provide sandbox workspace
   access plus graph/provider read primitives (`get_task_packet`,
   `list_existing_tests`, `get_freshness`); replace synthetic-envelope code in
   `task-planning.ts:92-117` and `:242-296` with real agent runs and
   `submit_developer_plan` / `submit_plan_review` terminals. Delete
   `inferFilesToTouch`, `inferTestsToAdd`, `planFindings`. Rules
   become bullets in the prompts.

4. **`escalate_blocked` + `get_rework_budget`.** Expose budget as a
   read tool to developer/reviewer agents. Add an escalation agent run
   triggered when cap is hit, with a terminal `escalate_blocked({
reason, evidence, recommended_action })`. Code keeps the hard
   ceiling; what changes is the _graceful path_ before hitting it.

5. **Architect spec markdown via envelope.** Extend
   `architectDecompositionEnvelope` with `spec_markdown`,
   `mr_description`, and per-task `target_project_hint`. Terminal
   tool `submit_decomposition({ envelope, spec_markdown, mr_description })`
   commits files + opens/updates MR using shared upsert primitive.
   Delete `renderSpecMarkdown`, `renderMrDescription`,
   `defaultTaskTargetMapping`. Reuse the same upsert primitive that
   `submit_work` uses.

### What we now owe

- New agent roles cloning this shape get review scrutiny on: read
  primitives are scoped, terminal tool is single-shot per run, hard
  ceilings exist for any unbounded resource.
- System prompts grow as the deleted heuristics move into them. Treat
  the prompts as production code (versioned, reviewed, tested via
  `prompts.test.ts`).
- Schemas grow as terminal tools accept agent-authored prose fields.
  Length caps + content sanitization at envelope ingest, not at the
  call site.

### What we gain

- Reviewer can qualify its approval ("approved but flag X as
  follow-up") because the comment is agent-authored instead of
  templated.
- Developer rerun no longer collides on the MR.
- `task-planning.ts` shrinks from ~385 lines of shadow-judgment to
  ~80 lines of pure lifecycle.
- One uniform shape across roles makes the next role (security
  reviewer, scope closer, etc.) cheap to add.
- Prompts become load-bearing again; drift between prompt and
  behavior gets caught by review of the prompt, not by tracing
  through worker code.

## Revisit When

- A new agent role can't fit the read-primitives + one-terminal shape
  (e.g., needs to interleave multiple writes whose ordering depends
  on intermediate results). May indicate the role should be split,
  or that the shape needs an extension.
- Hard ceiling (rework cap, time budget) starts firing often enough
  that the escalation agent becomes the dominant path — at that
  point rework loop policy itself needs rethinking, not just the
  shape of the bailout.
- A safety incident traces back to an agent decision that should
  have been a code invariant. The split test failed; revisit which
  side that decision belonged on.
- Supervisor loop in code becomes the bottleneck for adding new
  scope/task lifecycles. At that point Option B (agent supervisor)
  may be ready.
