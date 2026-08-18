import {
  FakeAgentRuntimeAdapter,
  type AgentRunEnvironment,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
import { FakeProviderAdapter } from "@colony/provider";
import type { ColonydContext } from "../src/context.js";
import type { GateExecutor } from "../src/runs/merge-gate.js";
import type { ValidateExecutor } from "../src/runs/validate.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

export interface ScriptKnobs {
  architectStall: boolean;
  implementerStall: boolean;
  implementerFailures: Map<string, number>;
  gateFailOnceFor?: string;
  gateCalls: Map<string, number>;
  reviewerRejectFirst: boolean;
  reviewerCalls: number;
  validateFail: boolean;
  validateFailFirstFor: Set<string>;
  // internal counters for validation retry per scope
  _validateCalls: Map<string, number>;
  projectId?: string;
  distinctShas?: boolean;
  implementerCalls?: Map<string, number>;
  singleTask?: boolean;
}

/**
 * Lightweight deferred used to stall agent runs until cancelRun resolves.
 */
function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export class ScriptedAgentRuntimeAdapter extends FakeAgentRuntimeAdapter {
  private architectGate: {
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;
  private implementerGate: {
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;

  constructor(
    private readonly script: ScriptKnobs,
    private readonly provider: FakeProviderAdapter,
  ) {
    super({
      envelopeForRun: (packet, env) =>
        ScriptedAgentRuntimeAdapter.buildEnvelope(
          packet,
          env,
          script,
          provider,
        ),
    });
  }

  override async startRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunEnvironment,
  ): Promise<import("@colony/agent-runtime").AgentRunMetadata> {
    if (runEnvironment.role === "architect" && this.script.architectStall) {
      if (!this.architectGate) this.architectGate = createDeferred();
      const gate = this.architectGate;
      // Race: flag may have been cleared between outer check and gate creation.
      // If stall is now false the new gate would never be resolved — resolve it immediately.
      if (!this.script.architectStall) {
        gate.resolve();
        this.architectGate = null;
      } else {
        await gate.promise;
      }
    }
    if (runEnvironment.role === "developer" && this.script.implementerStall) {
      if (!this.implementerGate) this.implementerGate = createDeferred();
      const gate = this.implementerGate;
      if (!this.script.implementerStall) {
        gate.resolve();
        this.implementerGate = null;
      } else {
        await gate.promise;
      }
    }
    return super.startRun(packet, runEnvironment);
  }

  override async cancelRun(
    runId: string,
  ): Promise<import("@colony/agent-runtime").AgentRunMetadata | null> {
    if (this.architectGate) {
      this.architectGate.resolve();
      this.architectGate = null;
    }
    if (this.implementerGate) {
      this.implementerGate.resolve();
      this.implementerGate = null;
    }
    // expose method to unstall via external control
    return super.cancelRun(runId);
  }

  /** Allow control endpoint to unstall without a cancel. */
  unstallArchitect(): void {
    if (this.architectGate) {
      this.architectGate.resolve();
      this.architectGate = null;
    }
  }

  unstallImplementer(): void {
    if (this.implementerGate) {
      this.implementerGate.resolve();
      this.implementerGate = null;
    }
  }

  private static buildEnvelope(
    packet: AgentRuntimePacket,
    environment: AgentRunEnvironment,
    script: ScriptKnobs,
    provider: FakeProviderAdapter,
  ): unknown {
    if (environment.role === "architect") {
      if (script.singleTask) {
        return {
          kind: "architect_decomposition",
          summary: "Single-task decomposition.",
          acceptance: [{ description: "fake goal holds", command: "true" }],
          tasks: [{ title: "Task A", spec: "Do A.", depends_on: [] }],
        };
      }
      const body =
        typeof packet.body === "string" ? (packet.body as string) : "";
      const isReplan = body.includes(
        "## Operator feedback on your previous plan",
      );
      if (isReplan) {
        return {
          kind: "architect_decomposition",
          summary: "Revised decomposition addressing operator feedback.",
          acceptance: [{ description: "fake goal holds", command: "true" }],
          tasks: [
            { title: "Revised Task A", spec: "Do revised A.", depends_on: [] },
            {
              title: "Revised Task B",
              spec: "Do revised B.",
              depends_on: [0],
            },
          ],
        };
      }
      return {
        kind: "architect_decomposition",
        summary: "Two-task decomposition: A then B.",
        acceptance: [{ description: "fake goal holds", command: "true" }],
        tasks: [
          { title: "Task A", spec: "Do A.", depends_on: [] },
          { title: "Task B", spec: "Do B.", depends_on: [0] },
        ],
      };
    }

    if (environment.role === "reviewer") {
      const headSha =
        typeof packet.head_sha === "string" ? packet.head_sha : SHA_A;
      script.reviewerCalls += 1;
      if (script.reviewerRejectFirst && script.reviewerCalls === 1) {
        return {
          kind: "reviewer_verdict",
          verdict: "request_changes",
          summary: "Need changes.",
          findings: [
            {
              severity: "major",
              file: "index.js",
              note: "version endpoint missing",
            },
          ],
          head_sha: headSha,
        };
      }
      return {
        kind: "reviewer_verdict",
        verdict: "approve",
        summary: "Looks good.",
        findings: [],
        head_sha: headSha,
      };
    }

    // developer
    const taskId = String(packet.task_id ?? "unknown");
    const remaining = script.implementerFailures.get(taskId) ?? 0;
    if (remaining > 0) {
      script.implementerFailures.set(taskId, remaining - 1);
      throw new Error("simulated implementer failure");
    }
    const projectId = script.projectId ?? "fake-project-1";
    if (!script.implementerCalls)
      script.implementerCalls = new Map<string, number>();
    const calls = (script.implementerCalls.get(taskId) ?? 0) + 1;
    script.implementerCalls.set(taskId, calls);
    const headSha = script.distinctShas
      ? (
          (taskId.endsWith(".1") ? "a" : "b") +
          String(calls).padStart(2, "0") +
          "0".repeat(37)
        ).slice(0, 40)
      : taskId.endsWith(".1")
        ? SHA_A
        : SHA_B;
    const branch = `colony/${taskId}`;
    // mirror loop test: create branch so envelope verification passes
    void provider.branches.create({ id: projectId }, branch, headSha);
    return {
      kind: "implementer_completion",
      status: "complete",
      summary: `Implemented ${taskId}.`,
      branch,
      head_sha: headSha,
      commands: [{ cmd: "npm test", exit_code: 0 }],
    };
  }
}

export interface ScriptedBoundary {
  provider: FakeProviderAdapter;
  agents: ColonydContext["agents"];
  gateExecutor: GateExecutor;
  validateExecutor: ValidateExecutor;
  script: ScriptKnobs;
}

function wrapValidateSet(script: ScriptKnobs, base: Set<string>): Set<string> {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "add") {
        return (value: string) => {
          const had = target.has(value);
          if (!had) script._validateCalls.delete(value);
          return target.add(value);
        };
      }
      if (prop === "delete") {
        return (value: string) => {
          script._validateCalls.delete(value);
          return target.delete(value);
        };
      }
      if (prop === "clear") {
        return () => {
          script._validateCalls.clear();
          return target.clear();
        };
      }
      const v = Reflect.get(target, prop);
      if (typeof v === "function")
        return (v as (...args: unknown[]) => unknown).bind(target);
      return v;
    },
  }) as unknown as Set<string>;
}

