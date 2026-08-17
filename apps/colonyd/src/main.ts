import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { env, loadColonyConfig } from "@colony/config";
import { Store } from "@colony/core";
import { startTelemetryFromEnv } from "@colony/observability";
import { FakeProviderAdapter } from "@colony/provider";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import { createAgentWiring, createRunEventSink } from "./agent-runtime.js";
import type { ColonydContext } from "./context.js";
import { buildApp } from "./http.js";
import { consoleLogger } from "./logging.js";
import { abortRuns, awaitPendingRuns } from "./runs/registry.js";
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
  /** Test seam: skip the HTTP server + interval timer. */
  readonly headless?: boolean;
}

export interface ColonydHandle {
  readonly ctx: ColonydContext;
  /** Run one tick (single-flight guarded). Exported for tests. */
  tick(): Promise<void>;
  /** Graceful shutdown: stop timer + server, abort runs, close store. */
  shutdown(): Promise<void>;
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

  const store = new Store(environment.COLONYD_DB_PATH);

  const provider =
    options.provider ??
    (config.agentRuntime === "fake" && !environment.GITLAB_TOKEN
      ? new FakeProviderAdapter()
      : new GitLabProviderAdapter({
          baseUrl: environment.GITLAB_BASE_URL,
          token: environment.GITLAB_TOKEN || undefined,
        }));

  // Crash recovery: rows left `running` belong to a dead process.
  // Revoke any project tokens those runs minted before dying.
  const orphans = store.expireOrphanedRuns();
  await revokeTokensForRuns(store, provider, orphans);

  const agents =
    options.agents ??
    (await createAgentWiring(config, createRunEventSink(store)));
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

  const ctx: ColonydContext = {
    store,
    provider,
    config,
    agents,
    logger,
    gateExecutor: options.gateExecutor,
    validateExecutor: options.validateExecutor,
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
    },
    requestTick: () => {
      void runTick();
    },
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof serve> | undefined;

  if (!options.headless) {
    const app = buildApp(ctx);
    server = serve({ fetch: app.fetch, port: environment.COLONYD_PORT });
    logger.info(
      { port: environment.COLONYD_PORT },
      "colonyd http server listening",
    );
    interval = setInterval(() => {
      void runTick();
    }, environment.COLONYD_TICK_MS);
    // Startup recovery + immediate first reconciliation.
    void runTick();
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await abortRuns([...ctx.store.activeRuns().map((r) => r.id)]);
    await awaitPendingRuns();
    store.close();
    await shutdownTelemetry();
  };

  return { ctx, tick: runTick, shutdown };
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
