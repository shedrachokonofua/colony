# Always-On Muse Advisor Integration

## Status

Approved in chat on 2026-09-04; written specification pending final review.

## Goal

Attach OMP's native advisor runtime to every Colony-owned primary agent session except architect sessions. The advisor uses only `router/muse-spark-1.3-contributor`, has read-only workspace access, never falls back to another model, and may interrupt the primary only for blocker-severity advice.

This is an independent critic, not a second task owner. It observes and advises; the primary agent remains solely responsible for edits, submissions, task state, and completion.

## Decisions

- Enable the advisor for all Colony projects. Contributor-tier prompts and outputs may be used to improve Meta products; this data policy is accepted globally.
- Enable it for developer, reviewer, plan-reviewer, memory-consolidator, and integrator primary sessions.
- Disable it for architect sessions so Muse does not review its own plans.
- Disable it for nested OMP subagents. The parent advisor sees the child tool call and returned report; spawning one advisor per child would multiply traffic and contend on the same model route.
- Suppress the advisor whenever an eligible run's current primary model is the same Contributor route; resume it if the primary later moves away. “Always on” means always configured and active when independent review and route capacity permit, never Muse critiquing itself.
- Use `router/muse-spark-1.3-contributor` at `xhigh` thinking.
- Grant only `read`, `grep`, and `glob`.
- Do not configure an advisor fallback. If Contributor is unavailable, the advisor pauses and the primary continues.
- Deliver nits and concerns non-interruptingly. Only blockers may steer and interrupt the primary.
- Do not force a separate exploration phase. The advisor critiques the normal unified investigate/edit/verify loop.
- Preserve the existing Contributor route capacity of one concurrent invocation until production evidence supports changing it.

## Economics

Contributor reference pricing is $0.10 per million input tokens and $0.20 per million output tokens, with the deployed Colony model entry recording $0.002 per million cache-read tokens. Its 1,048,576-token context window is sufficient for long primary transcripts.

Advisor accounting reports reference API value even when another route is paid through a subscription or allocation. `billedCost`, subscription allocation, and reference API value are distinct concepts; this integration records the SDK's model-price-derived advisor cost and never relabels prepaid capacity as free economic value.

## Architecture

### OMP SDK policy seams

The installed `@oh-my-pi/pi-coding-agent` 17.3.7 already provides advisor models, incremental transcript delivery, severity-tagged advice, dedupe, per-update emission limits, context maintenance, separate transcripts, quota handling, and advisor statistics. Three narrow SDK seams are required for a headless host.

#### Programmatic advisor configuration

Add optional fields to `CreateAgentSessionOptions`:

```ts
advisorConfigs?: AdvisorConfig[];
advisorSharedInstructions?: string;
```

When either is supplied, those explicit values replace advisor configuration discovered from `WATCHDOG.yml`. When both are undefined, existing discovery behavior is unchanged. An explicit empty array means no configured advisor roster. This prevents Colony policy from depending on generated files or merging with repository-owned watchdog configuration.

#### Interruption threshold

Add a setting:

```ts
"advisor.interruptThreshold": "concern" | "blocker" | "never";
```

Default: `"concern"`, preserving existing behavior.

Delivery rules:

- `concern`: concern and blocker advice may interrupt.
- `blocker`: only blocker advice may interrupt; concern is delivered through the non-interrupting advisor channel.
- `never`: no advisor advice interrupts.

The threshold must be enforced where `AdvisorDeliveryChannel` is selected, not only in the advisor prompt. Advisor models are not trusted to obey severity guidance perfectly.

#### Advisor-specific fallback control

Add a setting:

```ts
"advisor.modelFallback": boolean;
```

Default: `true`, preserving existing behavior.

When false, `SessionAdvisors.#recoverAdvisorTurn` may rotate credentials for the exact configured route but must not select another model. If exact-route recovery fails, the advisor transitions to its existing paused/error state and reports the failure without failing, canceling, or delaying the primary session. The setting does not alter primary-agent fallback behavior.

### Colony configuration

Add a top-level advisor policy to Colony configuration:

```yaml
advisor:
  enabled: true
  provider: openai_compatible
  model: muse-spark
  thinking_level: xhigh
  roles:
    - developer
    - reviewer
    - plan_reviewer
    - memory_consolidator
    - integrator
  tools: [read, grep, glob]
  interrupt_threshold: blocker
  model_fallback: false
  nested: false
  sync_backlog: off
```

The resolver produces a `ResolvedAdvisorConfig` independently of `ResolvedAgentConfig`. The advisor is not a Colony run role: it has no run row, task lease, task transition authority, or independent completion contract.

Configuration validation requires the provider/model pair to resolve to exactly one registered provider model. `roles` accepts existing `AgentRole` values. Architect is rejected from the deployed policy even if a future file attempts to add it, because the production invariant is independent review rather than Muse self-review.

