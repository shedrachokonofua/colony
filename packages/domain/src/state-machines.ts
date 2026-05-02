import type { Role } from "./actors.js";
import { DomainStateError, domainError, type DomainError } from "./errors.js";

export const SCOPE_STATES = [
  "draft",
  "decomposition_proposed",
  "decomposition_approved",
  "active",
  "scope_review_requested",
  "scope_review_approved",
  "closed",
  "blocked",
  "conflict",
  "canceled",
] as const;

export type ScopeState = (typeof SCOPE_STATES)[number];

export const TASK_STATES = [
  "created",
  "ready",
  "claimed",
  "plan_proposed",
  "plan_review",
  "in_progress",
  "review_requested",
  "changes_requested",
  "merge_ready",
  "merged",
  "closed",
  "blocked",
  "conflict",
  "failed",
  "canceled",
  "pending_sync",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

const SCOPE_STATE_SET: ReadonlySet<ScopeState> = new Set(SCOPE_STATES);
const TASK_STATE_SET: ReadonlySet<TaskState> = new Set(TASK_STATES);

export const isScopeState = (s: string): s is ScopeState =>
  SCOPE_STATE_SET.has(s as ScopeState);
export const isTaskState = (s: string): s is TaskState =>
  TASK_STATE_SET.has(s as TaskState);

export const SCOPE_TERMINAL_STATES: ReadonlySet<ScopeState> = new Set([
  "closed",
  "canceled",
]);
export const TASK_TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "closed",
  "canceled",
  "failed",
]);

export const SCOPE_BRANCH_STATES: ReadonlySet<ScopeState> = new Set([
  "blocked",
  "conflict",
  "canceled",
]);
export const TASK_BRANCH_STATES: ReadonlySet<TaskState> = new Set([
  "blocked",
  "conflict",
  "failed",
  "canceled",
  "pending_sync",
]);

export interface StateTransition<S extends string> {
  readonly from: S;
  readonly to: S;
  readonly owner: Role;
  readonly precondition: string;
}

const SCOPE_FORWARD: ReadonlyArray<StateTransition<ScopeState>> = [
  {
    from: "draft",
    to: "decomposition_proposed",
    owner: "supervisor",
    precondition: "Architect produced a decomposition envelope",
  },
  {
    from: "decomposition_proposed",
    to: "decomposition_approved",
    owner: "human",
    precondition:
      "Reviewer approval + human approval recorded on the spec/DAG gate",
  },
  {
    from: "decomposition_proposed",
    to: "draft",
    owner: "supervisor",
    precondition: "Decomposition rejected; refinement loop trigger",
  },
  {
    from: "decomposition_approved",
    to: "active",
    owner: "supervisor",
    precondition: "Initial ready_tasks computed and persisted",
  },
  {
    from: "active",
    to: "scope_review_requested",
    owner: "supervisor",
    precondition: "Every child task is closed",
  },
  {
    from: "scope_review_requested",
    to: "scope_review_approved",
    owner: "human",
    precondition: "Reviewer scope-review approval + (human approval if policy)",
  },
  {
    from: "scope_review_requested",
    to: "active",
    owner: "supervisor",
    precondition: "Scope review changes_requested; reopen follow-up tasks",
  },
  {
    from: "scope_review_approved",
    to: "closed",
    owner: "supervisor",
    precondition: "Reconcile passed; no pending_sync or conflict remains",
  },
];

