# OpenAI Symphony Learnings For Colony

Date: 2026-04-29

Source inspected: `openai/symphony` at `58cf97da06d556c019ccea20c67f4f77da124bf3` (`58cf97d`, 2026-04-27).

## Executive Read

Symphony validates Colony's core thesis: once coding agents are useful, the scarce resource becomes human attention, and the right unit of coordination becomes durable work items rather than interactive chat sessions.

The overlap is real, but Symphony and Colony sit at different depths:

- Symphony is a lightweight, trusted-environment scheduler around Linear issues, per-issue workspaces, Codex app-server turns, a repo-owned `WORKFLOW.md`, and an observability surface.
- Colony is a durable control plane: first-party Task Graph, Temporal supervision, provider mirrors, typed packets/envelopes, audit, policy gates, capability checks, and reconciliation before irreversible actions.

The useful stance is: a strong independent team hit the same bottleneck and proved the category. Colony should absorb the practical lessons from their implementation without giving up its safety and audit posture.

## What Symphony Actually Is

The public repo contains both a language-neutral `SPEC.md` and an Elixir reference implementation.

The core loop is intentionally small:

1. Load workflow policy and runtime config from `WORKFLOW.md`.
2. Poll Linear for candidate issues in configured active states.
3. Sort candidates by priority, age, and identifier.
4. Claim each eligible issue in the orchestrator's in-memory state.
5. Create or reuse a deterministic per-issue workspace.
6. Launch `codex app-server` in that workspace.
7. Send a rendered issue prompt to Codex.
8. Stream Codex events back into orchestrator state.
9. If the issue remains active after a normal turn, continue in the same thread up to `agent.max_turns`, then schedule a short continuation retry.
10. Stop or retry workers based on issue state, process exits, stall detection, and backoff.

Their important boundary: Symphony mostly reads the tracker. It expects the coding agent, through tools and skills, to update ticket state, comments, PR links, and merge flow. That keeps the scheduler thin but pushes a lot of workflow correctness into prompt/skill discipline.

## Architectural Lessons Worth Stealing

### 1. Repo-Owned Workflow Policy Is Powerful

Symphony's `WORKFLOW.md` combines runtime config and the agent prompt in one versioned file. It includes tracker settings, active/terminal states, polling interval, workspace root, hooks, concurrency, Codex command, approval policy, sandbox policy, and the Liquid-style prompt body.

Why this matters for Colony:

- Teams can evolve workflow policy with the repository instead of shipping scheduler code for every behavior tweak.
- Agent instructions, validation expectations, handoff rules, and state routing become reviewable artifacts.
- Runtime changes can be rolled out by changing the workflow file rather than redeploying the orchestrator.

Colony adaptation:

- Add a repo-scoped `COLONY_WORKFLOW.md` or equivalent policy file for provider/project-specific run behavior.
- Keep Colony's hard invariants in code: Task Graph ownership, capability checks, packet schemas, envelope validation, audit, and reconciliation.
- Let repo policy customize prompts, run hooks, validation commands, branch naming, workpad/comment format, handoff text, and provider-specific conventions.

### 2. Strict Template Rendering Catches Bad Context Early

Symphony renders prompts with strict variables and strict filters. Unknown template variables fail the run instead of silently producing a bad prompt.

Colony already has typed packets, but the same principle applies:

- Packet builders should fail closed on missing required context.
- Prompt templates should be validated against packet schemas.
- A broken template should reject dispatch or fail the specific run with a visible operator error, not produce an under-specified agent run.

Action: add template/schema validation to packet build tests once Colony introduces repo-configurable prompts.

### 3. Workspaces Are Durable Attempt State

Symphony intentionally reuses the same workspace for an issue. It does not delete successful workspaces automatically. Reused workspaces are not destructively reset on population failures unless explicitly configured.

This is a pragmatic answer to a real problem: if an agent run dies, the next run can pick up files, branch state, build cache, notes, and partially completed work.

Colony adaptation:

- Keep "agent is disposable" as the core invariant, but treat sandbox/workspace state as useful attempt-local evidence.
- Persist the durable handoff in commits, envelopes, provider artifacts, and Task Graph state. Do not make workspace contents the source of truth.
- For retryable task runs, prefer reusing a workspace when safe; for rework/full reset states, create a fresh branch/workspace and record why.

### 4. The Single Persistent Workpad Comment Is A Great Operator Pattern

The most interesting workflow object in Symphony is not in the Elixir code. It is the `## Codex Workpad` comment required by `WORKFLOW.md`.

The workpad is a single mutable tracker comment containing:

- Environment stamp: host, absolute workdir, commit SHA.
- Plan checklist.
- Acceptance criteria.
- Validation checklist.
- Notes.
- Confusions.

