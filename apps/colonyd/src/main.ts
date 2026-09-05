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
import {
  startTelemetryFromEnv,
  startColonyRunSpan,
} from "@colony/observability";
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
import { SERVICE_ACTOR } from "./context.js";
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
  revokeRunToken,
  revokeTokensForRuns,
  type MintedToken,
} from "./runs/tokens.js";
import {
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
} from "@colony/schemas";
import type { ProviderRepoRef } from "@colony/provider";
import { reconcileRejectedReview } from "./runs/review.js";
import { isAcyclic } from "./runs/architect.js";
import { buildMrDescription, verifyEnvelopeFacts } from "./runs/implement.js";
import {
  buildArchitectPacket,
  buildImplementPacket,
  buildReviewPacket,
} from "./runs/packets.js";
import {
  buildMergeProvenanceLine,
  collectRunModelIds,
  formatColonyModelsTrailer,
} from "./runs/model-provenance.js";
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
        // A resumed run pushes to the provider on its own; the run token
        // minted before the restart died with that process, so re-mint
        // under the same deterministic name. Keep the plaintext in scope:
        // it rides on resumePacket's repo.credentials (the same seam fresh
        // runs use) because Pi reads it for git/API and the surviving
        // sandbox remotes may still hold the invalidated pre-restart token.
        // Revoked in the post-processing finally below, like fresh runs.
        const scope = store.getScope(run.scope_id);
        let minted: MintedToken | null = null;
        let resumeRepo: { id: string; path: string } | null = null;
        if (
          scope &&
          (run.kind === "implement" ||
            run.kind === "architect" ||
            run.kind === "review")
        ) {
          resumeRepo = {
            id: scope.provider_repo_id,
            path: scope.provider_repo_path,
          };
          const name = expectedRunTokenName(run);
          if (name) {
            minted = await mintRunToken(provider, resumeRepo, {
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
        const metadata = await adapter.resumeRun!(
          resumePacket(store, run, minted?.token ?? null),
          {
            role: resumeRole(run.kind),
            runId: run.id,
            sandboxId: run.sandbox_id!,
            sessionsDir: config.sessionsDir,
            connect: (id) => probeEngine.connect(id),
            traceContext: resumeSpan?.spanContext,
          },
        );
        if (metadata.status !== "succeeded") {
          throw new Error(
            `resumed run did not succeed: ${metadata.rejectionReason ?? metadata.status}`,
          );
        }
        const output = await adapter.getRunOutput(run.id);
        try {
          // Resume success drives the same post-processing a fresh run's
          // handler runs after startRun: MR open/reuse + mr_open advance
          // for implement, plan persist for architect, verdict evidence +
          // requeue reconcile for review. Without it the run row reads
          // `succeeded` while the task stays `running` and the next tick
          // requeues or blocks via retryOrFailTask("run_failed").
          if (run.kind === "implement") {
            await completeResumedImplement(store, provider, output, run);
          } else if (run.kind === "architect") {
            completeResumedArchitect(store, output, run);
          } else {
            completeResumedReview({ store }, output, run);
          }
        } finally {
          // The resume path minted above: revoke like every fresh run's
          // finally so the credential never outlives the segment.
          if (minted && resumeRepo) {
            try {
              await revokeRunToken(provider, resumeRepo, minted);
              store.audit(SERVICE_ACTOR, "agent_token.revoked", {
                scope_id: run.scope_id,
                task_id: run.task_id,
                run_id: run.id,
              });
            } catch (err) {
              store.audit(SERVICE_ACTOR, "agent_token.revoke_failed", {
                scope_id: run.scope_id,
                task_id: run.task_id,
                run_id: run.id,
                detail: {
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            }
          }
        }
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

/**
 * Finish a resumed implement segment the way executeImplement finishes a
 * fresh run: validate the completion, open (or reuse) the task MR, record
 * branch provenance, and advance the task to mr_open. A resumed sandbox
 * cannot push new commits, so the envelope's branch/head facts are verified against the provider exactly as the fresh
 * path does before any transition.
 */
async function completeResumedImplement(
  store: Store,
  provider: ColonydContext["provider"],
  output: { envelope: unknown } | null,
  run: Run,
): Promise<void> {
  const parsed = output
    ? implementerCompletionV2Schema.safeParse(output.envelope)
    : null;
  if (!parsed || !parsed.success) {
    store.finishRun(run.id, "failed", {
      error: "envelope invalid",
      envelope_json: output ? JSON.stringify(output.envelope) : undefined,
    });
    throw new Error("resumed implement envelope invalid");
  }
  const envelope = parsed.data;
  const task = run.task_id ? (store.getTask(run.task_id) ?? null) : null;
  const scope = store.getScope(run.scope_id);
  if (!task || !scope) {
    store.finishRun(run.id, "failed", {
      error: "resumed implement task or scope missing",
      envelope_json: JSON.stringify(envelope),
    });
    throw new Error("resumed implement task or scope missing");
  }
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  if (envelope.status === "blocked") {
    store.finishRun(run.id, "succeeded", {
      envelope_json: JSON.stringify(envelope),
    });
    const current = store.getTask(task.id)!;
    store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      { blocked_reason: envelope.blocked_reason ?? "agent reported blocked" },
    );
    return;
  }
  if (envelope.commands.length === 0) {
    store.finishRun(run.id, "failed", {
      error: "envelope has no command evidence",
      envelope_json: JSON.stringify(envelope),
    });
    throw new Error("resumed implement envelope has no command evidence");
  }
  const verified = await verifyEnvelopeFacts(
    provider,
    repo,
    envelope,
    task.branch ?? `colony/${task.id}`,
  );
  if (!verified.ok) {
    const reason = `envelope facts unverified: ${verified.reason}`;
    store.finishRun(run.id, "failed", {
      error: reason,
      envelope_json: JSON.stringify(envelope),
    });
    throw new Error(reason);
  }
  let mrIid: number | undefined;
  let mrReused = false;
  if (task.mr_iid !== null) {
    try {
      const existing = await provider.mergeRequests.get(
        repo,
        `${scope.provider_repo_id}:${task.mr_iid}`,
      );
      if (existing.state === "opened") {
        mrIid = task.mr_iid;
        mrReused = true;
      }
    } catch (err) {
      if (Number((err as { status?: unknown } | null)?.status) !== 404) {
        throw new Error(
          `existing MR lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (mrIid === undefined && envelope.head_sha === (run.base_sha ?? "")) {
    store.finishRun(run.id, "succeeded", {
      head_sha: envelope.head_sha,
      envelope_json: JSON.stringify(envelope),
      evidence_json: JSON.stringify({ commands: envelope.commands }),
    });
    store.audit(SERVICE_ACTOR, "mr.skipped_noop", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: run.id,
      detail: { head_sha: envelope.head_sha, base_sha: run.base_sha ?? "" },
    });
    const current = store.getTask(task.id)!;
    store.transitionTask(
      current.id,
      current.state_version,
      "merged",
      SERVICE_ACTOR,
      { branch: envelope.branch },
    );
    return;
  }
  const modelIds = collectRunModelIds(
    store.runsForTask(task.id).filter((r) => r.kind === "implement"),
    (id: string) => store.listRunEventsByName(id, "pi_model_fallback"),
  );
  const archIds = collectRunModelIds(
    store.runsForScope(scope.id).filter((r) => r.kind === "architect"),
    (id: string) => store.listRunEventsByName(id, "pi_model_fallback"),
  );
  if (mrIid === undefined) {
    const mr = await provider.mergeRequests.open(repo, {
      source_branch: envelope.branch,
      target_branch: scope.default_branch,
      title: task.title,
      description: buildMrDescription(
        task,
        envelope,
        buildMergeProvenanceLine(archIds, modelIds, []),
      ),
    });
    if (mr.iid === undefined) {
      store.finishRun(run.id, "failed", {
        error: "merge request opened without iid",
        envelope_json: JSON.stringify(envelope),
      });
      throw new Error("merge request opened without iid");
    }
    mrIid = mr.iid;
  }
  let finalHeadSha = envelope.head_sha;
  try {
    const trailer = formatColonyModelsTrailer(modelIds);
    if (trailer) {
      // A resumed segment never amends branch history: the surviving
      // sandbox cannot push, and rewriting commits post-restart would
      // invalidate the envelope's verified head. The trailer still rides
      // in the MR description via buildMergeProvenanceLine above; record
      // why the amend step is skipped so the audit trail is explicit.
      store.audit(SERVICE_ACTOR, "provenance.amend_skipped_resume", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: run.id,
        detail: { head: envelope.head_sha, trailer },
      });
    }
  } catch (amendErr) {
    store.audit(SERVICE_ACTOR, "provenance.amend_failed", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: run.id,
      detail: { head: envelope.head_sha, error: String(amendErr) },
    });
  }
  store.finishRun(run.id, "succeeded", {
    head_sha: finalHeadSha,
    envelope_json: JSON.stringify(envelope),
    evidence_json: JSON.stringify({ commands: envelope.commands }),
  });
  store.audit(SERVICE_ACTOR, mrReused ? "mr.reused" : "mr.opened", {
    scope_id: scope.id,
    task_id: task.id,
    run_id: run.id,
    detail: { mr_iid: mrIid, head_sha: finalHeadSha },
  });
  const current = store.getTask(task.id)!;
  store.transitionTask(
    current.id,
    current.state_version,
    "mr_open",
    SERVICE_ACTOR,
    { branch: envelope.branch, mr_iid: mrIid },
  );
}

/**
 * Finish a resumed architect segment the way executeArchitect finishes a
 * fresh run: validate the decomposition (acyclicity included) and persist
 * scope plan_json. Without the persist the next tick sees a `succeeded`
 * architect run with an empty plan and dispatches a fresh architect.
 */
function completeResumedArchitect(
  store: Store,
  output: { envelope: unknown } | null,
  run: Run,
): void {
  const parsed = output
    ? architectDecompositionV2Schema.safeParse(output.envelope)
    : null;
  if (!parsed || !parsed.success) {
    store.finishRun(run.id, "failed", {
      error: "envelope invalid",
      envelope_json: output ? JSON.stringify(output.envelope) : undefined,
    });
    throw new Error("resumed architect envelope invalid");
  }
  const decomposition = parsed.data;
  if (!isAcyclic(decomposition.tasks.map((t) => t.depends_on))) {
    store.finishRun(run.id, "failed", {
      error: "decomposition dependency graph is cyclic",
      envelope_json: JSON.stringify(decomposition),
    });
    throw new Error("resumed architect decomposition is cyclic");
  }
  store.finishRun(run.id, "succeeded", {
    envelope_json: JSON.stringify(decomposition),
  });
  store.setScopePlan(run.scope_id, JSON.stringify(decomposition));
  store.audit(SERVICE_ACTOR, "scope.plan_proposed", {
    scope_id: run.scope_id,
    run_id: run.id,
    detail: { task_count: decomposition.tasks.length },
  });
}

/**
 * Finish a resumed review segment the way executeReview finishes a fresh
 * run: validate the verdict and record approve/changes_requested evidence
 * (plus the rejected-review requeue reconcile). Without verdict evidence
 * the tick cannot tell approval from silence and dispatches a fresh review.
 */
function completeResumedReview(
  ctx: Pick<ColonydContext, "store">,
  output: { envelope: unknown } | null,
  run: Run,
): void {
  const store = ctx.store;
  const parsed = output
    ? reviewerVerdictV2Schema.safeParse(output.envelope)
    : null;
  if (!parsed || !parsed.success) {
    store.finishRun(run.id, "failed", {
      error: "envelope invalid",
      envelope_json: output ? JSON.stringify(output.envelope) : undefined,
      evidence_json: JSON.stringify({
        head_sha: run.base_sha ?? run.head_sha ?? "",
      }),
    });
    throw new Error("resumed review envelope invalid");
  }
  const envelope = parsed.data;
  const headSha = run.base_sha ?? run.head_sha ?? envelope.head_sha;
  if (envelope.head_sha !== headSha) {
    store.finishRun(run.id, "failed", {
      error: "envelope facts unverified: reviewed head_sha mismatch",
      envelope_json: JSON.stringify(envelope),
      evidence_json: JSON.stringify({ head_sha: headSha }),
    });
    throw new Error("resumed review head_sha mismatch");
  }
  // envelope.head_sha === headSha here (a mismatch fails above).
  const headRef = headSha;
  if (envelope.verdict === "approve") {
    store.finishRun(run.id, "succeeded", {
      head_sha: headRef,
      envelope_json: JSON.stringify(envelope),
      evidence_json: JSON.stringify({ verdict: "approve", head_sha: headRef }),
    });
    store.audit(SERVICE_ACTOR, "review.approved", {
      scope_id: run.scope_id,
      task_id: run.task_id,
      run_id: run.id,
      detail: { head_sha: headRef },
    });
    return;
  }
  store.finishRun(run.id, "succeeded", {
    head_sha: headRef,
    envelope_json: JSON.stringify(envelope),
    evidence_json: JSON.stringify({
      verdict: "request_changes",
      head_sha: headRef,
      findings: envelope.findings,
    }),
  });
  store.audit(SERVICE_ACTOR, "review.changes_requested", {
    scope_id: run.scope_id,
    task_id: run.task_id,
    run_id: run.id,
    detail: { head_sha: headRef, findings_count: envelope.findings.length },
  });
  const task = run.task_id ? (store.getTask(run.task_id) ?? null) : null;
  if (task) {
    reconcileRejectedReview(ctx as ColonydContext, task);
  }
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
 * The re-minted run token rides on repo.credentials exactly like a fresh
 * run's packet — Pi reads it for git/API and redaction.
 */
function resumePacket(
  store: Store,
  run: Run,
  token: string | null,
): AgentRuntimePacket {
  const scope = store.getScope(run.scope_id);
  const task = run.task_id ? (store.getTask(run.task_id) ?? null) : null;
  const credentials = token ? { token } : undefined;
  if (run.kind === "architect" && scope) {
    const project = scope.project_name
      ? (store.getProject(scope.project_name) ?? null)
      : null;
    const files = scope.project_name
      ? store.listProjectFiles(scope.project_name)
      : [];
    const { repo: packetRepo, ...packet } = buildArchitectPacket(
      scope,
      project,
      files,
      { id: scope.provider_repo_id, path: scope.provider_repo_path },
      run.base_sha ?? "",
    );
    return {
      ...packet,
      repo: { ...packetRepo, ...(credentials ? { credentials } : {}) },
    };
  }
  if (run.kind === "review" && scope && task) {
    const project = scope.project_name
      ? (store.getProject(scope.project_name) ?? null)
      : null;
    const files = scope.project_name
      ? store.listProjectFiles(scope.project_name)
      : [];
    const { repo: packetRepo, ...packet } = buildReviewPacket(
      task,
      scope,
      project,
      files,
      { id: scope.provider_repo_id, path: scope.provider_repo_path },
      run.base_sha ?? run.head_sha ?? "",
    );
    return {
      ...packet,
      repo: { ...packetRepo, ...(credentials ? { credentials } : {}) },
    };
  }
  if (run.kind === "implement" && scope && task) {
    const branch = task.branch ?? `colony/${task.id}`;
    const project = scope.project_name
      ? (store.getProject(scope.project_name) ?? null)
      : null;
    const files = scope.project_name
      ? store.listProjectFiles(scope.project_name)
      : [];
    const { repo: packetRepo, ...packet } = buildImplementPacket(
      task,
      scope,
      project,
      files,
      { id: scope.provider_repo_id, path: scope.provider_repo_path },
      branch,
      run.base_sha ?? "",
    );
    return {
      ...packet,
      repo: { ...packetRepo, ...(credentials ? { credentials } : {}) },
    };
  }
  const repo = {
    url: scope?.provider_repo_path ?? "",
    branch: task?.branch ?? `colony/${run.task_id ?? run.scope_id}`,
    base_commit: run.base_sha ?? "",
    ...(credentials ? { credentials } : {}),
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