const TASK_FORWARD: ReadonlyArray<StateTransition<TaskState>> = [
  {
    from: "created",
    to: "ready",
    owner: "supervisor",
    precondition: "No open blocking deps; spec/DAG approved",
  },
  {
    from: "ready",
    to: "claimed",
    owner: "supervisor",
    precondition: "Atomic UPDATE ... WHERE state='ready' RETURNING",
  },
  {
    from: "claimed",
    to: "plan_proposed",
    owner: "developer",
    precondition: "Developer submitted implementation plan envelope",
  },
  {
    from: "plan_proposed",
    to: "plan_review",
    owner: "reviewer",
    precondition: "Plan reviewer started evaluation",
  },
  {
    from: "plan_review",
    to: "in_progress",
    owner: "supervisor",
    precondition: "Plan reviewer approved developer plan",
  },
  {
    from: "plan_review",
    to: "plan_proposed",
    owner: "supervisor",
    precondition: "Plan reviewer requested changes; developer revises plan",
  },
  {
    from: "in_progress",
    to: "review_requested",
    owner: "supervisor",
    precondition: "Developer envelope next_action=request_review",
  },
  {
    from: "review_requested",
    to: "changes_requested",
    owner: "supervisor",
    precondition: "Reviewer envelope result=changes_requested",
  },
  {
    from: "review_requested",
    to: "merge_ready",
    owner: "supervisor",
    precondition:
      "Reviewer approval + (human approval if required) + pipeline green + no blocking threads",
  },
  {
    from: "changes_requested",
    to: "plan_proposed",
    owner: "supervisor",
    precondition: "Refinement loop iteration starts with a fresh plan",
  },
  {
    from: "merge_ready",
    to: "merged",
    owner: "developer",
    precondition: "Gate open; merge verified by webhook at expected SHA",
  },
  {
    from: "merged",
    to: "closed",
    owner: "supervisor",
    precondition:
      "Reconcile: MR merged at expected SHA + provider issue closed + audit event written",
  },
];

const SCOPE_NON_BRANCH: ReadonlyArray<ScopeState> = SCOPE_STATES.filter(
  (s) => !SCOPE_BRANCH_STATES.has(s) && !SCOPE_TERMINAL_STATES.has(s),
);
const TASK_NON_BRANCH: ReadonlyArray<TaskState> = TASK_STATES.filter(
  (s) => !TASK_BRANCH_STATES.has(s) && !TASK_TERMINAL_STATES.has(s),
);

const SCOPE_BRANCH_TARGETS: ReadonlyArray<ScopeState> = [
  "blocked",
  "conflict",
  "canceled",
];
const TASK_BRANCH_TARGETS: ReadonlyArray<TaskState> = [
  "blocked",
  "conflict",
  "pending_sync",
  "failed",
  "canceled",
];
const SCOPE_RECOVERY_SOURCES: ReadonlyArray<ScopeState> = [
  "blocked",
  "conflict",
];
const TASK_RECOVERY_SOURCES: ReadonlyArray<TaskState> = [
  "blocked",
  "conflict",
  "pending_sync",
];

const branchEntryPrecondition = (to: string): string => {
  switch (to) {
    case "canceled":
      return "Operator cancellation with policy.override capability";
    case "pending_sync":
      return "Provider unreachable during write";
    case "failed":
      return "Run exhausted retries or envelope rejected past cap";
    default:
      return `Supervisor classified ${to} (reconciliation disagreement or external blocker)`;
  }
};

const supervisor: Role = "supervisor";

const SCOPE_BRANCH_ENTRY: ReadonlyArray<StateTransition<ScopeState>> =
  SCOPE_NON_BRANCH.flatMap(
    (from): ReadonlyArray<StateTransition<ScopeState>> =>
      SCOPE_BRANCH_TARGETS.map((to) => ({
        from,
        to,
        owner: supervisor,
        precondition: branchEntryPrecondition(to),
      })),
  );

const TASK_BRANCH_ENTRY: ReadonlyArray<StateTransition<TaskState>> =
  TASK_NON_BRANCH.flatMap(
    (from): ReadonlyArray<StateTransition<TaskState>> =>
      TASK_BRANCH_TARGETS.map((to) => ({
        from,
        to,
        owner: supervisor,
        precondition: branchEntryPrecondition(to),
      })),
  );

const SCOPE_RECOVERY: ReadonlyArray<StateTransition<ScopeState>> =
  SCOPE_RECOVERY_SOURCES.flatMap(
    (from): ReadonlyArray<StateTransition<ScopeState>> =>
      SCOPE_NON_BRANCH.map((to) => ({
        from,
        to,
        owner: supervisor,
        precondition: `Recovery from ${from}; supervisor reconciliation succeeded`,
      })),
  );

const TASK_RECOVERY: ReadonlyArray<StateTransition<TaskState>> =
  TASK_RECOVERY_SOURCES.flatMap(
    (from): ReadonlyArray<StateTransition<TaskState>> =>
      TASK_NON_BRANCH.map((to) => ({
        from,
        to,
        owner: supervisor,
        precondition: `Recovery from ${from}; supervisor reconciliation succeeded`,
      })),
  );