export function createScriptedBoundary(): ScriptedBoundary {
  const provider = new FakeProviderAdapter();
  const script: ScriptKnobs = {
    architectStall: false,
    implementerStall: false,
    implementerFailures: new Map<string, number>(),
    gateFailOnceFor: undefined,
    gateCalls: new Map<string, number>(),
    reviewerRejectFirst: false,
    reviewerCalls: 0,
    validateFail: false,
    validateFailFirstFor: new Set<string>(),
    _validateCalls: new Map<string, number>(),
  };
  // Wrap validateFailFirstFor so direct Set mutation (e.g. .add() in tests)
  // correctly resets the per-scope counter, not just patchScript.
  script.validateFailFirstFor = wrapValidateSet(
    script,
    script.validateFailFirstFor,
  );

  script.implementerCalls = new Map<string, number>();
  const adapter = new ScriptedAgentRuntimeAdapter(script, provider);
  // Make *Stall reactive: assigning false unblocks the waiting deferred.
  // This lets tests toggle stall via direct property assignment.
  let _implementerStall = script.implementerStall;
  Object.defineProperty(script, "implementerStall", {
    get() {
      return _implementerStall;
    },
    set(v: boolean) {
      _implementerStall = v;
      if (!v) adapter.unstallImplementer();
    },
    enumerable: true,
    configurable: true,
  });
  let _architectStall = script.architectStall;
  Object.defineProperty(script, "architectStall", {
    get() {
      return _architectStall;
    },
    set(v: boolean) {
      _architectStall = v;
      if (!v) adapter.unstallArchitect();
    },
    enumerable: true,
    configurable: true,
  });
  // Make distinctShas/reactive for review loop
  let _distinctShas = script.distinctShas ?? false;
  Object.defineProperty(script, "distinctShas", {
    get() {
      return _distinctShas;
    },
    set(v: boolean) {
      _distinctShas = v;
    },
    enumerable: true,
    configurable: true,
  });

  const agents: ColonydContext["agents"] = {
    runtime: "fake",
    architect: adapter,
    developer: adapter,
    reviewer: adapter,
  };

  const gateExecutor: GateExecutor = async (input) => {
    const taskId = input.taskBranch.replace(/^colony\//, "");
    const calls = (script.gateCalls.get(taskId) ?? 0) + 1;
    script.gateCalls.set(taskId, calls);
    if (script.gateFailOnceFor === taskId && calls === 1) {
      return {
        reason: "command_failed",
        commands: [{ cmd: "npm test", exit_code: 1, tail: ["boom"] }],
      };
    }
    return null;
  };

  const validateExecutor: ValidateExecutor = async (input) => {
    if (script.validateFail) {
      return {
        passed: false,
        results: [
          {
            index: 0,
            description: "fake",
            command: "false",
            exit_code: 1,
            tail: ["boom"],
          },
        ],
      };
    }
    const scopeId = input.scopeId;
    if (scopeId && script.validateFailFirstFor.has(scopeId)) {
      const count = script._validateCalls.get(scopeId) ?? 0;
      script._validateCalls.set(scopeId, count + 1);
      if (count === 0) {
        return {
          passed: false,
          results: [
            {
              index: 0,
              description: "fake",
              command: "false",
              exit_code: 1,
              tail: ["boom"],
            },
          ],
        };
      }
    }
    return {
      passed: true,
      results: [
        {
          index: 0,
          description: "fake",
          command: "true",
          exit_code: 0,
          tail: [],
        },
      ],
    };
  };

  return { provider, agents, gateExecutor, validateExecutor, script };
}

export function serializeScript(script: ScriptKnobs): Record<string, unknown> {
  return {
    architectStall: script.architectStall,
    implementerStall: script.implementerStall,
    implementerFailures: Object.fromEntries(script.implementerFailures),
    gateFailOnceFor: script.gateFailOnceFor ?? null,
    gateCalls: Object.fromEntries(script.gateCalls),
    reviewerRejectFirst: script.reviewerRejectFirst,
    reviewerCalls: script.reviewerCalls,
    validateFail: script.validateFail,
    validateFailFirstFor: [...script.validateFailFirstFor],
    projectId: script.projectId ?? null,
  };
}

export function patchScript(
  script: ScriptKnobs,
  patch: Record<string, unknown>,
  adapter?: ScriptedAgentRuntimeAdapter,
): void {
  if (typeof patch.architectStall === "boolean") {
    script.architectStall = patch.architectStall;
    if (!patch.architectStall) adapter?.unstallArchitect();
  }
  if (typeof patch.implementerStall === "boolean") {
    script.implementerStall = patch.implementerStall;
    if (!patch.implementerStall) adapter?.unstallImplementer();
  }
  if (
    patch.implementerFailures &&
    typeof patch.implementerFailures === "object"
  ) {
    script.implementerFailures = new Map(
      Object.entries(patch.implementerFailures as Record<string, number>),
    );
  }
  if (typeof patch.gateFailOnceFor === "string") {
    script.gateFailOnceFor = patch.gateFailOnceFor;
  } else if (patch.gateFailOnceFor === null) {
    script.gateFailOnceFor = undefined;
  }
  if (typeof patch.reviewerRejectFirst === "boolean") {
    script.reviewerRejectFirst = patch.reviewerRejectFirst;
  }
  if (typeof patch.validateFail === "boolean") {
    script.validateFail = patch.validateFail;
  }
  if (Array.isArray(patch.validateFailFirstFor)) {
    const next = wrapValidateSet(
      script,
      new Set(patch.validateFailFirstFor as string[]),
    );
    // Prune counters for scopes no longer in the set so a re-added scope
    // can fail again on its first validate after being removed.
    for (const key of [...script._validateCalls.keys()]) {
      if (!next.has(key)) script._validateCalls.delete(key);
    }
    script.validateFailFirstFor = next;
  }
}
