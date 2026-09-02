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
import { startTelemetryFromEnv } from "@colony/observability";
import { createRunAuditSink } from "@colony/agent-runtime";
import { FakeProviderAdapter } from "@colony/provider";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import {
  createAgentWiring,
  createEngine,
  createRunEventSink,
} from "./agent-runtime.js";
import type { ColonydContext } from "./context.js";
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
} from "./runs/registry.js";
import type { GateExecutor } from "./runs/merge-gate.js";
import { revokeTokensForRuns } from "./runs/tokens.js";
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

  // Crash recovery: rows left `running` belong to a dead process.
  // Revoke any repo tokens those runs minted before dying.
  const orphans = store.expireOrphanedRuns();
  await revokeTokensForRuns(store, provider, orphans);

  const agents =
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
    ));
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
    // In-flight run handlers record their own canceled/failed results from
    // the abort; the controller only needs to stop them.
    abortAll: async (ids) => {
      await abortRuns(ids);
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
    await drain.wait();
    store.close();
    await shutdownTelemetry();
  };

  return { ctx, tick: runTick, notifier, shutdown, drain };
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