### Session construction

`PiBaseAgentRunner` receives the resolved advisor policy separately from the primary and fallback model chain.

For each eligible file-backed primary session it:

1. Resolves the exact Contributor model and broker credential.
2. Registers that model in `ModelRegistry` even when it is absent from the primary role's model chain.
3. Enables `advisor.enabled` in the isolated SDK settings.
4. Sets `modelRoles.advisor` to the exact Contributor selector at `xhigh`.
5. Sets `advisor.interruptThreshold` to `blocker`.
6. Sets `advisor.modelFallback` to false.
7. Passes one programmatic advisor config named `colony-critic` with only `read`, `grep`, and `glob`.
8. Passes Colony's shared advisor instructions.

Transient child sessions receive `advisor.enabled: false` and no advisor configuration. Every architect stage and architect child session also receives `advisor.enabled: false`.

Eligibility is computed from the Colony run role, not inferred from packet shape or tool names. A non-architect run whose current primary model is the exact Contributor route is temporarily unadvised: one model must not critique itself or consume both sides of a capacity-one route. If runtime fallback moves the primary onto Contributor, dispose/pause its advisor before the next model call; if the primary later leaves Contributor, the advisor may resume from its preserved cursor. Resume reconstructs the same policy from the persisted run role, current primary model, and deployment configuration.

### Capacity

`max_parallel_runs` currently limits Colony run dispatches, not background SDK advisor calls. Always-on advisors must not bypass the Contributor route's configured capacity of one.

Add a process-wide route-capacity arbiter keyed by provider model ID and shared by primary dispatch and advisor invocations. Its capacity comes from the resolved provider model's existing `max_parallel_runs`:

- A running primary Colony run keeps its existing route reservation for the run lifetime.
- An advisor acquires a short-lived invocation lease only when primary reservations plus advisor leases are below the cap.
- Primary dispatch has priority over queued advisor work. A primary may wait only for an already in-flight advisor request to finish; queued advisor requests never jump ahead of it.
- With Contributor capacity one, an active Muse architect or Muse primary leaves Contributor advisors configured but waiting. They catch up after the primary reservation releases.
- Waiting advisors accumulate their normal incremental backlog without blocking their own primary because `advisor.syncBacklog` is off.
- OMP processes the accumulated delta using its existing append-only advisor context when capacity becomes available.
- Drain, primary-model collision, and session disposal cancel queued advisor acquisition.
- Queue delay, backlog depth, primary reservations, and advisor leases are observable.

This preserves route capacity rather than treating subscription-backed advisor traffic as free. It also prevents the same Contributor model from simultaneously acting as a run's primary and advisor.

### Advisor instructions

The `colony-critic` baseline tells Muse to identify concrete, evidence-backed risks in the primary's current direction. It focuses on:

- Assumptions contradicted by repository or runtime evidence.
- Repeated experiments that do not distinguish competing hypotheses.
- Context growth without a narrowed diagnosis.
- Unsafe, destructive, or unbounded commands.
- Source changes that suppress symptoms rather than repair causes.
- Missing call-site, contract, or migration work.
- Verification that does not exercise the claimed behavior.
- Scope reduction, unpushed work near the deadline, or attempted completion without an accepted submission.

It does not prescribe an exploration/edit phase boundary, restate the task, demand edits before evidence exists, enforce style preferences, or produce positive/no-op advice.

Severity policy in the prompt complements but does not replace SDK enforcement:

- `nit`: actionable improvement that can wait.
- `concern`: likely correctness or convergence issue; delivered non-interruptingly.
- `blocker`: destructive action, security exposure, irreversible corruption, or a direction conclusively invalidated by evidence; may interrupt.

### Data flow

```text
Primary turn completes
  -> OMP computes unseen transcript delta
  -> secret obfuscator processes advisor-bound content
  -> process-wide Contributor invocation gate
  -> colony-critic reads delta and optional read-only workspace evidence
  -> advise(note, severity)
  -> SDK emission guard drops duplicates/noise
  -> interrupt threshold selects non-interrupting delivery or blocker steer
  -> primary weighs the advice and continues
```

Advisor output never mutates task state directly. It enters the primary transcript through OMP's existing advisory message format with `guidance="weigh, don't blindly obey"`.

## Error Handling

- No advisor model resolves: emit advisor-unavailable evidence; run primary normally.
- Contributor credential or quota failure: attempt same-route credential recovery only; never change model.
- Contributor remains unavailable: pause advisor and run primary normally.
- Advisor tool request outside `read`, `grep`, `glob`: OMP quarantines/rejects it; never expand grants dynamically.
- Advisor context overflow: use OMP's existing advisor context maintenance without changing model; if maintenance cannot recover, re-prime or pause according to existing runtime behavior.
- Capacity queue canceled by drain, abort, or disposal: drop queued advisor work and close its recorder cleanly.
- Advisor transcript persistence failure: log and emit evidence; never fail the primary.
- Resume: reconstruct the advisor from the main session and advisor transcript; do not append advisor messages into the primary JSONL writer.

