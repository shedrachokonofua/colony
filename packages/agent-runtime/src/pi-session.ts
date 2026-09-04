import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@opentelemetry/api";
import type { Model } from "@oh-my-pi/pi-ai";
import {
  SessionManager,
  Settings,
  buildWorkspaceTree,
  createAgentSession,
  discoverContextFiles,
  type AgentSession,
  type AuthStorage,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import type { SandboxHandle } from "@colony/sandbox";
import type { CredentialBroker } from "./credential-broker.js";
import type { RunAuditSink } from "./audit-sink.js";
import type {
  AgentRunEnvironment,
  AgentRuntimePacket,
  AgentRuntimeRole,
} from "./adapter.js";
import { packetObjective } from "./run-steering.js";
import {
  DEFAULT_PI_RUN_TIMEOUT_MS,
  buildSubagentSystemPrompt,
  installRunGuards,
  sanitizeSecret,
  type PiModelSpec,
  type PiRunnerLogger,
} from "./pi-runner-common.js";
import {
  PI_RUNTIME_BINDING_NAME,
  toSdkThinkingLevel,
  type ColonyThinkingLevel,
} from "./pi-roles.js";
import { RunSteering } from "./run-steering.js";
import { RunEvidenceCollector } from "./run-evidence.js";
import { verifyPushedHead } from "./sandbox-tools.js";
import { createSubagentTool } from "./subagent-tool.js";
import { inTraceContext } from "./trace-context.js";

/**
 * Tools whose successful use proves the agent actually looked at the
 * repository. Deliberately broad: grok-4.6 (Cursor-native priors)
 * inspected a diff with glob + no-op edit probes + reading subagents,
 * never once calling read/grep, and the old read/grep-only gate
 * rejected its honest submits three times in one run (2026-09-01,
 * b2896f12: 216 edit probes, 45 minutes, no envelope).
 */
const REPOSITORY_INSPECTION_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  bash: true,
  task: true,
};

/**
 * Quota exhaustion (weekly caps, frequency limits with a distant reset)
 * never recovers inside a jiggle window: fail over immediately instead of
 * burning wake cycles against a benched provider. "No deployments
 * available" is litellm's cooldown wrapper - once a leg is benched every
 * caller sees it instead of the underlying quota error, and waiting out
 * 300s cooldown windows one empty turn at a time is never better than
 * moving to the fallback (the next run returns to the primary anyway).
 * Includes credit exhaustion: a 402 "Insufficient balance" from a provider
 * leg (Cline, 2026-09-03) is a dead leg, not a model failure.
 */
const QUOTA_ERROR_RE =
  /usage exceeds|frequency limit|weekly.*(usage|limit)|quota.*(exceed|exhaust|reset)|rate.?limit.*reset at|no deployments available|insufficient balance|\b402\b/i;

/**
 * A leg whose only answers are transport/5xx failures is dead, but a single
 * blip is not a verdict: {@link MODEL_CONNECTION_ERROR_LIMIT} consecutive
 * connection-class errors on the CURRENT model with no successful turn in
 * between is the budget. Deliberately free of 429/rate-limit/quota/overload
 * arms — those are the quota path's job and must keep failing over at once.
 */
export const CONNECTION_ERROR_RE =
  /\b50[0234]\b|\b529\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|connection.{0,12}(?:error|refused|reset|closed|timed? ?out)|service unavailable|bad gateway|gateway timeout|upstream.{0,8}(?:connect|request failed)|no capacity|network error|stream stall|Request timed out\b/i;

/** Consecutive connection-class failures that settle a provider leg as dead. */
export const MODEL_CONNECTION_ERROR_LIMIT = 5;

export const COLONY_ADVISOR_NAME = "colony-critic";
export const COLONY_ADVISOR_INSTRUCTIONS = [
  "Emit nit for feedback that can wait.",
  "Emit blocker only when the primary must stop or change course immediately.",
  "Never emit concern.",
].join(" ");

/**
 * Advisors review the run journal, so only the session that owns it gets one.
 * The architect is excluded: its staged sessions plan and verify, and a
 * critic second-guessing a plan mid-discovery derails the decomposition.
 */
