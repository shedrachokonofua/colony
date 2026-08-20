/**
 * Mid-run steering for agent runs.
 *
 * Ported from the omp harness, which keeps a model on task with two hidden
 * injections: a mid-run `<system-reminder>` folded into a tool result when the
 * run drifts, and a continuation steer that restates the objective and budget
 * when the model stops before the work is actually done.
 *
 * Colony had neither, and the run data showed the cost: implement runs that
 * read and shelled for the entire wall clock without writing a file, and runs
 * that went idle without submitting an envelope.
 */

/** Tool calls without a file change or push before the drift nudge fires. */
const NUDGE_AFTER_CALLS = 12;
/** Maximum drift nudges per run: a reminder that repeats becomes noise. */
const MAX_NUDGES = 2;
/** Maximum continuation steers per run before the run is finalized. */
const MAX_CONTINUATIONS = 3;

const PROGRESS_TOOLS = new Set(["write", "edit", "apply_patch", "patch"]);
const PROGRESS_COMMAND = /\bgit\s+(?:commit|push)\b/;

/**
 * One-line objective for a continuation steer: the packet's goal plus the task
 * it belongs to. The full spec is already in the conversation; repeating it
 * would just crowd the context the model still needs.
 */
export function packetObjective(packet: {
  readonly [key: string]: unknown;
}): string {
  const goal = typeof packet["goal"] === "string" ? packet["goal"].trim() : "";
  const taskId =
    typeof packet["task_id"] === "string" ? packet["task_id"] : undefined;
  const label = taskId ? `${taskId}: ` : "";
  return goal
    ? `${label}${goal}`
    : `${label}complete the task specified in this run's packet`;
}

export interface RunSteeringOptions {
  /** Wall-clock budget for the run; the same value that arms the abort guard. */
  readonly runTimeoutMs: number;
  /** Work branch the implementer must push to. */
  readonly branch?: string;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/** Progress-aware nudge/steer generator for a single agent run. */
export class RunSteering {
  #callsSinceProgress = 0;
  #nudges = 0;
  #continuations = 0;
  #pushed = false;
  /** Last failed bash command and its consecutive-failure count. */
  #lastFailedCommand = "";
  #repeatFailures = 0;
  #repeatNudges = 0;
  readonly #startedAt: number;
  readonly #runTimeoutMs: number;
  readonly #branch: string;
  readonly #now: () => number;

  constructor(options: RunSteeringOptions) {
    this.#runTimeoutMs = options.runTimeoutMs;
    this.#branch = options.branch ?? "the work branch";
    this.#now = options.now ?? (() => Date.now());
    this.#startedAt = this.#now();
  }

  /**
   * Record a finished tool call. A file change or a `git commit`/`git push`
   * counts as progress and resets the drift counter. A bash command that
   * fails with the same text as the previous failure feeds the
   * repeated-failure detector (OpenHands' action-error pattern): production
   * runs re-ran a timed-out install verbatim until the wall killed them.
   */
  observeToolCall(tool: string, args?: unknown, isError?: boolean): void {
    const command =
      typeof args === "object" && args !== null
        ? (args as { command?: unknown }).command
        : undefined;
    if (tool === "bash" && typeof command === "string") {
      if (isError) {
        this.#repeatFailures =
          command === this.#lastFailedCommand ? this.#repeatFailures + 1 : 1;
        this.#lastFailedCommand = command;
      } else {
        this.#lastFailedCommand = "";
        this.#repeatFailures = 0;
      }
    }
    const pushed =
      typeof command === "string" && PROGRESS_COMMAND.test(command);
    if (pushed) this.#pushed = true;
    if (pushed || PROGRESS_TOOLS.has(tool)) {
      this.#callsSinceProgress = 0;
      return;
    }
    this.#callsSinceProgress += 1;
  }

  /**
   * Reminder when the same bash command has failed twice in a row verbatim.
   * Fires at most twice per run; re-arms only after a different failure or a
   * success breaks the streak.
   */
  takeRepeatFailureNudge(): string | null {
    if (this.#repeatFailures < 2 || this.#repeatNudges >= 2) return null;
    this.#repeatFailures = 0;
    this.#repeatNudges += 1;
    return [
      "<system-reminder>",
      "The same command just failed twice in a row with the same invocation. Re-running it unchanged will fail again and burns your budget.",
      "Change something before the next attempt: fix the underlying cause, adjust the command (for a timeout, pass the bash tool's timeout parameter in seconds), or take a different route to the same goal.",
      "</system-reminder>",
    ].join("\n");
  }

  /**
   * Reminder to fold into the next tool result when the run has spent many
   * calls without changing or pushing anything. Escalates: the first asks for
   * the concrete plan the exploration should have produced (omp's prewalk-plan
   * demand), the second insists on a pushed checkpoint.
   */
  takeDriftNudge(): string | null {
    if (this.#nudges >= MAX_NUDGES) return null;
    if (this.#callsSinceProgress < NUDGE_AFTER_CALLS) return null;
    const calls = this.#callsSinceProgress;
    this.#callsSinceProgress = 0;
    this.#nudges += 1;
    if (this.#nudges === 1) {
      return [
        "<system-reminder>",
        `${calls} tool calls without a file change. You know enough now; stop exploring and write the plan you will execute: the remaining steps in order, with the exact files, symbols, commands, and checks each one needs.`,
        "Then start executing it in this same turn — do not end your turn on the plan.",
        "</system-reminder>",
      ].join("\n");
    }
    const landed = this.#pushed
      ? "Your pushed commit is the only work that survives this run"
      : "Nothing is on the work branch yet, and a run that is killed keeps only what you pushed";
    return [
      "<system-reminder>",
      `${calls} more tool calls without a file change or push. ${landed}.`,
      `Make the smallest complete change the spec requires, commit it, and \`git push origin ${this.#branch}\` before any further exploration or full-suite run. Then continue.`,
      "</system-reminder>",
    ].join("\n");
  }

  /**
   * Steer that re-prompts a model which stopped without submitting. Consumes
   * one of the run's continuations; returns null once they are spent or the
   * remaining budget is too small to act on.
   */
  takeContinuationSteer(objective: string): string | null {
    if (this.#continuations >= MAX_CONTINUATIONS) return null;
    if (this.remainingMs() <= 60_000) return null;
    this.#continuations += 1;
    return [
      "Continue this task. It is not finished until a submission is accepted.",
      "<objective>",
      objective,
      "</objective>",
      `- Elapsed: ${this.elapsedMinutes()} min of ${this.budgetMinutes()} min budget`,
      `- Pushed a commit so far: ${this.#pushed ? "yes" : "no"}`,
      "NEVER redefine success as a smaller, easier, or already-completed subset of the spec.",
      "If work remains, keep working. If the spec is satisfied, verify it against current repository state (`git log -1`, the diff against the base, the spec's required commands) and then submit.",
    ].join("\n");
  }

  /** System-prompt block telling the model what clock it is on. */
  budgetBlock(): string {
    return [
      "# Run budget",
      `- This run is aborted after ${this.budgetMinutes()} minutes of wall clock. Work that is not pushed when it ends is lost.`,
      "- Push your first commit early and keep pushing; never start a full-suite run with unpushed work.",
    ].join("\n");
  }

  budgetMinutes(): number {
    return Math.round(this.#runTimeoutMs / 60_000);
  }

  elapsedMinutes(): number {
    return Math.round((this.#now() - this.#startedAt) / 60_000);
  }

  remainingMs(): number {
    return Math.max(0, this.#runTimeoutMs - (this.#now() - this.#startedAt));
  }
}
