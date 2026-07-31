# ADR-009: Temporal workflow versioning via patch markers

**Status:** Accepted
**Date:** 2026-07-31

## Context

`scopeSupervisorWorkflow` is long-lived: a scope's supervisor runs for the whole
life of the scope — hours today, potentially days. Colony's workflow code is
also still changing weekly.

Those two facts collide. Temporal replays a workflow's history against the
currently deployed code, so adding, removing or reordering any workflow command
(activity call, timer, signal wait) invalidates every in-flight execution.

This is not theoretical. On 2026-07-31 a worker rollout that inserted one
activity call at supervisor startup produced:

```
[TMPRL1100] Nondeterminism error: Activity type of scheduled event
'checkProviderHealth' does not match activity type of activity command
'readScopeState'
```

Every running scope wedged. The failure mode is nasty: the execution still
reports `Running`, its history simply freezes at a `WorkflowTaskFailed` event
and it never progresses again. `supervisor-col-run3ac5c` went to `Failed`
outright. Several hours were then spent testing fixes against workflows that
had stopped executing before those fixes could run — the fixes looked broken
when they had simply never been reached.

## Decision

Guard every workflow-command-shape change with Temporal's `patched(id)` API,
using stable, dated marker identifiers defined next to the other workflow
constants in `packages/workflows/src/index.ts`.

```ts
if (patched(PATCH_STARTUP_TASK_SYNC)) {
  await activities.syncCommittedTasksToProvider({ scope_id });
}
```

Marker convention: `colony-<yyyy-mm-dd>-<short-description>`. Never reuse,
never rename. Once every execution predating a marker has closed, retire it
with `deprecatePatch(id)` and then delete it.

## Alternatives Considered

- **Worker Build ID versioning.** Temporal's first-class answer: pin each worker
  deployment to a Build ID and let old executions drain on old workers. Correct
  and avoids permanently accreting `patched()` branches, but it requires running
  multiple worker versions concurrently, managing version sets and ramping, and
  Colony currently deploys a single worker Deployment via one tofu apply. The
  operational cost outweighs the benefit at this scale.
- **Terminate in-flight supervisors before every deploy.** What we did manually
  to recover. Cheap, but it throws away scope progress, is trivially forgotten,
  and gets worse exactly as scopes get longer — the opposite of where a dark
  factory is heading.
- **Keep the workflow tiny and push logic into activities.** Genuinely reduces
  the surface that can diverge, and worth doing on the margin, but the
  supervisor's job _is_ orchestration; the command sequence is the logic. It
  narrows the problem without solving it.
- **Do nothing and accept wedging.** Only viable while scopes are short and
  someone is watching. Directly contradicts unattended operation.

## Rationale

`patched()` is the lowest-ceremony option that actually preserves in-flight
work, and it matches how Colony already deploys: one worker version, rolled
forward. It puts the compatibility decision at the exact line that changed,
where the author is already thinking about it, and it leaves a durable marker
in history that explains why the branch exists.

The accretion cost is real but bounded and visible: markers are greppable, and
`deprecatePatch` gives a defined retirement path once scopes predating a marker
have closed.

## Consequences

- Any PR touching workflow command shape must either add a patch marker or state
  why it is safe (pure refactor, no command change).
- Deploys no longer need a terminate-first ritual for patched changes. Until a
  change is patched, the runbook in `docs/handoff-2026-07-31.md` still applies:
  terminate running supervisors, then deploy.
- Markers accumulate in `packages/workflows/src/index.ts` and must be retired
  deliberately; an unretired marker is permanent dead weight.
- Reviewers need to recognise command-shape changes. The heuristic: if the diff
  adds or moves an `await activities.*`, a `sleep`, or a `condition`, it needs a
  patch.
- `patched()` only protects executions started **before** the change ships. It
  cannot rescue an execution that has already diverged — those must be
  terminated and restarted.

## Revisit When

- Scopes routinely outlive several deploys, making unretired markers pile up
  faster than they can be deprecated.
- More than one workflow type exists, or workers need to run concurrent code
  versions for other reasons — at that point Build ID versioning earns its
  operational cost.
- Temporal's TypeScript SDK ships a materially simpler versioning primitive.