export function shouldEnableColonyAdvisor(
  role: AgentRuntimeRole,
  journal: "run" | "transient",
  hasAdvisorModel: boolean,
): boolean {
  return hasAdvisorModel && role !== "architect" && journal === "run";
}

function provisionAdvisorAgentDir(
  model: PiModelSpec,
  parentDir = tmpdir(),
): string {
  const dir = mkdtempSync(join(parentDir, "colony-advisor-"));
  try {
    const instructions = COLONY_ADVISOR_INSTRUCTIONS.replaceAll("\n", " ");
    writeFileSync(
      join(dir, "WATCHDOG.yml"),
      [
        "advisors:",
        `  - name: ${COLONY_ADVISOR_NAME}`,
        `    model: ${model.provider}/${model.id}:xhigh`,
        "    tools: [read, grep, glob]",
        "    instructions: |",
        `      ${instructions}`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The run-scoped state the session's guards and hooks write back into, and
 * that the prompt loop reads to drive the model. The runner owns it and
 * passes it in; {@link buildPiSession} and the loop share it, so a resumed
 * segment continues the same accounting rather than restarting it.
 */
export interface PiRunState {
  /** Set by the run-timeout guard, the workspace probe, and the guards. */
  failureReason?: string;
  /** An inspection-class tool call has looked at the repository. */
  repositoryInspected: boolean;
  /** A provider went mute; the run loop owns the jiggle/failover policy. */
  zeroOutputStalled: boolean;
  /** Set when the run-timeout guard fired. */
  timeoutTriggered: boolean;
  /** Operator cancellation: ends the run at once, no salvage pass. */
  cancellationTriggered: boolean;
  /** Wake cycles spent on the current model; reset by any tool call. */
  jigglesUsed: number;
  /** Consecutive connection-class errors on the current model. */
  connectionErrors: number;
  /** Message of the newest connection-class error on the current model. */
  lastConnectionError?: string;
  /**
   * Messages below this index belong to an earlier model: quota errors are
   * only honoured for the current one, so a stale 403 from twenty minutes
   * ago cannot demote a healthy provider.
   */
  quotaScanFloor: number;
  /**
   * Why the terminal tool last refused a submission. Recorded by the guard
   * subscription's end-event seam and read at finalization, so a run that
   * never submitted reports the refusal instead of a generic no-submission.
   */
  submissionRejectionReason?: string;
}

/** Everything the builder needs that its caller has already resolved. */
export interface PiSessionInput {
  readonly runId: string;
  readonly sandboxId: string;
  /** Session cwd: the provisioned repo or scratch workspace. */
  readonly cwd: string;
  readonly packet: AgentRuntimePacket;
  /** Carries the run root span context the SDK's GenAI spans nest under. */
  readonly environment: AgentRunEnvironment;
  /**
   * Overrides the environment's span context. A resumed segment nests under
   * its own fresh root, never the pre-restart trace's context.
   */
  readonly traceContext?: Context;
  /** Journal to build on: a fresh one, or the resumed run's reloaded file. */
  readonly sessionManager: SessionManager;
  readonly submitTool: ToolDefinition;
  readonly customTools: readonly ToolDefinition[];
  readonly toolNames: readonly string[];
  readonly primaryModel: Model;
  readonly scopedModels: readonly Model[];
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly broker: CredentialBroker;
  readonly steering: RunSteering;
  /** Sandbox-routed file/shell tools; empty when no engine is configured. */
  readonly sandboxTools: readonly ToolDefinition[];
  /** Prepended to the harness blocks; the resume path varies it. */
  readonly systemPrompt: string;
  /**
   * Whether this session owns the durable journal. A staged role's run
   * session is never prompted; its first stage owns the transcript path.
   */
  readonly journal: "run" | "transient";
  /**
   * The run's critic model, already resolved against the registry by the
   * caller. Only the journal-owning session of a non-architect role runs
   * one; an unavailable advisor must never fail the primary run.
   */
  readonly advisorModel?: Model;
  readonly advisorSpec?: PiModelSpec;
  /** Role the advisor gate consults; the architect never gets a critic. */
  readonly role: AgentRuntimeRole;
}

/** Runner-level knobs the builder reads but does not decide. */
export interface PiSessionOptions {
  readonly webTools?: unknown;
  readonly thinkingLevel?: ColonyThinkingLevel;
  readonly defaultThinkingLevel: ColonyThinkingLevel;
  readonly maxTurns: number;
  readonly runTimeoutMs?: number;
  /** Bounds the SDK's own same-model retry budget inside one prompt. */
  readonly retryMaxRetries?: number;
  readonly logger?: PiRunnerLogger;
  readonly auditSink?: RunAuditSink;
  readonly logToolArgs?: boolean;
  /** The packet's repo token: a live secret for the evidence redactor. */
  readonly runToken?: string;
  /** Where the advisor's private agent dir is created; unset means tmpdir. */
  readonly scratchDir?: string;
}

/**
 * Reviewer-repair gating: a repair that re-submits the head the reviewer
 * already rejected changed nothing. Two such submissions fall over to the
 * next model candidate; exhausting them ends the run rather than scoring a
 * repair that never happened.
 */
export interface RepairRejectionPolicy {
  /** The head the reviewer rejected; undefined when this is not a repair. */
  readonly rejectedHead?: string;
  /**
   * Verdict for one submission of the unchanged rejected head. `failover`
   * names the candidate the builder must switch to; `exhausted` means no
   * candidate remains and the run must end.
   */
  readonly onUnchanged: () =>
    | { action: "reject" }
    | { action: "failover"; model: Model }
    | { action: "exhausted" };
}

/** Callbacks routing the built session into the caller's run-scoped decisions. */
export interface PiSessionHooks {
  readonly state: PiRunState;
  readonly requireRepositoryInspection: boolean;
  readonly verifyPushedHead?: boolean;
  readonly handle?: SandboxHandle;
  /** Custom run abort (e.g. aborting child sessions first). */
  readonly abortRun?: () => Promise<void>;
  /** Live subagent sessions to track for graceful parent abort. */
  readonly childSessions?: Set<AgentSession>;
  /** Suppresses the submit-deadline nudge once an envelope landed. */
  readonly submissionCaptured?: () => boolean;
  /** Names the tool the deadline nudge points at (a stage's, not the run's). */
  readonly submitNameOf?: () => string;
  /** Names the live stage in tool logs; the run session has none. */
  readonly stageNameOf?: () => string | undefined;
  readonly repairRejection?: RepairRejectionPolicy;
}

/** The live session plus the wiring its caller drives the loop with. */
export interface PiSession {
  readonly session: AgentSession;
  readonly evidence: RunEvidenceCollector;
  /** Registered in the run session; also handed to stage sessions. */
  readonly goalTool: ToolDefinition;
  /** Registered in the run session; also handed to stages that allow them. */
  readonly subagentTool: ToolDefinition;
  /** Undo the guards and hooks {@link armSession} installed on the run session. */
  readonly unsubscribeGuards: () => void;
  /**
   * Arm one more session with the run's guards and hooks: turn/usd limits,
   * stall and connection accounting, repository-inspection gating on the
   * submit tool, broker authorization, tool observation, and the
   * deadline/drift nudges. The run session and every stage session get the
   * same protection; only the submit tool name varies.
   */
  readonly armSession: (
    target: AgentSession,
    submitName: string,
    observeInspection?: (toolName: string, args: unknown) => void,
  ) => () => void;
  readonly takeSubmitDeadlineNudge: (force?: boolean) => string | null;
  /**
   * Removes the advisor's private agent dir. The runner calls it in
   * teardown, after its own workspace removal; the dir is never inside the
   * checkout, so it outlives the run otherwise.
   */
  readonly removeAdvisorDir: () => void;
  /**
   * The quota verdict of the CURRENT model on `target`, for the jiggle
   * policy. `target` is explicit because a staged run swaps the live session.
   */
  readonly lastAssistantQuotaError: (target?: AgentSession) => string | null;
  /**
   * The run session's own wiring, for sibling sessions that must share it
   * (subagents and the staged pipeline's sessions). A critic that ran on
   * different settings, models, or credentials would not be reviewing the
   * same run.
   */
  readonly buildSessionOptions: (perSession: {
    systemPrompt: string;
    customTools: readonly ToolDefinition[];
    toolNames: readonly string[];
    prewalk: boolean;
    /**
     * Which journal this session persists to. Only the run's own session is
     * evidence, so it alone gets the file-backed manager whose path teardown
     * uploads as the transcript artifact. Subagent and stage sessions are
     * in-memory: they exist to answer one question, and a shared
     * SessionManager path would have every sibling appending to (and
     * rewriting) the run's transcript.
     */
    journal: "run" | "transient";
  }) => Promise<CreateAgentSessionOptions>;
}

/**
 * Builds one colony run session: settings, the subagent and goal tools, the
 * run guards, the before/after tool-call hooks, goal-mode wiring, and
 * `createAgentSession`.
 *
 * ONE builder is the invariant, not a convenience. A resumed agent that lost
 * its submit tool, its guards, or its workspace probe could not finish its
 * task, and a second copy of this block would drift the moment either path
 * gained a registration the other never picked up.
 */
export async function buildPiSession(
  input: PiSessionInput,
  options: PiSessionOptions,
  hooks: PiSessionHooks,
): Promise<PiSession> {
  const state = hooks.state;
  const {
    runId,
    sandboxId,
    cwd,
    packet,
    environment,
    sessionManager,
    submitTool,
    customTools,
    toolNames,
    primaryModel,
    scopedModels,
    authStorage,
    modelRegistry,
    broker,
    steering,
    sandboxTools,
  } = input;
  const traceContext = input.traceContext ?? environment.traceContext;
  // The packet repo token is a live secret: every evidence row must redact
  // it, not just the well-known token patterns.
  const { runToken } = options;
  // Late-bound: the goal tool reads the session that does not exist yet.
  let session: AgentSession | undefined;
  const deadline =
    Date.now() + (options.runTimeoutMs ?? DEFAULT_PI_RUN_TIMEOUT_MS);
  const thinkingLevel = toSdkThinkingLevel(
    options.thinkingLevel ?? options.defaultThinkingLevel,
  );
  // The resolved model is the gate: it is undefined whenever the advisor's
  // provider is unconfigured or its credential is unavailable, and `role`
  // excludes the architect (shouldEnableColonyAdvisor re-checks both per
  // session, since siblings use the transient journal).
  const advisorConfigured =
    input.advisorModel !== undefined && input.role !== "architect";
  let advisorAgentDir: string | undefined;
  if (advisorConfigured) {
    advisorAgentDir = provisionAdvisorAgentDir(
      input.advisorSpec!,
      options.scratchDir,
    );
  }
  const advisorContextFiles = advisorConfigured
    ? discoverContextFiles(cwd)
    : undefined;
  const advisorWorkspaceTree = advisorConfigured
    ? buildWorkspaceTree(cwd)
    : undefined;
  const buildSettings = (enableAdvisor: boolean) =>
    Settings.isolated({
      "compaction.enabled": true,
      "retry.enabled": true,
      // The SDK's auto-retry re-prompts a transient failure same-model
      // with exponential backoff, defaulting to 10 attempts. On a dead
      // leg that spends the whole run wall inside one prompt, so bound
      // the budget the leg may burn before the runner sees an error.
      "retry.maxRetries": options.retryMaxRetries ?? 4,
      "todo.enabled": true,
      "todo.reminders": true,
      "goal.enabled": true,
      "advisor.enabled": enableAdvisor,
      ...(enableAdvisor
        ? {
            "advisor.syncBacklog": "off" as const,
            "retry.modelFallback": false,
            modelRoles: {
              advisor: `${input.advisorSpec!.provider}/${input.advisorSpec!.id}:xhigh`,
            },
          }
        : {}),
      // A dead upstream stream must become a bounded retry, not a
      // run-long hang: muse once sat 31 minutes emitting zero tokens and
      // only the wall clock killed the run. Defaults are -1 (disabled).
      // First-event tolerates worst-case local prefill on a loaded GPU;
      // idle after first token means the generation died mid-stream.
      "providers.streamFirstEventTimeoutSeconds": 600,
      "providers.streamIdleTimeoutSeconds": 300,
      // Builtin web_search: pin the provider so auto-detection never
      // wanders to keyed providers this daemon does not carry.
      ...(options.webTools ? { "providers.webSearchOrder": ["searxng"] } : {}),
    });
  /**
   * Shared session wiring for the run session and its siblings: same
   * models, broker credentials, restriction, and deadline. Only the prompt
   * and tool set vary, so a child can never reach anything the parent
   * could not.
   */
  const buildSessionOptions = async (perSession: {
    systemPrompt: string;
    customTools: readonly ToolDefinition[];
    toolNames: readonly string[];
    prewalk: boolean;
    journal: "run" | "transient";
  }) => {
    const useAdvisor = shouldEnableColonyAdvisor(
      input.role,
      perSession.journal,
      input.advisorModel !== undefined,
    );
    return {
      // Advisor discovery must not walk the untrusted checkout: a project
      // WATCHDOG.yml could otherwise add mutating advisors that bypass the
      // sandbox. The supplied SessionManager still owns the real workspace
      // cwd used by tools and prompts.
      cwd: useAdvisor ? advisorAgentDir! : cwd,
      ...(useAdvisor
        ? {
            agentDir: advisorAgentDir!,
            contextFiles: await advisorContextFiles,
            workspaceTree: await advisorWorkspaceTree,
          }
        : {}),
      model: primaryModel,
      thinkingLevel,
      authStorage,
      modelRegistry,
      getApiKey: async (candidate: { provider: string }) =>
        broker.resolve({
          provider: candidate.provider,
          capability: `agent.llm.${candidate.provider}.invoke`,
          bindingName: PI_RUNTIME_BINDING_NAME,
          environment: environment,
        }),
      scopedModels: [
        ...scopedModels.map((candidate) => ({ model: candidate })),
        ...(input.advisorModel ? [{ model: input.advisorModel }] : []),
      ],
      settings: buildSettings(useAdvisor),
      systemPrompt: perSession.systemPrompt,
      sessionManager:
        perSession.journal === "run"
          ? sessionManager
          : SessionManager.inMemory(cwd),
      // Colony owns every tool a run may call: the sandbox-routed file/shell
      // tools when an engine is configured, plus the role's submit tool and
      // any web tools. Nothing may reach the daemon's own filesystem.
      customTools: [...perSession.customTools],
      toolNames: [...perSession.toolNames],
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      // Arming prewalk keeps the todo tool active, which is what drives omp's
      // mid-run progress reminders.
      ...(perSession.prewalk ? { prewalk: { target: primaryModel } } : {}),
      deadline,
      enableMCP: false,
      enableLsp: false,
      disableExtensionDiscovery: true,
      // GenAI spans only when the caller bound a run root span context:
      // without it no tracing code path may activate. The SDK parents its
      // spans on whatever OTEL context is active at prompt time, which the
      // prompt wrappers bind to environment.traceContext.
      ...(traceContext !== undefined
        ? {
            telemetry: {
              attributes: { "colony.run_id": runId },
            },
          }
        : {}),
    };
  };

  // Subagents: Colony's own task tool. The SDK's native one is unusable
  // here - its child sessions do not inherit customTools/restrictToolNames,
  // which would hand a nested agent builtin tools on the daemon's own
  // filesystem. Children share the sandbox handle and workspace, get the
  // work tools but never submit/goal/task (depth 1, no envelope authority).
  const childCustomTools = [
    ...customTools.filter((tool) => tool.name !== submitTool.name),
    ...sandboxTools,
  ];
  const childToolNames = [
    ...toolNames.filter((name) => name !== submitTool.name),
    ...sandboxTools.map((tool) => tool.name),
  ];
  const subagentTool = createSubagentTool(async ({ prompt, signal }) => {
    const child = await createAgentSession(
      await buildSessionOptions({
        systemPrompt: buildSubagentSystemPrompt(),
        customTools: childCustomTools,
        toolNames: childToolNames,
        prewalk: false,
        journal: "transient",
      }),
    );
    let report = "";
    const unsubscribeReport = child.session.agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = event.message.content
          .filter(
            (block): block is { type: "text"; text: string } =>
              block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("\n");
        if (text.trim()) report = text;
      }
    });
    const unsubscribeChildGuards = installRunGuards(
      child.session.agent,
      `${runId}.sub`,
      {
        maxTurns: 24,
        logger: options.logger,
        abort: () => void child.session.abort(),
      },
    );
    hooks.childSessions?.add(child.session);
    // The parent's turn abort (wall, watchdog, cancel) reaches the child
    // directly; the tool's own race returns the parent's turn regardless.
    const abortChild = () => void child.session.abort();
    signal?.addEventListener("abort", abortChild, { once: true });
    if (signal?.aborted) abortChild();
    try {
      await inTraceContext(
        environment,
        () => child.session.prompt(prompt, { expandPromptTemplates: false }),
        traceContext,
      );
      await child.session.agent.waitForIdle();
      return report;
    } finally {
      signal?.removeEventListener("abort", abortChild);
      hooks.childSessions?.delete(child.session);
      unsubscribeChildGuards();
      unsubscribeReport();
      child.session.dispose();
    }
  });

  // Goal mode: the hidden goal tool is only registered by the SDK when
  // restrictToolNames is off, so Colony registers the SDK's own GoalTool
  // as a custom tool bound to this session through a late-bound adapter
  // (tools are constructed before the session exists).
  const goalTool = new GoalTool({
    getGoalRuntime: () => session?.goalRuntime,
    getGoalModeState: () => session?.getGoalModeState(),
  } as never) as unknown as ToolDefinition;

  // The SDK's injected goal context claims goal completion "ends the
  // autonomous loop" - in Colony only an accepted submission does. This
  // block outranks that copy; without it a model could complete the goal
  // and stop without submitting.
  const harnessBlock = [
    "# Goal and delegation",
    '- Your packet objective is registered as this session\'s persistent goal. Completing the goal NEVER replaces the submit call: your run counts only when a submission is accepted. Call goal({op:"complete"}) at most once, only after your submission is accepted.',
    "- The task tool runs subagents in this same workspace with your work tools (but no submit authority). Delegate independent, self-contained subtasks - research, scoped edits, running checks - and parallelize by issuing several task calls in one turn.",
  ].join("\n");

  const result = await createAgentSession(
    await buildSessionOptions({
      systemPrompt: `${input.systemPrompt}\n\n${steering.budgetBlock()}\n\n${harnessBlock}`,
      customTools: [...customTools, ...sandboxTools, goalTool, subagentTool],
      toolNames: [
        ...toolNames,
        ...sandboxTools.map((tool) => tool.name),
        goalTool.name,
        subagentTool.name,
      ],
      prewalk: true,
      journal: input.journal,
    }),
  );
  session = result.session;
  // The packet objective becomes the session's persistent goal: omp's
  // goal runtime re-injects it across turns, accounts token/time usage,
  // and enforces evidence-based completion discipline.
  session.setGoalModeState({
    enabled: true,
    mode: "active",
    goal: {
      id: runId,
      objective: packetObjective(packet),
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  });
  await session.sendGoalModeContext({ deliverAs: "nextTurn" });
  const abortDeliberate = () => {
    if (hooks.abortRun) {
      void hooks.abortRun();
    } else {
      void session?.abort();
    }
  };
  if (state.timeoutTriggered) {
    abortDeliberate();
  }
  // Rich evidence rows flow through the run's own audit sink; the
  // provider token is a live secret, so it rides the redaction secrets.
  const evidence = new RunEvidenceCollector(
    runId,
    options.auditSink,
    runToken ? [runToken] : [],
  );
  /**
   * Arm one session with the run's guards and hooks. The run session and
   * every stage session get the same protection; only the submit tool name
   * varies.
   */
  const armSession = (
    target: AgentSession,
    submitName: string,
    observeInspection?: (toolName: string, args: unknown) => void,
  ): (() => void) => {
    // Recovery belongs to one session/model leg: a staged session and a
    // fresh guard installation must never inherit a prior leg's stall or
    // submission rejection.
    state.zeroOutputStalled = false;
    state.submissionRejectionReason = undefined;
    const unsubscribeGuards = installRunGuards(target.agent, runId, {
      maxTurns: options.maxTurns,
      logger: options.logger,
      evidence,
      rejectionToolName: submitName,
      onSubmissionRejected: (reason) => {
        const detail = sanitizeSecret(
          reason.replace(/\s+/g, " ").trim(),
          runToken,
        ).slice(0, 400);
        state.submissionRejectionReason =
          detail || "terminal submission was rejected";
      },
      onFailure: (reason) => {
        state.failureReason ??= reason;
      },
      abort: abortDeliberate,
      onZeroOutputStall: () => {
        state.zeroOutputStalled = true;
      },
      // The only place connectionErrors moves. A successful turn - even a
      // text-only one the runner would otherwise never see - proves the
      // leg is alive and clears the budget.
      onAssistantMessage: (message) => {
        if (message.stopReason !== "error") {
          state.connectionErrors = 0;
          state.lastConnectionError = undefined;
          // Real output proves the leg is alive: a stall budget is only
          // spent by consecutive empty turns.
          if (message.outputTokens > 0) {
            state.zeroOutputStalled = false;
            state.jigglesUsed = 0;
          }
          return;
        }
        if (
          message.errorMessage !== undefined &&
          CONNECTION_ERROR_RE.test(message.errorMessage)
        ) {
          state.connectionErrors += 1;
          state.lastConnectionError = message.errorMessage;
        }
      },
    });
    const previousBeforeToolCall = target.agent.beforeToolCall;
    target.agent.beforeToolCall = async (context, signal) => {
      const base = await previousBeforeToolCall?.(context, signal);
      if (base?.block) return base;
      if (
        context.toolCall.name === submitName &&
        hooks.requireRepositoryInspection &&
        !state.repositoryInspected
      ) {
        return {
          block: true,
          reason:
            "Inspect the repository first: read or search real source/test files (read, grep, glob, bash, or a task subagent) before submitting.",
        };
      }
      const repair = hooks.repairRejection?.rejectedHead;
      if (context.toolCall.name === submitName && repair !== undefined) {
        const args = context.args as { status?: unknown; head_sha?: unknown };
        if (args.status === "complete" && args.head_sha === repair) {
          const verdict = hooks.repairRejection!.onUnchanged();
          if (verdict.action === "failover") {
            await target.setModel(verdict.model);
            // A new candidate starts a fresh leg: the stall the old one
            // accumulated says nothing about this one.
            state.zeroOutputStalled = false;
          } else if (verdict.action === "exhausted") {
            state.failureReason = "repair_no_change";
            abortDeliberate();
          }
          return {
            block: true,
            reason: `Submission rejected: reviewer repair did not change rejected head ${repair}. Commit and push a fix, then submit the new remote head SHA.`,
          };
        }
      }
      if (
        context.toolCall.name === submitName &&
        hooks.verifyPushedHead &&
        hooks.handle
      ) {
        const args = context.args as { head_sha?: unknown; branch?: unknown };
        if (
          typeof args.head_sha === "string" &&
          typeof args.branch === "string"
        ) {
          const pushed = await verifyPushedHead(
            hooks.handle,
            args.branch,
            args.head_sha,
          );
          if (pushed && !pushed.ok) {
            return {
              block: true,
              reason: pushed.remoteHead
                ? `origin/${args.branch} is at ${pushed.remoteHead}, not the envelope's head_sha ${args.head_sha}. Push your final commit (git push origin ${args.branch}), confirm with git ls-remote --heads origin ${args.branch}, then submit the SHA that is actually on the remote.`
                : `origin/${args.branch} does not exist on the remote. Push the work branch (git push origin ${args.branch}) before submitting.`,
            };
          }
        }
      }
      const authorized = await broker.authorizeTool?.({
        toolName: context.toolCall.name,
        args: context.args,
        packet: packet,
        environment: environment,
      });
      if (authorized?.allow === false) {
        return { block: true, reason: authorized.reason };
      }
      return undefined;
    };

    const previousAfterToolCall = target.agent.afterToolCall;
    target.agent.afterToolCall = async (context, signal) => {
      const base = await previousAfterToolCall?.(context, signal);
      if (
        !context.isError &&
        REPOSITORY_INSPECTION_TOOLS[context.toolCall.name] === true
      ) {
        state.repositoryInspected = true;
      }
      if (!context.isError) {
        observeInspection?.(context.toolCall.name, context.args);
      }
      // Any real progress proves the leg is alive: a jiggle budget and a
      // connection budget are only spent by consecutive failures.
      state.zeroOutputStalled = false;
      state.jigglesUsed = 0;
      state.connectionErrors = 0;
      steering.observeToolCall(
        context.toolCall.name,
        context.args,
        context.isError,
      );
      // Rejection evidence lives in the guard subscription's end-event
      // seam (see pi-runner-common): it is the only path that sees TypeBox
      // argument-validation refusals, which never reach afterToolCall.
      options.logger?.info?.(
        {
          runId,
          sandboxId,
          tool: context.toolCall.name,
          args: options.logToolArgs ? context.args : undefined,
          isError: context.isError,
        },
        "pi_tool_observation",
      );
      const deadlineNudge = takeSubmitDeadlineNudge();
      const repeatNudge = deadlineNudge
        ? null
        : steering.takeRepeatFailureNudge();
      const nudge = deadlineNudge ?? repeatNudge ?? steering.takeDriftNudge();
      if (!nudge) return base;
      // Fold the reminder in ahead of the tool's own output, the way the omp
      // harness delivers non-interrupting rule reminders.
      options.logger?.warn?.(
        { runId, sandboxId, stage: hooks.stageNameOf?.() },
        deadlineNudge
          ? "pi_submit_deadline_nudge"
          : repeatNudge
            ? "pi_repeat_failure_nudge"
            : "pi_drift_nudge",
      );
      return {
        ...base,
        content: [
          { type: "text" as const, text: nudge },
          ...(base?.content ?? context.result.content),
        ],
      };
    };
    return unsubscribeGuards;
  };

  // A near-deadline reminder also reaches models that keep investigating,
  // but does not advertise a time allowance: models given a number tend to
  // spend it.
  const SUBMIT_DEADLINE_NUDGE_MS = 8 * 60_000;
  let lastDeadlineNudgeAt = Number.NEGATIVE_INFINITY;
  const takeSubmitDeadlineNudge = (force = false): string | null => {
    if (hooks.submissionCaptured?.()) return null;
    const remainingMs = deadline - Date.now();
    if (remainingMs > SUBMIT_DEADLINE_NUDGE_MS) return null;
    if (!force && performance.now() - lastDeadlineNudgeAt < 60_000) return null;
    lastDeadlineNudgeAt = performance.now();
    return [
      "<system-reminder>",
      `The submission window is closing. Stop investigating NOW and call ${hooks.submitNameOf?.() ?? submitTool.name} with the envelope built from what you already know. An unsubmitted run counts for nothing; a conservative submitted verdict beats a perfect unsubmitted one.`,
      "</system-reminder>",
    ].join("\n");
  };

  // Scoped to messages produced by the CURRENT model: an errored turn
  // survives in history across setModel, and tool-call/reasoning turns
  // don't append plain assistant text - so an unscoped "newest assistant
  // error" can be a different model's quota 403 from twenty minutes ago
  // (2026-08-31: grok was demoted mid-run on kimi's stale error).
  const lastAssistantQuotaError = (target?: AgentSession): string | null => {
    const messages = target?.agent.state.messages ?? [];
    for (let i = messages.length - 1; i >= state.quotaScanFloor; i -= 1) {
      const message = messages[i]!;
      if (message.role !== "assistant") continue;
      const err = message.errorMessage;
      return err && QUOTA_ERROR_RE.test(err) ? err : null;
    }
    return null;
  };

  const unsubscribeGuards = armSession(session, submitTool.name);

  return {
    session,
    evidence,
    goalTool,
    subagentTool,
    unsubscribeGuards,
    armSession,
    takeSubmitDeadlineNudge,
    lastAssistantQuotaError,
    buildSessionOptions,
    removeAdvisorDir: () => {
      if (advisorAgentDir === undefined) return;
      rmSync(advisorAgentDir, { recursive: true, force: true });
      advisorAgentDir = undefined;
    },
  };
}
