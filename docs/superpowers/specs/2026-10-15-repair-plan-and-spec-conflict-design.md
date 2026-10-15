# Repair Planner and Spec-Conflict Exit

## Status

Decisions approved in chat on 2026-10-15. This spec awaits operator review.

## Problem

Task `col-db8759e3.2` spent 2 h 56 min (run `77352e0f`, `timeout_no_envelope`) and then another 55 min (run `8c37f1cc`) on a two-finding repair without pushing a change. The developer role runs on `moira/flash`. The reviewer's notes already named the fix direction, so the implementer was not missing the idea. It was missing three things:

- **A single decided approach.** The finding offered "epoch*deadline_callback / a per-store flag \_or* a separate engine".
- **Verified dependency facts.** About an hour went on `UpdateDeadline` semantics in wasmtime 48.0.3, plus one 600 s hung experiment.
- **A test fixture the spec allows.** The spec says "WAT-built components". The reviewer asked for a test that really reads `/skills`. The implementer fought component-model WAT even though `rustc --target wasm32-wasip2` worked at 05:05.

The implementer also had no sanctioned way to say "the spec and the finding cannot both hold". The schema tells it "Unfinished work is not blocked - push it and keep working", so it ground on until the 3 h wall timeout.

## Goal

1. When a reviewer flags a blocking finding as needing a plan, a strong model plans the repair before the next implement run. It works in a sandbox on the rejected head, checks dependency behavior by running code, decides one approach, and hands flash an ordered plan with checks and commit points.
2. An implementer or repair planner that proves a spec, acceptance check or review finding cannot hold can stop early with a structured spec conflict. The operator accepts the proposed amendment in one step.

## Non-goals

- A progress watchdog, an escalation ladder, or changes to drift nudges.
- Reasoning replay, compaction fact ledgers, caps on tool output, or a docs tool for dependencies.
- Automatic spec rewriting by the architect. Every spec change stays operator-gated.
- Changing which model runs implement.

## Decisions

- The repair planner is a new run kind, `repair_plan`, with a new agent role, `repair_planner`. Without its own config entry, the role inherits the `reviewer` entry, the same way `plan_reviewer` does. The deploy config pins it to `moira-strong` at `xhigh`, with `timeout_ms: 2700000` and `max_turns: 200`.
- The reviewer decides which findings need planning, with a per-finding flag. Only blocking findings flagged `plan` trigger the planner.
- `spec_conflict` is a new terminal status shared by the implementer and the repair planner. It blocks the task and records the conflict. The operator resolves it with a new task action, `accept-amendment`, which takes an optional edited text.

## Design

### 1. Reviewer flag

`reviewFinding` (`packages/schemas/src/envelopes/v2.ts`) and the TypeBox mirror in `reviewerVerdictEnvelopeTypeBox` (`packages/agent-runtime/src/pi-runner-common.ts`) gain:

```ts
repair: z.enum(["direct", "plan"]).default("direct");
```

The reviewer system and finalizer prompts add this rule:

> Mark a blocking finding `repair: "plan"` when fixing it means changing a mechanism or design, depends on dependency behavior you have not verified by running code, has more than one viable approach, or needs new test infrastructure. Otherwise `direct`.

`openFindingsAfter` (`apps/colonyd/src/runs/review-loop.ts`) carries `repair` onto each `OpenReviewFindingV1`, so a finding that is still open in later rounds keeps its flag. `formatRejectionForRepair` prints `(planned repair)` next to flagged findings.

### 2. Dispatch

`dispatchImplementers` (`apps/colonyd/src/tick.ts`) gets one decision before it moves a queued task to `running`:

```
need = repairPlanNeed(store, task)
  latest succeeded review run R for the task has verdict request_changes
  AND R's open findings include a blocking finding with repair === "plan"
  AND no succeeded repair_plan run with evidence.review_run_id === R.id
  AND fewer than 2 failed repair_plan runs with evidence.review_run_id === R.id
```

- **`need` is true:** pick a slot with `pickDispatchSlot(ctx, "repair_planner")`. Cap concurrency with `activeRunCount("repair_plan") < maxConcurrent`. Move the task `queued → running` and dispatch `runRepairPlan`.
- **Planning has failed twice for R:** write an audit event `repair_plan.skipped` with the run IDs, then dispatch `runImplement` as today, with findings only. Delivery never blocks on the planner.
- **Otherwise:** dispatch `runImplement` unchanged.

When a `repair_plan` run ends, the task goes `running → queued` with `next_retry_at: null`. The attempt count is unchanged. Implement-only fault accounting in `fault-budget.ts` doesn't see planner runs.

Every place that looks for the task's live run has to handle `repair_plan` runs the same way it handles `implement` runs:

- `stop` and `amend-spec` in `http.ts`;
- lease and resume handling (`resumeRole` in `main.ts`);
- delivery status;
- crash self-heal of `running` tasks.

### 3. The planner run

`apps/colonyd/src/runs/repair-plan.ts` starts the run with `kind: "repair_plan"`, `head_sha` = the rejected head, and evidence `{ review_run_id }`.