The prompt tells the agent to update this one comment throughout execution and avoid spraying progress comments.

Why this matters:

- Humans get one stable place to inspect run state.
- Agents get a durable continuation anchor outside chat history.
- Retry/continuation turns can reconcile the workpad before acting.
- The tracker remains readable.

Colony adaptation:

- Add a provider-visible "Task Workpad" projection for every active task.
- Generate it from Task Graph state where possible, but allow agents to propose updates via structured envelopes.
- Keep the one-comment rule: progress updates mutate one provider comment/thread, not many.
- Mirror the workpad into audit/memory only after validation, so it helps continuity without becoming unaudited truth.

### 5. Continuation Turns Are A First-Class Control Mechanism

Symphony does not assume one agent turn equals one task attempt. The worker can run multiple back-to-back Codex turns in the same live thread while the issue remains active. The first turn gets the full rendered prompt; later turns get compact continuation guidance.

This has two advantages:

- Avoids expensive full prompt replays when the model stopped early.
- Lets the scheduler keep pressure on active work without requiring human babysitting.

Colony adaptation:

- Model `AgentRun` as possibly containing multiple `turns`, each with its own event stream and token/runtime accounting.
- Decide per role whether continuation turns are allowed. Developer runs likely benefit; Reviewer and gate decisions may be better as fresh, bounded runs.
- Store turn count and last activity in run state for stall detection and observability.

### 6. Normal Exit Is Not Done

Symphony treats a normal worker exit as "check whether the issue is still active," not as task completion. It schedules a short continuation retry after normal exit, re-fetches the issue, and only releases the claim if the issue is no longer eligible.

Colony already has stronger done semantics, but this is still a good operational lesson:

- Process success is not workflow success.
- Agent final text is not workflow success.
- PR creation is not task success.
- Merge is not scope success.

Action: make this invariant explicit in implementation docs and tests: every role runner exits into Supervisor reconciliation, never directly into "done."

### 7. Reconciliation Before Dispatch Keeps The Scheduler Honest

Every Symphony poll tick starts by reconciling running issues before dispatching new work. It refreshes tracker state for running issues, stops workers whose issues became terminal/non-active, and restarts stalled workers.

Colony should keep its stronger version:

- Reconcile before dispatch.
- Reconcile before merge/close/deploy/gate advance.
- Reconcile periodically even when no events arrive.
- On provider refresh failure, fail closed for irreversible actions while allowing already-running low-risk work to continue only when policy allows.

### 8. Stall Detection Should Be Based On Agent Events, Not Just Process Liveness

Symphony tracks `last_codex_timestamp` from app-server events. If no event arrives within `codex.stall_timeout_ms`, the orchestrator terminates the worker and schedules retry with backoff.

This is more useful than "is the process alive?" because agent processes can hang while waiting for approval, user input, tool calls, or network.

Colony adaptation:

- Track per-run `last_event_at`, `last_tool_call_at`, `last_model_event_at`, and `last_provider_write_at`.
- Define stall classes: no model activity, no tool activity, waiting on external approval, waiting on provider/CI, no logs from sandbox.
- Make each class visible in the UI and audit.

### 9. Approval/User-Input Requests Must Never Stall Unattended Runs

Symphony's app-server client either auto-approves according to documented policy, auto-answers "operator input unavailable," or fails the turn. The spec is explicit: user-input-required signals must not leave a run stalled indefinitely.

Colony adaptation:

- Any request for interactive input inside a sandbox must become a structured `blocked` or `needs_operator_input` envelope.
- Operator input should flow through the provider/Task Graph, not through a hidden terminal prompt.
- Policies should say which roles may auto-approve which classes of tool action.

### 10. Thin Client-Side Tools Are Useful

Symphony exposes a `linear_graphql` dynamic tool to Codex. The agent can query/mutate Linear without reading raw tokens from disk. Unsupported dynamic tools return structured failure results instead of stalling the session.

Colony has the more ambitious Tool Gateway. The lesson is about ergonomics:

- Give agents the narrow provider tools they actually need.
- Let the runtime own credentials.
- Return structured errors that the model can inspect and recover from.
- Document tool examples as skills, not just API docs.

### 11. Observability Is Product Surface, Not Just Ops Plumbing

Symphony invests in a status surface early: running issues, retry queue, session IDs, app-server PID, turn count, token totals, rate limits, last Codex event, runtime seconds, and refresh controls. It also has a debug skill built around correlation keys.

Colony should not wait until late phases for this:

- Operator trust depends on seeing what agents are doing now.
- Debugging multiple agents requires stable join keys.
- Rate-limit and token visibility matter once concurrency is >1.

