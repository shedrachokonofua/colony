import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { env, loadColonyConfig } from "@colony/config";
import {
  buildTaskCostModel,
  createArtifactStore,
  Store,
  type Run,
} from "@colony/core";
import { startTelemetryFromEnv, startColonyRunSpan } from "@colony/observability";
import { createRunAuditSink } from "@colony/agent-runtime";
import { readSessionHeader } from "@colony/agent-runtime/session-store";
import { FakeProviderAdapter } from "@colony/provider";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import {
  createAgentWiring,
  createEngine,
  createRunEventSink,
} from "./agent-runtime.js";
import type { ColonydContext } from "./context.js";
import type {
  AgentRuntimeAdapter,
  AgentRuntimePacket,
  AgentRuntimeRole,
} from "@colony/agent-runtime";
import {
  createDrainController,
  type DrainController,
  type DrainDeps,
} from "./drain.js";
import { buildApp } from "./http.js";
import { consoleLogger } from "./logging.js";
import {
  createNotifierLoop,
  type NotifierLoop,
} from "./notifications/index.js";
import {
  abortRuns,
  activeTrackedRunIds,
  awaitPendingRuns,
  detachRun,
} from "./runs/registry.js";
import type { GateExecutor } from "./runs/merge-gate.js";
import {
  expectedRunTokenName,
  mintRunToken,
  revokeTokensForRuns,
} from "./runs/tokens.js";
import { adoptOrExpireRuns } from "./runs/adoption.js";
import { tick } from "./tick.js";

export interface BootOptions {
  /** Test seam: override the provider adapter (defaults to GitLab or fake). */
  readonly provider?: ColonydContext["provider"];
  /** Test seam: override the agent wiring (defaults to config-driven wiring). */
  readonly agents?: ColonydContext["agents"];
  /** Test seam: override the merge-gate executor. */
  readonly gateExecutor?: GateExecutor;
  /** Test seam: override the validation command runner. */
  readonly validateExecutor?: ColonydContext["validateExecutor"];
  /** Test seam: override the sandbox engine used for scope validation. */
  readonly validateEngine?: ColonydContext["validateEngine"];
  /** Test seam: override fetch implementation for notifications. */
  readonly notifierFetchImpl?: typeof fetch;
  /** Test seam: skip the HTTP server + interval timer. */
  readonly headless?: boolean;
}

export interface ColonydHandle {
  readonly ctx: ColonydContext;
  /** Run one tick (single-flight guarded). Exported for tests. */
  tick(): Promise<void>;
  /** Notifier loop handle (present only when notifications are enabled). */
  readonly notifier?: NotifierLoop;
  /** Graceful shutdown: stop timer + server, drain runs, close store. */
  shutdown(): Promise<void>;
  /** Bounded drain state machine; `shutdown()` awaits `drain.wait()`. */
  readonly drain: DrainController;
}