## Observability

Colony records advisor activity without creating advisor run rows:

- `advisor.started`: advisor name, exact model, role.
- `advisor.note`: severity, delivery channel, dedupe-safe note metadata, and whether it interrupted.
- `advisor.paused`: quota, credential, model-unavailable, or runtime-error classification.
- `advisor.capacity_wait`: queue duration and backlog size.
- `advisor.summary`: turns, notes by severity, suppressed notes, input/output/cache tokens, reference cost, active/paused duration.

The advisor transcript is uploaded as a distinct artifact named from `__advisor.colony-critic.jsonl`. Primary `run_summary` remains primary-only; advisor usage is a separate breakdown so cost and behavior cannot be mistaken for main-agent usage.

Console delivery-stage work may later render advisor status, but UI rendering is not required to enable this integration. Run events and artifacts are the initial operator surface.

## Security and Privacy

- All projects opt into Contributor data use.
- Existing OMP secret obfuscation remains mandatory before advisor prompts.
- Advisor tools are read-only and sandbox-routed; no daemon filesystem access.
- Advisor cannot call submit tools, goal tools, task delegation, shell, edit, write, MCP, or LSP.
- Repository `WATCHDOG.yml` cannot override the Colony advisor model, tools, fallback, role eligibility, or interruption threshold.
- Advisor notes are untrusted model output and must remain escaped in console rendering and bounded in event storage.

## Verification

### OMP SDK

- Existing default still interrupts concern and blocker advice.
- `blocker` threshold routes concerns non-interruptingly and blockers through steer.
- `never` threshold never steers.
- `advisor.modelFallback: false` refuses candidate model switching while allowing same-route credential recovery.
- Explicit programmatic advisor configuration replaces discovery; undefined preserves discovery.
- Advisor policy survives compaction and resume.

### Colony configuration

- Parses and resolves the exact Contributor advisor policy.
- Rejects unknown advisor provider/model, unsupported tools, duplicate roles, and invalid interruption values.
- Production configuration resolves Muse Contributor at `xhigh`, with no fallback.

### Colony runtime

- Developer, reviewer, plan-reviewer, memory-consolidator, and integrator primary sessions create the advisor when their current primary model is not Contributor.
- Architect sessions, Contributor-primary sessions, and all nested subagent sessions do not run an advisor.
- Moving a primary onto Contributor pauses/disposes its advisor before the next call; moving away permits advisor reconstruction from its cursor.
- Concern advice does not interrupt an in-flight primary tool; blocker advice does.
- Advisor failure and capacity wait never fail or block its own primary.
- The shared route-capacity arbiter never exceeds the Contributor cap across primary reservations and advisor invocation leases.
- Primary dispatch takes priority over queued advisor work.
- Resume recreates the advisor and preserves separate primary/advisor journals.
- Read-only grants reject every mutating tool path.
- Advisor notes, status, tokens, and reference cost appear in run events and artifacts.

### Behavioral production probe

Run two concurrent developer tasks while a Muse architect task is active:

- Architect has no advisor and holds the one Contributor primary reservation.
- Both developers report configured `colony-critic` advisors waiting on capacity while their primary turns continue.
- No Contributor advisor request starts until the architect releases its reservation.
- After release, developer advisor requests serialize at capacity one and catch up without replaying duplicate advice.
- A seeded concern appears non-interruptingly.
- A seeded blocker interrupts exactly once.
- Moving a developer primary onto Contributor pauses that run's advisor rather than allowing self-review.
- Disabling the Contributor credential pauses advisors without selecting another model or failing either developer run.

## Rollout

1. Release the backward-compatible OMP SDK policy/configuration seams.
2. Upgrade Colony to that SDK version.
3. Add Colony advisor configuration, runner wiring, capacity gate, observability, and tests with production `advisor.enabled: false`.
4. Deploy and verify ordinary runs are unchanged.
5. Enable the production policy globally.
6. Run the behavioral production probe.
7. Compare advised versus prior runs for no-submission rate, time to first durable change, repeated command families, blocker precision, latency, and reference cost.

Rollback is one configuration change: set `advisor.enabled: false`. Existing primary sessions continue; active advisor runtimes are disposed at the next session/config boundary. No database migration or task-state rollback is required.

## Non-Goals

- Replacing plan review, code review, merge gates, or human approval.
- Making the advisor a Colony task/run role.
- Allowing advisor edits or submissions.
- Adding model fallback.
- Advising architect sessions or nested subagents.
- Mandating separate exploration and implementation phases.
- Automatically aborting a primary because the advisor reports drift.
- Changing the Contributor concurrency limit without production evidence.