- **Runner profile:** `REPAIR_PLANNER_ROLE_PROFILE` in `pi-base-agent-runner.ts`.
  - Tools: `["read", "bash", "grep", "find", "ls"]`, so it can run code and write scratch files through bash.
  - Credential scope: `["api", "read_repository"]`, so it can't push. `verifyPushedHead` is off.
  - Workspace: `repo-required`, checked out at the rejected head.
- **Packet** (`buildRepairPlanPacket` in `packets.ts`):
  - task spec, including amendments;
  - the numbered open findings from `formatRejectionForRepair`, plus the list of blocking finding numbers;
  - operator directives;
  - branch and head facts;
  - these invariants:
    - Do not push or commit to the task branch.
    - Decide exactly one approach per blocking finding, and record the rejected alternatives with reasons.
    - Verify every claim about dependency or toolchain behavior by running it here, and cite the command and its output.
    - Prefer test fixtures the repository toolchain already builds.
    - Order the steps so each one ends in a check that passes, and mark commit points.
    - If your evidence shows the spec, an acceptance check, or a finding cannot hold, or two of them contradict each other, submit `spec_conflict`.

**Envelope** `RepairPlanV1` (Zod in `v2.ts`, TypeBox mirror, `submit_repair_plan` tool):

```ts
{
  kind: "repair_plan",
  status: "planned" | "spec_conflict",
  head_sha: Sha40,                      // the rejected head it planned against
  approach: string,                     // planned: required, one decided approach
  rejected_alternatives: { option: string, reason: string }[],
  verified_facts: { claim: string, cmd: string, exit_code: number, output_excerpt: string }[], // planned: min 1
  steps: {
    goal: string,
    files: string[],
    change: string,
    check: string,                      // command that must pass after the step
    commit: boolean,                    // commit and push after this step
    resolves: number[],                 // open-finding numbers
  }[],                                  // planned: min 1
  conflict?: SpecConflictV1,            // required iff status === "spec_conflict"
}
```

The submit tool rejects a `planned` envelope whose steps leave a blocking finding number unreferenced. The required numbers come from the packet, following the existing `envelope-validation.ts` gate pattern, and the error tells the agent which numbers are missing. `status: "spec_conflict"` follows section 5.

### 4. Implement packet

In repair mode, `latestRepairPlan()` in `implement.ts` takes the newest succeeded `repair_plan` run whose `evidence.review_run_id` is the current rejected review. `buildImplementBody` then renders a new section ahead of the review findings:

```
## Repair plan (from repair planner run <id>; follow in order)
Approach: …
Verified facts — do not re-verify:
- <claim> (`<cmd>` → exit <n>)
Steps:
1. <goal> — files: … — change: … — check: `<cmd>` — commit and push: yes — resolves: #1
Rejected alternatives — do not revisit:
- <option>: <reason>
```

It also adds this invariant:

> Follow the repair plan's steps in order and push at every commit point. If a step's check fails in a way that contradicts a verified fact, submit `spec_conflict` with that evidence instead of re-researching.

### 5. Spec conflict

**Schema.** `SpecConflictV1` (`v2.ts`, with a TypeBox mirror):

```ts
{
  source: "spec" | "acceptance" | "review_finding",
  quote: string,                        // exact clause or finding text
  evidence: { cmd: string, exit_code: number, output_excerpt: string }[], // min 1
  proposed_amendment: string,           // replacement text the operator can accept as-is
}
```

`ImplementerCompletionV2.status` becomes `"complete" | "blocked" | "spec_conflict"`, with `conflict: SpecConflictV1.optional()`. A refinement requires that `conflict` is present exactly when the status is `spec_conflict`. The `blocked` refinement message changes to: "blocked requires blocked_reason: what outside this repository stops the task. A provable contradiction in the spec, acceptance or a review finding is spec_conflict. Unfinished work is neither - push it and keep working".

**Prompts.** The implementer system prompt and finalizer (`pi-runner-common.ts`) add:

> If the spec, an acceptance check, or a review finding requires something you have shown cannot work here, or two of them contradict each other, stop and submit status `spec_conflict`. Include the exact clause, the commands and output that show it, and the replacement text you propose. Raise it as soon as you have the evidence. Hard or unfinished work is not a conflict.

**Daemon handling.** This applies to the implementer in both the `implement.ts` and `main.ts` resume paths, and to the repair planner:

- the run finishes `succeeded` with its envelope;
- the task moves `running → blocked` with `blocked_reason: "spec conflict: <source>: <first 160 chars of quote>"`;
- the task gets `spec_conflict_json` = `{ ...conflict, run_id, role }`;
- an audit event `task.spec_conflict` is written.

**Storage.** Migration 23 adds `tasks.spec_conflict_json TEXT`. Migration 24 runs `rebuildForCheck(db, "runs", "repair_plan")`. `transitionTask` clears `spec_conflict_json` on every transition out of `blocked`, exactly as it clears `blocked_reason`.

**Surfacing.**