export const SCOPE_TRANSITIONS: ReadonlyArray<StateTransition<ScopeState>> = [
  ...SCOPE_FORWARD,
  ...SCOPE_BRANCH_ENTRY,
  ...SCOPE_RECOVERY,
];

export const TASK_TRANSITIONS: ReadonlyArray<StateTransition<TaskState>> = [
  ...TASK_FORWARD,
  ...TASK_BRANCH_ENTRY,
  ...TASK_RECOVERY,
];

const indexTransitions = <S extends string>(
  ts: ReadonlyArray<StateTransition<S>>,
): ReadonlyMap<string, StateTransition<S>> => {
  const m = new Map<string, StateTransition<S>>();
  for (const t of ts) m.set(`${t.from}->${t.to}`, t);
  return m;
};

const SCOPE_INDEX = indexTransitions(SCOPE_TRANSITIONS);
const TASK_INDEX = indexTransitions(TASK_TRANSITIONS);

const lookup = <S extends string>(
  index: ReadonlyMap<string, StateTransition<S>>,
  from: S,
  to: S,
): StateTransition<S> | undefined => index.get(`${from}->${to}`);

export interface TransitionResult<S extends string> {
  readonly ok: boolean;
  readonly transition?: StateTransition<S>;
  readonly error?: DomainError;
}

const checkScope = (from: string, to: string): TransitionResult<ScopeState> => {
  if (!isScopeState(from)) {
    return {
      ok: false,
      error: domainError(
        "UNKNOWN_SCOPE_STATE",
        `unknown scope state: ${from}`,
        { from },
      ),
    };
  }
  if (!isScopeState(to)) {
    return {
      ok: false,
      error: domainError("UNKNOWN_SCOPE_STATE", `unknown scope state: ${to}`, {
        to,
      }),
    };
  }
  if (SCOPE_TERMINAL_STATES.has(from)) {
    return {
      ok: false,
      error: domainError(
        "TERMINAL_STATE",
        `scope is in terminal state ${from}; reopen requires explicit capability`,
        { from, to },
      ),
    };
  }
  const transition = lookup(SCOPE_INDEX, from, to);
  if (!transition) {
    return {
      ok: false,
      error: domainError(
        "INVALID_SCOPE_TRANSITION",
        `scope cannot transition ${from} -> ${to}`,
        { from, to },
      ),
    };
  }
  return { ok: true, transition };
};

const checkTask = (from: string, to: string): TransitionResult<TaskState> => {
  if (!isTaskState(from)) {
    return {
      ok: false,
      error: domainError("UNKNOWN_TASK_STATE", `unknown task state: ${from}`, {
        from,
      }),
    };
  }
  if (!isTaskState(to)) {
    return {
      ok: false,
      error: domainError("UNKNOWN_TASK_STATE", `unknown task state: ${to}`, {
        to,
      }),
    };
  }
  if (TASK_TERMINAL_STATES.has(from)) {
    return {
      ok: false,
      error: domainError(
        "TERMINAL_STATE",
        `task is in terminal state ${from}; reopen requires explicit capability`,
        { from, to },
      ),
    };
  }
  const transition = lookup(TASK_INDEX, from, to);
  if (!transition) {
    return {
      ok: false,
      error: domainError(
        "INVALID_TASK_TRANSITION",
        `task cannot transition ${from} -> ${to}`,
        { from, to },
      ),
    };
  }
  return { ok: true, transition };
};

export const checkScopeTransition = checkScope;
export const checkTaskTransition = checkTask;

export const canTransitionScope = (from: ScopeState, to: ScopeState): boolean =>
  checkScope(from, to).ok;
export const canTransitionTask = (from: TaskState, to: TaskState): boolean =>
  checkTask(from, to).ok;

export const assertScopeTransition = (
  from: ScopeState,
  to: ScopeState,
): StateTransition<ScopeState> => {
  const r = checkScope(from, to);
  if (!r.ok || !r.transition) throw new DomainStateError(r.error!);
  return r.transition;
};

export const assertTaskTransition = (
  from: TaskState,
  to: TaskState,
): StateTransition<TaskState> => {
  const r = checkTask(from, to);
  if (!r.ok || !r.transition) throw new DomainStateError(r.error!);
  return r.transition;
};