export async function boot(options: BootOptions = {}): Promise<ColonydHandle> {
  const shutdownTelemetry = startTelemetryFromEnv("colonyd");
  const environment = env();
  const logger = consoleLogger("colonyd");

  const config = loadColonyConfig({
    path: environment.COLONY_CONFIG_PATH,
    agentRuntimeOverride: environment.AGENT_RUNTIME,
    sandboxEngineOverride: environment.COLONY_SANDBOX_ENGINE,
  });

  // A run-storage dir that cannot be created must kill BOOT, loudly - not
  // every run, quietly. The relative defaults resolve against cwd, which in
  // the pod is a root-owned /workspace: artifacts detonated this way on
  // 2026-08-30, sessions on 2026-09-01 (17 runs EACCES'd and re-blocked
  // half the fleet before anyone noticed the pattern).
  mkdirSync(config.sessionsDir, { recursive: true });

  // Provisioning is cheap and idempotent (in-process by default in fake
  // mode), so the validate engine is always created at boot.
  const validateEngine =
    options.validateEngine ??
    (await createEngine(config.sandbox.engine, config));

  const store = new Store(environment.COLONYD_DB_PATH);

  const artifacts = createArtifactStore(config.artifacts);

  const provider =
    options.provider ??
    (config.agentRuntime === "fake" && !environment.GITLAB_TOKEN
      ? new FakeProviderAdapter()
      : new GitLabProviderAdapter({
          baseUrl: environment.GITLAB_BASE_URL,
          token: environment.GITLAB_TOKEN || undefined,
        }));

  // Boot adoption replaces the old blanket orphan sweep: classify every
  // `running` row, fail+revoke the non-adoptable, claim and resume the rest.
  // This runs BEFORE the agent wiring is constructed so the k8s engine built
  // inside it registers the adopted exclusion set before any provision() can
  // trigger its startup cleanup. The probe engine only ever connects —
  // connect never provisions and never cleans up.
  const probeEngine = await createEngine(config.sandbox.engine, config);
  const adoptedIds = new Set<string>();
  let wiredAgents: ColonydContext["agents"] | undefined;
  const ensureAgents = async (): Promise<ColonydContext["agents"]> => {
    if (wiredAgents) return wiredAgents;
    // Claims all precede the resume loop, so rows already marked adopted are
    // the complete claim set even when this first fires mid-resume.
    for (const claimed of store.activeRuns()) {
      if (claimed.adopted === 1 && claimed.sandbox_id) {
        adoptedIds.add(claimed.sandbox_id);
      }
    }
    wiredAgents =
      options.agents ??
      (await createAgentWiring(
        config,
        createRunEventSink(store),
        {
          // Fresh history per architect session: landed-attempt cost model from
          // the runs table, paired with the developer session budget.
          provider: () => ({
            model: buildTaskCostModel(
              store.db
                .prepare(
                  "SELECT * FROM runs WHERE status = 'succeeded' AND kind IN ('implement','merge_gate')",
                )
                .all() as Run[],
            ),
            budget_ms: config.forAgent("developer").ceilings.timeoutMs,
          }),
        },
        createRunAuditSink(store, artifacts, logger),
        store,
        adoptedIds,
      ));
    return wiredAgents;
  };

  const adoption = await adoptOrExpireRuns({
    store,
    provider,
    logger,
    sessionsDir: config.sessionsDir,
    connect: (id) => probeEngine.connect(id),
    resume: async (run) => {
      // A FRESH root span for the resumed segment — never the run's old
      // trace_id: that trace's parent span belongs to a dead process.
      const resumeSpan = startColonyRunSpan({
        scope_id: run.scope_id,
        task_id: run.task_id,
        run_id: run.id,
        kind: run.kind,
        model_id: run.model_id,
      });
      try {
        // A resumed implement run pushes to the provider on its own; the
        // run token minted before the restart died with that process, so
        // re-mint under the same deterministic name. The revoke sweep at
        // finish covers the new token id the same way a fresh run's is.
        const scope = store.getScope(run.scope_id);
        if (scope && (run.kind === "implement" || run.kind === "architect" || run.kind === "review")) {
          const repo = { id: scope.provider_repo_id, path: scope.provider_repo_path };
          const name = expectedRunTokenName(run);
          if (name) {
            const minted = await mintRunToken(provider, repo, {
              name,
              scopes:
                run.kind === "implement"
                  ? ["api", "write_repository"]
                  : ["api", "read_repository"],
              singleToken: environment.COLONYD_SINGLE_TOKEN,
              fallbackToken: environment.GITLAB_TOKEN || undefined,
            });
            if (minted?.token_id) store.setRunToken(run.id, minted.token_id);
          }
        }
        const agents = await ensureAgents();
        const adapter = resumeAdapter(agents, run.kind);
        const metadata = await adapter.resumeRun!(resumePacket(store, run), {
          role: resumeRole(run.kind),
          runId: run.id,
          sandboxId: run.sandbox_id!,
          sessionsDir: config.sessionsDir,
          connect: (id) => probeEngine.connect(id),
          traceContext: resumeSpan?.spanContext,
        });
        if (metadata.status !== "succeeded") {
          throw new Error(
            `resumed run did not succeed: ${metadata.rejectionReason ?? metadata.status}`,
          );
        }
        // Record the continuation's envelope on the run row; task-state
        // advancement stays with the tick reconciler (the existing requeue).
        const output = await adapter.getRunOutput(run.id);
        const envelope =
          output?.envelope as { head_sha?: unknown; commands?: unknown } | undefined;
        store.finishRun(run.id, "succeeded", {
          ...(typeof envelope?.head_sha === "string"
            ? { head_sha: envelope.head_sha }
            : {}),
          ...(output ? { envelope_json: JSON.stringify(output.envelope) } : {}),
          ...(Array.isArray(envelope?.commands)
            ? {
                evidence_json: JSON.stringify({ commands: envelope!.commands }),
              }
            : {}),
        });
        // The resume path's own emitEvent owns this event when the adapter
        // reports one; adapters without the seam (fake runtime) rely on this
        // fallback so run_events always records the resumption.
        if (store.listRunEventsByName(run.id, "run_resumed").length === 0) {
          store.appendRunEvent(run.id, "run_resumed", {
            sandbox_id: run.sandbox_id,
            entries_loaded: readSessionHeader(config.sessionsDir, run.id)
              .entries,
          });
        }
        resumeSpan?.end("succeeded");
      } catch (err) {
        resumeSpan?.end(
          "failed",
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }
    },
    resumeLeaseTtlMs: environment.COLONY_RESUME_LEASE_TTL_MS,
  });
  for (const run of adoption.adoptable) {
    if (run.sandbox_id) adoptedIds.add(run.sandbox_id);
  }

  const agents = options.agents ?? (await ensureAgents());
  if (config.reviewMode === "required" && !agents.reviewer) {
    throw new Error(
      "review.mode is 'required' but no reviewer agent is configured",
    );
  }

  let tickRunning = false;
  let tickRequested = false;

  const runTick = async (): Promise<void> => {
    if (tickRunning) {
      tickRequested = true; // coalesce: one more pass after the current one
      return;
    }
    tickRunning = true;
    try {
      await tick(ctx);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "tick.crashed",
      );
    } finally {
      tickRunning = false;
    }
    if (tickRequested) {
      tickRequested = false;
      void runTick();
    }
  };

  const drainDeps: DrainDeps = {
    now: () => Date.now(),
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
    pollMs: 250,
    timeoutMs: environment.COLONY_DRAIN_TIMEOUT_MS,
    // Registry ids, not store rows: a DB row can sit 'running' with no
    // in-process handler (crash recovery paths), and aborting untracked ids
    // is a no-op that would stall shutdown until the cap. The registry is the
    // source of truth for work this process can still abort and await.
    activeRunIds: activeTrackedRunIds,
    // At the drain cap the controller aborts exactly once, here. Partition
    // first: architect/implement/review runs with a session journal and a
    // sandbox are handed to the next boot — lease pushed out, never aborted,
    // never finished, never token-revoked, `adopted` stays 0 so the boot-time
    // adoptRun claim wins. Everything else (validate, merge_gate, unqualified)
    // takes today's abort path; handlers record their own canceled result.
    abortAll: async (ids) => {
      for (const id of ids) {
        const run = store.getRun(id);
        const resumable =
          run !== undefined &&
          run.status === "running" &&
          (run.kind === "architect" ||
            run.kind === "implement" ||
            run.kind === "review") &&
          run.sandbox_id !== null &&
          readSessionHeader(config.sessionsDir, run.id).ok;
        if (resumable) {
          // heartbeatRun only — NEVER adoptRun: the next boot's claim must be
          // the one that flips `adopted` and writes the run.adopted audit row.
          store.heartbeatRun(run.id, environment.COLONY_RESUME_LEASE_TTL_MS);
          // Dropped from the registry, not aborted: the SDK loop dies with
          // the process, and the row stays `running` for the next boot.
          detachRun(run.id);
        }
      }
      await abortRuns(activeTrackedRunIds());
    },
    awaitSettled: awaitPendingRuns,
  };
  const drain = createDrainController(drainDeps);

  const ctx: ColonydContext = {
    store,
    provider,
    config,
    agents,
    artifacts,
    logger,
    gateExecutor: options.gateExecutor,
    validateExecutor: options.validateExecutor,
    validateEngine,
    env: {
      gitlabBaseUrl: environment.GITLAB_BASE_URL,
      gitlabToken: environment.GITLAB_TOKEN,
      webhookSecret: environment.GITLAB_WEBHOOK_SECRET,
      singleToken: environment.COLONYD_SINGLE_TOKEN,
      maxConcurrent: environment.COLONYD_MAX_CONCURRENT,
      maxAttempts: environment.COLONYD_MAX_ATTEMPTS,
      resumeLeaseTtlMs: environment.COLONY_RESUME_LEASE_TTL_MS,
      oidcIssuer: environment.COLONY_OIDC_ISSUER,
      oidcClientId: environment.COLONY_OIDC_CLIENT_ID,
      oidcRequiredRole: environment.COLONY_OIDC_REQUIRED_ROLE,
      traceUiBaseUrl: environment.COLONY_TRACE_UI_BASE_URL ?? "",
      consoleBaseUrl: environment.COLONY_CONSOLE_BASE_URL ?? "",
    },
    requestTick: () => {
      void runTick();
    },
    draining: drain,
  };

  const notifier = config.notifications.enabled
    ? createNotifierLoop({
        store: ctx.store,
        logger: ctx.logger,
        notifications: config.notifications,
        consoleBaseUrl: environment.COLONY_CONSOLE_BASE_URL ?? "",
        fetchImpl: options.notifierFetchImpl,
      })
    : undefined;

  let tickInterval: NodeJS.Timeout | undefined;
  let notifierInterval: NodeJS.Timeout | undefined;
  let server: ReturnType<typeof serve> | undefined;

  if (!options.headless) {
    const app = buildApp(ctx);
    server = serve({ fetch: app.fetch, port: environment.COLONYD_PORT });
    logger.info(
      { port: environment.COLONYD_PORT },
      "colonyd http server listening",
    );
    tickInterval = setInterval(() => {
      void runTick();
    }, environment.COLONYD_TICK_MS);
    // Startup recovery + immediate first reconciliation.
    void runTick();

    if (notifier) {
      notifierInterval = setInterval(() => {
        void notifier.run();
      }, environment.COLONYD_NOTIFY_MS);
      void notifier.run();
    }
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    drain.beginDrain();
    clearInterval(tickInterval);
    clearInterval(notifierInterval);
    if (server) {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    }
    const drainOutcome = await drain.wait();
    if (drainOutcome === "aborted") {
      // Resumable survivors were partitioned inside drainDeps.abortAll; the
      // remaining work settled through awaitSettled above.
    }
    store.close();
    await shutdownTelemetry();
  };

  return { ctx, tick: runTick, notifier, shutdown, drain };
}

