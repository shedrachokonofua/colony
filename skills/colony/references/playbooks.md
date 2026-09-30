# Operator playbooks

Procedures for running the factory. Each step names the MCP tool and the CLI
equivalent (exact CLI syntax: `colony --help`). Read
[lifecycle.md](lifecycle.md) for what each guard enforces.

## 1. Triage a session

1. `colony_status` (`colony status`) — everything waiting on you.
2. Plan approvals → playbook 2. Awaiting merge → playbook 5.
   Blocked work → playbook 4. Stalled/failed runs → playbook 6.

## 2. Approve or reject a plan

The scope sits in `planning` with a proposed plan.

1. `get_scope` (`colony scope <id>`) — read the plan and the task graph.
2. Check: does the decomposition cover the goal? Are dependencies sane? Any
   task that should not exist?
3. Good: `approve_plan` (`colony approve <id>`) — tasks materialize and work
   starts immediately. This spends budget; approve only what was asked.
4. Bad: `replan` (`colony replan <id> --feedback <file>`) with concrete,
   durable feedback (what is wrong, what a revision must address). The
   architect revises against the feedback.

## 3. Hold work (deploys, incidents, bad daemon builds)

1. `scope_action pause` per active scope (`colony pause <id>`). Live runs are
   aborted and their tasks requeued — nothing is lost or double-charged.
2. Do the thing (see [deploy.md](deploy.md) for Colony rollouts).
3. `scope_action resume` (`colony resume <id>`) — each scope returns to the
   status it left.

Prefer pause over abandon. Pause is the only reversible hold.

## 4. Unblock stuck work

A task or scope is `blocked` with a `blocked_reason`.

1. `get_task` / `get_scope` — reason, state version, attempt count.
2. `get_run` + `run_events` on the failing runs (all pages!) — see
   [investigation.md](investigation.md). Unblock only when the evidence says
   the blocker is gone (bad commit reverted, quota restored, daemon rolled
   out, spec clarified).
3. Task: `task_action unblock` (`colony task <id> unblock`) — resets the
   attempt to 0 and requeues. A stale unblock on healed work can spawn a
   duplicate implement under a live review: the guard refuses if the task is
   no longer blocked.
4. Scope: `scope_action unblock` — back to planning (no tasks), active (has
   tasks), or validating with a fresh validate budget.
5. Plan-review block (scope `blocked` but keeps its plan):
   `scope_action plan-review-continue` (back to the architect under a fresh
   review budget), `scope_action plan-review-approve` (human override:
   materialize the held plan as is), or `replan` with feedback (reject it;
   `replan` reaches a held plan as well as a pending one).
6. Main-pipeline block (reason names a head SHA and jobs): fix the named
   jobs first — run the manual job, retry the infra-failed job, or land the
   CI fix on the default branch — then `scope_action unblock`. The gate
   re-checks the default branch pipeline before validation starts, so an
   unblock before the pipeline is healthy blocks again.

## 5. Review an open MR

The task is `mr_open`.

1. `get_task` — MR iid, branch, head SHA, reviewer findings on the runs.
2. Needs work: `task_action request-changes` with feedback
   (`colony task <id> request-changes --feedback <file>`) — the implementer
   continues on the same branch/MR. Any in-flight review is aborted; your
   feedback supersedes it.
3. Ready on a manual-approvals scope: `task_action approve-merge` with the
   exact head `sha` you reviewed (`colony task <id> approve-merge --sha <sha>`).
   If the head moved the server answers `409 HEAD_MOVED` — re-read the diff
   before approving again.
4. Auto-approvals scopes need no approve-merge; the merge gate proceeds.

## 6. Correct work in flight

- Wrong or outdated spec: `task_action amend` with the amendment text
  (`colony task <id> amend --spec <file>`). The amendment is authoritative
  over conflicting earlier requirements. A running implementer is steered
  onto it (or aborted and requeued without spending an attempt); an in-flight
  review is aborted so nothing verdicts the old spec.
- Run wedged but healthy otherwise: `task_action stop` (`colony task <id>
stop`) — abort and requeue without spending an attempt.
- Queued but delayed: `task_action retry` — dispatch now.
- A decision agents must follow (a provider choice, a URL, an authz rule, a
  first-deploy fact): `add_directive` (`POST /scopes/:id/directives`). It is
  appended to the scope's durable directives, which every later architect,
  plan reviewer, implementer and code reviewer reads, in any unfinished
  state — including `blocked` and `active` scopes with no plan to replan.
  It changes neither plan nor status; runs in flight keep their packet.
  Prefer it to growing the project brief: it is scoped, audited and
  timestamped.

## 7. Discard work (last resort)

- One task: `task_action cancel`; bring it back later with
  `task_action restore`.
- Whole scope: `scope_action abandon` (`colony abandon <id> --yes`) —
  cancels every task and aborts runs. Permanent; terminal status. Confirm
  with the user first.

## 8. Amend acceptance criteria

The world moved under the scope's acceptance checks (runtime swap, substrate
change): `PATCH /scopes/:id/acceptance` with the new criteria list
(API-only), then `scope_action revalidate` while the scope is `validating`.
