# Run No-Progress Recovery Design

## Goal

Prevent an agent run from remaining indefinitely `running` while its lease renews but its model/session loop makes no progress, and prevent reviewer-requested repair runs from returning a task to `mr_open` without advancing beyond the rejected head.

## Observed failures

On 2026-09-04, implement runs for `col-c8f58a57.3` twice emitted a successful assistant turn after a tool result and then produced no run events for roughly ten minutes. The one-minute lease heartbeat continued, so dead-lease recovery could not distinguish the silent run from a healthy run.

The subsequent repair run submitted `complete` with the same head SHA (`c14c7589…`) rejected by the preceding reviewer. Colonyd accepted the envelope and transitioned the task to `mr_open`, despite the reviewer finding remaining unresolved.

## Scope

This change covers Pi-backed architect, plan-review, implement, and review runs. Deterministic merge-gate and validation executors retain their existing command timeouts.

The change adds:

- runtime progress and active-operation signals;
- a colonyd no-progress watchdog;
- in-session model fallback after a stalled model turn;
- structured no-progress events and fault attribution;
- an implementer submit guard requiring reviewer-requested repairs to advance the rejected head;
- API fields needed to diagnose an active run.

It does not add a new task state, retry queue, agent role, or general workflow engine.

## Progress contract

`AgentRuntimeAdapter.run` accepts an optional progress callback. Pi runners report these transitions:

- model request started;
- model response activity received;
- tool execution started;
- tool execution finished;
- submission accepted or rejected;
- model fallback started.

Each signal includes an operation kind and timestamp. Tool-start remains active until the matching tool-finish signal. Model-start remains active until response completion, failure, cancellation, or fallback.

Colonyd stores ephemeral watchdog state for locally executing runs and persists diagnostic fields on `runs`:

- `last_progress_at TEXT`;
- `active_operation TEXT` (`model`, `tool`, `submission`, or null);
- `active_operation_started_at TEXT`;
- `recovery_count INTEGER NOT NULL DEFAULT 0`.

A migration updates existing running rows with `last_progress_at = started_at`; completed rows may leave it null. `GET /runs/:id` and existing scope/task run payloads expose these fields through the shared existing run representation.

The normal lease heartbeat remains unchanged. Lease means process ownership; `last_progress_at` means useful execution movement.

## Watchdog

A shared `RunProgressWatchdog` owned by each Pi run wrapper receives progress signals and evaluates silence using an injected clock/timer seam.

Configuration:

- `COLONY_RUN_NO_PROGRESS_TIMEOUT_MS`, default 600000 (10 minutes), minimum 60000;
- one watchdog check per existing 60-second heartbeat interval.

A run is stalled only when:

- its status is still `running`;
- `now - last_progress_at` exceeds the timeout;
- no tool operation is active.

A long-running tool is never interrupted by this watchdog. Existing tool-specific timeouts remain authoritative.

When model or submission silence crosses the deadline, the watchdog asks the runtime adapter to recover the run rather than finishing the database run. Recovery aborts only the active model turn, preserves the sandbox/workspace/session/transcript, and advances to the next configured model candidate inside the same run. The runtime emits `pi_no_progress_detected`, then the existing `pi_model_fallback` event with reason `agent_no_progress`. Colonyd increments `recovery_count` and refreshes progress state.

If no model candidate remains, the runtime returns a failed result with structured fault `{layer:"agent_runtime", code:"agent_no_progress"}`. Existing run-finalization and task retry policy then applies. Recovery does not increment `tasks.attempt`; only terminal run failure can do so.

Cancellation and daemon shutdown win races with watchdog recovery. Exactly one terminal path may finish a run.

## Unchanged rejected-head guard

The implement packet identifies whether the run is repairing a reviewer rejection and carries the rejected review head SHA already available from the latest review run.

For such runs, `submit_implementer_completion` rejects `status: complete` when `head_sha` equals the rejected review head. The tool returns a corrective message containing the unchanged SHA and the existing bounded reviewer findings. The session remains active so the same agent can edit, commit, push, and resubmit.

A repeated unchanged-head submission from the same model marks that model leg ineffective and invokes the same in-run fallback mechanism. It does not finish the run and does not consume a task attempt. Exhausting all candidates returns structured fault `{layer:"agent_runtime", code:"repair_no_change"}`.

This guard applies only when the current implement run was dispatched because of a reviewer `request_changes`. Initial implementation, interrupted-run recovery, merge-gate repair, and tasks already satisfied on the default branch retain their existing semantics.

Colonyd also performs a final defensive check before transitioning the task to `mr_open`: a reviewer-repair envelope whose verified branch head equals the rejected head is failed as `repair_no_change`. This protects non-Pi adapters and future runtime implementations.

## Failure and restart behavior

Progress fields are persisted on every progress transition, but recovery execution is local to the owning daemon. If colonyd restarts, the existing adopt-and-resume work reconnects the sandbox and session. The resumed run initializes its watchdog from persisted `last_progress_at`; successful adoption records fresh progress before model execution.

A watchdog recovery event is auditable. Errors and reviewer findings use existing redaction and bounded evidence rules.

## Tests

### Agent runtime

A scripted streaming gateway and fake clock reproduce a completed tool turn followed by a model request that never completes. Tests assert:

- timeout aborts the hung turn;
- workspace/session identity is unchanged;
- next model receives the continued session;
- fallback completion succeeds in the same run;
- exhausted candidates return `agent_no_progress`;
- an active long-running tool suppresses the watchdog;
- cancellation wins the recovery race.

Submit-gate tests assert a reviewer-repair completion at the rejected SHA is rejected, a changed pushed SHA is accepted, a second no-change attempt falls back, and exhaustion returns `repair_no_change`.

### Colonyd

Fake-clock run-wrapper tests assert progress persistence, watchdog timing, recovery count, and structured events. Implement orchestration tests assert the final defensive unchanged-head check prevents `running -> mr_open` and records `repair_no_change` for a non-Pi adapter.

Store migration/parity tests cover new columns. HTTP tests prove the diagnostic fields appear on run, task, and scope responses.

## Operational acceptance

A production-like smoke run that deliberately hangs a model turn must emit `pi_no_progress_detected`, retain the same run and sandbox, switch models, and finish without increasing the task attempt. A reviewer-repair run that submits the rejected SHA must remain in the implementation loop and must never transition the task to `mr_open` until its verified branch head changes.