/** Map a run kind to the adapter role its resume speaks. */
function resumeRole(kind: Run["kind"]): AgentRuntimeRole {
  if (kind === "architect") return "architect";
  if (kind === "review") return "reviewer";
  return "developer";
}

/** Pick the wired adapter whose resumeRun continues this kind. */
function resumeAdapter(
  agents: ColonydContext["agents"],
  kind: Run["kind"],
): AgentRuntimeAdapter {
  if (kind === "architect") return agents.architect;
  if (kind === "review") return agents.reviewer ?? agents.architect;
  return agents.developer;
}

/**
 * Rebuild the packet a resumed segment speaks from. Continuity context
 * (review findings, gate failures, execution mode) is durably persisted in
 * the session journal the agent re-reads; the fresh packet re-anchors repo
 * and task identity so the steer turn has the same fields a fresh run had.
 */
function resumePacket(store: Store, run: Run): AgentRuntimePacket {
  const scope = store.getScope(run.scope_id);
  const task = run.task_id ? (store.getTask(run.task_id) ?? null) : null;
  const repo = {
    url: scope?.provider_repo_path ?? "",
    branch: task?.branch ?? `colony/${run.task_id ?? run.scope_id}`,
    base_commit: run.base_sha ?? "",
  } as const;
  if (run.kind === "architect") {
    return {
      kind: "architect_scope",
      scope_id: run.scope_id,
      goal: scope?.goal ?? "",
      body: `Scope goal: ${scope?.goal ?? ""}`,
      repo,
    };
  }
  return {
    kind: "implement_task",
    task_id: run.task_id,
    scope_id: run.scope_id,
    goal: task?.title ?? scope?.goal ?? "",
    body:
      task?.spec ??
      `Task: ${task?.title ?? scope?.goal ?? ""} — continue the interrupted attempt.`,
    repo,
  };
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/src/main.ts") === true;

if (isDirectRun && process.env["COLONYD_TEST_BOOT"] !== "1") {
  const logger = consoleLogger("colonyd");
  const handle = await boot();
  const stop = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await handle.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}