Action: move a minimal "live run board" earlier if possible: `scope_id`, `task_id`, `run_id`, role, sandbox, provider artifact, current phase, last event, last tool, retry/backoff, token/runtime totals, and correlation links.

### 12. Skills Encode Runbooks For Agents

Symphony's `.codex/skills` directory is effectively a set of agent runbooks:

- `linear`: how to use the injected Linear GraphQL tool.
- `commit`: how to create meaningful commits.
- `pull`: how to merge `origin/main` and resolve conflicts.
- `push`: how to publish and manage PRs.
- `land`: how to monitor feedback/checks and merge.
- `debug`: how to investigate stuck Symphony runs.

Colony adaptation:

- Treat skills/runbooks as first-class policy assets, versioned with the repo or provider project.
- Keep human-facing runbooks and agent-facing runbooks close enough that they do not drift.
- Build role-specific skill bundles: Developer, Reviewer, Integrator, Memory Consolidator, Operator Debug.

## What Colony Should Not Copy Blindly

### Do Not Make The Tracker The Source Of Truth

Symphony deliberately uses Linear as the control plane and relies on tracker state as the scheduler's durable recovery mechanism. That is appropriate for a lightweight trusted-environment preview.

Colony should keep the Task Graph authoritative. External trackers are projection and collaboration surfaces. This is still Colony's clearest differentiation.

### Do Not Put Critical Workflow Correctness Only In Prompt Text

Symphony's workflow prompt carries a lot of behavior: when to move states, when to land, how to handle rework, how to create follow-up issues, and how to update the workpad.

Colony should use prompts for behavior guidance, but enforce critical transitions in code:

- Task state transitions.
- Gate advancement.
- Merge/deploy/close.
- Capability checks.
- Provider write permissions.
- Envelope acceptance/rejection.
- Reconciliation before irreversible actions.

### Do Not Treat A High-Trust Approval Policy As The Default Product Posture

The sample `WORKFLOW.md` uses `approval_policy: never` and shell environment inheritance. This is fine for an internal dogfood loop. It is not Colony's default posture.

Colony should expose trust levels:

- Local/dogfood: relaxed, high productivity.
- Pilot: scoped credentials, sandbox egress policy, audited provider writes.
- Production: stricter capabilities, clear operator gates, fail-closed irreversible actions.

### Do Not Rely On In-Memory Orchestrator State For Colony's Core Guarantees

Symphony intentionally avoids a persistent database. Its restart recovery comes from tracker state and filesystem workspaces.

Colony needs durable claims, leases, attempts, artifacts, decisions, and audit. Temporal plus Postgres remain the right baseline.

## Concrete Colony Follow-Ups

### Near-Term

1. Add a `COLONY_WORKFLOW.md` design section:
   - repo/project prompt fragments,
   - validation commands,
   - provider workpad template,
   - allowed skills,
   - sandbox/run profile overrides,
   - active handoff conventions.

2. Add a "Task Workpad" projection:
   - one provider comment per task,
   - generated marker/header,
   - environment/run stamp,
   - plan, acceptance, validation, notes, blockers/confusions,
   - mutations go through structured envelopes or Supervisor projection.

3. Add run-turn modeling:
   - `agent_run_turns` or nested run events,
   - `turn_count`,
   - `thread_id`/`turn_id` when using Codex/Pi-compatible runtimes,
   - token/runtime accounting per turn and aggregate per run.

4. Add stall classes:
   - no model event,
   - no tool event,
   - waiting on provider/CI,
   - waiting on approval/input,
   - sandbox unreachable.

5. Bring live observability forward:
   - current runs,
   - retry queue,
   - last event,
   - sandbox/workspace,
   - provider artifact,
   - token/rate-limit totals,
   - manual refresh/reconcile action.

### Medium-Term

1. Add role-specific skill bundles and make their versions part of packet freshness metadata.
2. Add provider-specific dynamic tools through the Tool Gateway with structured success/error payloads.
3. Add tests that prove runner process success cannot directly close a task.
4. Add tests that terminal/non-active provider state stops active runs before new dispatch.
5. Add tests that prompt/template errors fail closed and surface operator-visible diagnostics.

## Positioning Takeaway

Symphony makes the category legible: issue trackers become orchestration surfaces for always-on coding agents.

Colony's wedge should be:

> Symphony proves the lightweight scheduler pattern. Colony is the durable, auditable control plane for teams that need state authority, policy gates, provider abstraction, and safe reconciliation before anything irreversible happens.

That distinction is worth preserving. The right move is to steal the operationally sharp patterns, especially workflow files, workpad comments, continuation turns, and live run observability, while keeping Colony's Task Graph and safety model as the center of gravity.
