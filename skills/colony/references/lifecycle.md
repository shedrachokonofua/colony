# Lifecycle: states, transitions, blocked reasons

Grounded in `packages/core/src/state-machine.ts` and the operator routes in
`apps/colonyd/src/http.ts`.

## Task states

`queued`, `running`, `mr_open`, `merged`, `blocked`, `canceled`.

Terminal: `merged`, `canceled` (a canceled task can still be `restore`d).

Legal transitions:

| From     | To                                         |
| -------- | ------------------------------------------ |
| queued   | running, merged, canceled                  |
| running  | mr_open, merged, queued, blocked, canceled |
| mr_open  | merged, queued, blocked, canceled          |
| merged   | — (terminal)                               |
| blocked  | queued, merged, canceled                   |
| canceled | queued (via restore)                       |

What moves a task:

- `queued → running`: an implement run is dispatched.
- `running → mr_open`: the implementer's envelope verified and an MR opened
  (or reused) for the branch.
- `mr_open → merged`: merge gate passed and the host reports merged at the
  gated SHA.
- `mr_open → queued`: gate failed (requeued with evidence) or an operator
  requests changes / amends the spec.
- `running → blocked`: attempts exhausted, or the agent itself reported
  `blocked` with a reason.

## Scope statuses

`draft`, `planning`, `active`, `validating`, `blocked`, `paused`, `done`,
`abandoned`.

Terminal: `done`, `abandoned` (a `done` scope reopens to `active` when a
task is restored).

Legal transitions:

| From       | To                                                 |
| ---------- | -------------------------------------------------- |
| draft      | planning, abandoned                                |
| planning   | active, blocked, paused, abandoned                 |
| active     | done, blocked, abandoned, validating, paused       |
| validating | done, active, planning, blocked, paused, abandoned |
| blocked    | planning, active, validating, paused, abandoned    |
| paused     | planning, active, validating, blocked, abandoned   |
| done       | active                                             |
| abandoned  | — (terminal)                                       |

What moves a scope:

- `planning`: the architect is drafting (or revising) a plan. Approving the
  plan materializes tasks and moves on; replan keeps it in planning.
- `active`: tasks are executing.
- `validating`: all tasks landed; acceptance checks run as a validate run.
- `blocked`: no runnable work remains (architect attempts spent, plan-review
  budget spent, or everything terminal but validation failed).
- `paused`: operator hold; live runs aborted and their tasks requeued. The
  status it left is remembered and returned by resume.

## Operator verbs and their state guards

Scope (`scope_action` / `colony pause|resume|abandon|revalidate`):

| Verb       | Allowed when                          | Effect                                                                           |
| ---------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| pause      | planning, active, validating, blocked | abort live runs, requeue their tasks, park the scope                             |
| resume     | paused and quiescent                  | back to the remembered status                                                    |
| revalidate | validating                            | dispatch a fresh validate run (none in flight)                                   |
| unblock    | blocked                               | back to planning/active/validating (fresh validate budget if validation-blocked) |
| abandon    | any non-terminal                      | cancel every task, abort runs — PERMANENT                                        |

Task (`task_action` / `colony task <id> <verb>`):

| Verb            | Allowed when                        | Effect                                                                  |
| --------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| retry           | queued                              | clear the retry delay (run now)                                         |
| stop            | running                             | abort the attempt, requeue without spending an attempt                  |
| cancel          | non-terminal (scope not abandoned)  | discard — PERMANENT                                                     |
| restore         | canceled                            | requeue with attempt 0; reopens a done/blocked/validating scope         |
| unblock         | blocked                             | requeue with attempt 0; reactivates a scope blocked on it               |
| amend           | not merged/canceled                 | append an authoritative spec amendment; steer or restart in-flight work |
| request-changes | mr_open                             | feedback to the implementer; requeue, branch and MR kept                |
| approve-merge   | mr_open on a manual-approvals scope | approve merging at a named head SHA                                     |

Violating a guard answers `409` with a machine code (`NOT_PAUSABLE`,
`NOT_PAUSED`, `NOT_VALIDATING`, `NO_PLAN_PENDING`, `NOT_RUNNING`,
`NOT_QUEUED`, `NOT_CANCELED`, `NO_OPEN_MR`, `TASK_FINISHED`,
`SCOPE_ABANDONED`, `HEAD_MOVED`, `RUN_NOT_LOCAL`, `CONFLICT`). The message
names the requirement; fix the precondition instead of retrying.

## Blocked reasons

`task.blocked_reason` / `scope.blocked_reason` is free text written at block
time. Recurring shapes:

- the agent reported `blocked` with its own reason (envelope `status=blocked`);
- attempts exhausted after repeated run failures (reason includes the last
  failure);
- repeated merge-gate failures on one head SHA;
- plan-review rejections exhausted the plan-review budget (scope keeps
  `plan_json` — recoverable via the plan-review escape endpoints,
  see [playbooks.md](playbooks.md));
- operator action recorded its own reason.

Always read the reason **and** the runs/events behind it before unblocking.