- `delivery-status.ts`: a blocked task with a conflict adds evidence `{ kind: "spec_conflict", text: "<source>: <quote> → proposed: <proposed_amendment>" }`.
- `operator-summary.ts`: the `blocked_tasks` row gains `spec_conflict` (source, quote, proposed amendment, evidence commands).
- Notifications: unchanged. The critical `task.transition → blocked` notification already carries `blocked_reason`.
- Console task drawer: shows the conflict (quote, evidence, proposed amendment) and an "Accept amendment" button next to "Unblock".

**Operator action.** The route is `POST /tasks/:id/accept-amendment` with body `{ spec?: string }`. Clients:

- MCP: `task_action` verb `accept-amendment` with optional `spec=`;
- CLI: `colony task <id> accept-amendment [--spec <file|->]`.

Its behavior:

- **Guard:** the task is `blocked` and has `spec_conflict_json`. Otherwise it returns `409 NO_SPEC_CONFLICT`.
- **Amend:** `amendTaskSpec(id, "Accepted spec conflict from run <run_id> (<source>): <spec ?? proposed_amendment>")`.
- **Requeue:** transition `blocked → queued` with `attempt: 0` and `next_retry_at: null`, which clears `blocked_reason` and `spec_conflict_json`.
- **Audit:** an audit event `task.spec_conflict_accepted` with `edited: boolean`.

To reject a conflict, the operator uses the existing `amend` with guidance and then `unblock`. The playbook documents this.

### 6. Config and surfaces

- `packages/config/src/colony-config.ts`: add `repair_planner` to `AGENT_ROLES`. Without its own entry it falls back to `reviewer`.
- `apps/colonyd/src/agent-runtime.ts`: build a `PiRepairPlannerRunner` from `config.forAgent("repair_planner")`.
- `config/colony.deploy.yaml` and `config/colony.example.yaml`: add the `repair_planner` entry.
- `apps/colonyd/src/http.ts`: run-kind validation accepts `repair_plan`.
- `apps/colonyd/src/mcp.ts`: the `get_run` and `task_action` descriptions and the verb enum.
- `packages/console/kind-label.js`: `repair_plan: "repair plan"`.
- Docs:
  - `README.md`;
  - `apps/cli/README.md`;
  - `skills/colony/references/lifecycle.md` (run kinds, the `spec conflict:` blocked reason);
  - `skills/colony/references/playbooks.md` (resolving a spec conflict);
  - `skills/colony/references/investigation.md` (repair-plan runs).

## Failure modes

| Case                                        | Behavior                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Planner faults or times out                 | Task returns to `queued`; planning is retried once for the same review; after 2 failures implement runs with findings only and an audit event `repair_plan.skipped` is written |
| Planner submits `spec_conflict`             | Task blocks with the conflict; no implement run                                                                                                                                |
| Plan leaves a blocking finding unreferenced | The submit tool rejects the envelope; the planner corrects it within the run                                                                                                   |
| Operator amends while a planner runs        | The planner run is aborted; the task is requeued; the new review state decides whether to plan again                                                                           |
| Implementer raises a weak conflict          | The operator amends with guidance and unblocks; no attempt is spent, because unblock resets attempts as it does today                                                          |
| Reviewer flags nothing as `plan`            | Behavior is identical to today                                                                                                                                                 |

## Verification

Automated tests (bun:test, following the existing files):

- **Schemas:** `ImplementerCompletionV2` accepts `spec_conflict` with a conflict and rejects it without one. It rejects a conflict with empty evidence. `RepairPlanV1` rejects `planned` without verified facts or steps. `reviewFinding` defaults `repair` to `direct`.
- **Review loop:** an open finding keeps its `repair` flag across rounds.
- **Tick dispatch:**
  - a queued task whose latest review has a plan-flagged blocking finding dispatches `repair_plan`, not `implement`;
  - direct-only findings dispatch `implement`;
  - after a succeeded plan, `implement` is dispatched;
  - after two failed planner runs for the same review, `implement` is dispatched and `repair_plan.skipped` is audited.
- **Submit validation:** a plan that misses a blocking finding number is rejected with the missing numbers.
- **Packets:** the repair-mode implement packet renders the plan section for the matching review run and omits a plan from an earlier review.
- **Spec conflict:**
  - an implementer `spec_conflict` blocks the task with `spec_conflict_json` and the `spec conflict:` reason;
  - a planner `spec_conflict` does the same;
  - `accept-amendment` amends the spec (proposed text, or override text), requeues with attempt 0, and clears the conflict;
  - `accept-amendment` returns 409 without a conflict;
  - leaving `blocked` by `unblock` clears the conflict.
- **Migrations:** `runs.kind` accepts `repair_plan`; `tasks.spec_conflict_json` exists after migrating.

Smoke run: the existing no-LLM daemon `apps/colonyd/e2e/fake-colonyd.ts` (`FakeProviderAdapter` plus `ScriptedAgentRuntimeAdapter`, scripted at runtime through `POST /control/script` on the control port) gains scripted `repair_planner` envelopes and an implementer `spec_conflict` knob. Driven over its HTTP API, it runs two cases end to end:

- request_changes with a plan-flagged finding → `repair_plan` run → an implement packet that contains the plan;
- implementer `spec_conflict` → blocked task in `colony_status` → `accept-amendment` → requeued task whose spec includes the amendment.
