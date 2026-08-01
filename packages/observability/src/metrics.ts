import {
  metrics,
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type ObservableResult,
  type UpDownCounter,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { performance } from "node:perf_hooks";

const METER_NAME = "@colony/observability";
const METRIC_PREFIX = "colony";
const HTTP_DURATION = `${METRIC_PREFIX}.http.server.request.duration`;
const AGENT_RUN_DURATION = `${METRIC_PREFIX}.agent.run.duration`;
const AGENT_TURN_DURATION = `${METRIC_PREFIX}.agent.turn.duration`;

let provider: MeterProvider | undefined;
let initializedService: string | undefined;

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  readonly metricsPort?: number;
  readonly otlpMetricsEndpoint?: string;
  readonly exportIntervalMs?: number;
}

export interface AgentMetricAttributes {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
}

export function startTelemetryFromEnv(
  serviceName: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): () => Promise<void> {
  return startTelemetry({
    serviceName,
    serviceVersion: environment["COLONY_VERSION"],
    environment: environment["NODE_ENV"],
    metricsPort: positiveInteger(environment["COLONY_METRICS_PORT"]),
    otlpMetricsEndpoint:
      environment["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] || undefined,
    exportIntervalMs: positiveInteger(
      environment["OTEL_METRIC_EXPORT_INTERVAL"],
    ),
  });
}

export function startTelemetry(options: TelemetryOptions): () => Promise<void> {
  if (provider) {
    if (initializedService !== options.serviceName) {
      throw new Error(
        `telemetry already initialized for ${initializedService}; cannot initialize ${options.serviceName}`,
      );
    }
    return () => Promise.resolve();
  }

  const readers = [];
  if (options.metricsPort !== undefined) {
    readers.push(
      new PrometheusExporter({
        host: "0.0.0.0",
        port: options.metricsPort,
        endpoint: "/metrics",
        appendTimestamp: false,
        withResourceConstantLabels:
          /^(service\.name|service\.version|deployment\.environment\.name)$/,
      }),
    );
  }
  if (options.otlpMetricsEndpoint) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: options.otlpMetricsEndpoint }),
        exportIntervalMillis: options.exportIntervalMs ?? 15_000,
        exportTimeoutMillis: 10_000,
      }),
    );
  }

  provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "unknown",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment ?? "unknown",
    }),
    readers,
    views: [
      {
        instrumentName: HTTP_DURATION,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [
              0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
            ],
          },
        },
      },
      {
        instrumentName: AGENT_RUN_DURATION,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [1, 5, 15, 30, 60, 120, 300, 600, 900, 1_800],
          },
        },
      },
      {
        instrumentName: AGENT_TURN_DURATION,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
          },
        },
      },
    ],
  });
  initializedService = options.serviceName;
  metrics.setGlobalMeterProvider(provider);
  initializeInstruments();
  registerProcessMetrics(options.serviceName);

  return async () => {
    const current = provider;
    provider = undefined;
    initializedService = undefined;
    if (current) await current.shutdown();
    metrics.disable();
  };
}

let httpRequests!: Counter;
let httpDuration!: Histogram;
let httpActive!: UpDownCounter;
let agentRuns!: Counter;
let agentRunDuration!: Histogram;
let activeAgentRuns!: UpDownCounter;
let agentMessages!: Counter;
let agentTokens!: Counter;
let agentCost!: Counter;
let agentToolCalls!: Counter;
let agentLimits!: Counter;
let agentTurnDuration!: Histogram;
let agentLastProgress!: Gauge;

function initializeInstruments(): void {
  const meter = metrics.getMeter(METER_NAME);
  httpRequests = meter.createCounter(`${METRIC_PREFIX}.http.server.requests`, {
    description: "HTTP requests completed by Colony services",
    unit: "{request}",
  });
  httpDuration = meter.createHistogram(HTTP_DURATION, {
    description: "HTTP request duration",
    unit: "s",
  });
  httpActive = meter.createUpDownCounter(
    `${METRIC_PREFIX}.http.server.active_requests`,
    { description: "HTTP requests currently executing", unit: "{request}" },
  );
  agentRuns = meter.createCounter(`${METRIC_PREFIX}.agent.runs`, {
    description: "Agent runs completed",
    unit: "{run}",
  });
  agentRunDuration = meter.createHistogram(AGENT_RUN_DURATION, {
    description:
      "End-to-end agent run duration, including tools and validation",
    unit: "s",
  });
  activeAgentRuns = meter.createUpDownCounter(
    `${METRIC_PREFIX}.agent.active_runs`,
    { description: "Agent runs currently active", unit: "{run}" },
  );
  agentMessages = meter.createCounter(`${METRIC_PREFIX}.agent.messages`, {
    description: "Assistant messages completed by agent model",
    unit: "{message}",
  });
  agentTokens = meter.createCounter(`${METRIC_PREFIX}.agent.tokens`, {
    description: "Model token usage reported by the provider",
    unit: "{token}",
  });
  agentCost = meter.createCounter(`${METRIC_PREFIX}.agent.cost`, {
    description: "Model cost reported by the provider",
    unit: "USD",
  });
  agentToolCalls = meter.createCounter(`${METRIC_PREFIX}.agent.tool.calls`, {
    description: "Agent tool calls completed",
    unit: "{call}",
  });
  agentLimits = meter.createCounter(`${METRIC_PREFIX}.agent.limit_exceeded`, {
    description: "Agent runs stopped by a turn, cost, or time limit",
    unit: "{run}",
  });
  agentTurnDuration = meter.createHistogram(AGENT_TURN_DURATION, {
    description:
      "Elapsed time between completed assistant messages, including tool work",
    unit: "s",
  });
  agentLastProgress = meter.createGauge(
    `${METRIC_PREFIX}.agent.last_progress_timestamp`,
    {
      description:
        "Unix timestamp of the latest agent message or tool completion",
      unit: "s",
    },
  );
}

export function beginHttpRequest(attributes: {
  readonly service: string;
  readonly method: string;
  readonly route: string;
}): (statusCode: number) => void {
  if (!provider) return () => undefined;
  const started = performance.now();
  const base = {
    service: attributes.service,
    "http.request.method": attributes.method,
    "http.route": normalizeRoute(attributes.route),
  };
  httpActive.add(1, base);
  return (statusCode) => {
    const complete = {
      ...base,
      "http.response.status_code": String(statusCode),
    };
    httpActive.add(-1, base);
    httpRequests.add(1, complete);
    httpDuration.record((performance.now() - started) / 1_000, complete);
  };
}

export function instrumentFetch(
  service: string,
  fetchHandler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const finish = beginHttpRequest({
      service,
      method: request.method,
      route: url.pathname,
    });
    try {
      const response = await fetchHandler(request);
      finish(response.status);
      return response;
    } catch (error) {
      finish(500);
      throw error;
    }
  };
}

export function beginAgentRun(
  attributes: AgentMetricAttributes,
): (status: string, reason?: string) => void {
  if (!provider) return () => undefined;
  const started = performance.now();
  const labels = agentLabels(attributes);
  activeAgentRuns.add(1, labels);
  recordAgentProgress(attributes);
  return (status, reason) => {
    activeAgentRuns.add(-1, labels);
    const complete = {
      ...labels,
      status: boundedLabel(status),
      reason: classifyReason(reason),
    };
    agentRuns.add(1, complete);
    agentRunDuration.record((performance.now() - started) / 1_000, complete);
    recordAgentProgress(attributes);
  };
}

export function recordAgentMessage(
  attributes: AgentMetricAttributes,
  usage: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly costUsd?: number;
    readonly turnDurationSeconds?: number;
  },
): void {
  if (!provider) return;
  const labels = agentLabels(attributes);
  agentMessages.add(1, labels);
  for (const [type, value] of [
    ["input", usage.input],
    ["output", usage.output],
    ["cache_read", usage.cacheRead],
    ["cache_write", usage.cacheWrite],
  ] as const) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      agentTokens.add(value, { ...labels, type });
    }
  }
  if (
    typeof usage.costUsd === "number" &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0
  ) {
    agentCost.add(usage.costUsd, labels);
  }
  if (
    typeof usage.turnDurationSeconds === "number" &&
    Number.isFinite(usage.turnDurationSeconds) &&
    usage.turnDurationSeconds >= 0
  ) {
    agentTurnDuration.record(usage.turnDurationSeconds, labels);
  }
  recordAgentProgress(attributes);
}

export function recordAgentToolCall(
  attributes: AgentMetricAttributes,
  tool: string,
  isError: boolean,
): void {
  if (!provider) return;
  agentToolCalls.add(1, {
    ...agentLabels(attributes),
    tool: boundedLabel(tool, 80),
    outcome: isError ? "error" : "success",
  });
  recordAgentProgress(attributes);
}

export function recordAgentLimit(
  attributes: AgentMetricAttributes,
  reason: string,
): void {
  if (!provider) return;
  agentLimits.add(1, {
    ...agentLabels(attributes),
    reason: classifyReason(reason),
  });
}

export function recordAgentProgress(attributes: AgentMetricAttributes): void {
  if (!provider) return;
  agentLastProgress.record(Date.now() / 1_000, agentLabels(attributes));
}

function agentLabels(attributes: AgentMetricAttributes): Attributes {
  return {
    role: boundedLabel(attributes.role),
    provider: boundedLabel(attributes.provider),
    model: boundedLabel(attributes.model),
  };
}

function normalizeRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
      if (/^col-[a-z0-9.-]+$/i.test(segment)) return ":scope_id";
      return segment.length > 80 ? ":value" : segment;
    })
    .join("/");
}

function classifyReason(reason: string | undefined): string {
  if (!reason) return "none";
  for (const known of [
    "max_turns",
    "max_usd",
    "timeout",
    "canceled",
    "envelope_rejected",
    "finalize_no_submission",
  ]) {
    if (reason.toLowerCase().includes(known)) return known;
  }
  return "other";
}

function boundedLabel(value: string, maximum = 120): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, "_");
  return normalized.slice(0, maximum) || "unknown";
}

function registerProcessMetrics(service: string): void {
  const meter = metrics.getMeter(METER_NAME);
  const labels = { service };
  const rss = meter.createObservableGauge(
    `${METRIC_PREFIX}.process.memory.rss`,
    {
      description: "Resident memory used by the Node.js process",
      unit: "By",
    },
  );
  rss.addCallback((result: ObservableResult) => {
    result.observe(process.memoryUsage().rss, labels);
  });
  const heap = meter.createObservableGauge(
    `${METRIC_PREFIX}.process.memory.heap_used`,
    {
      description: "Heap memory used by the Node.js process",
      unit: "By",
    },
  );
  heap.addCallback((result: ObservableResult) => {
    result.observe(process.memoryUsage().heapUsed, labels);
  });
  const uptime = meter.createObservableGauge(
    `${METRIC_PREFIX}.process.uptime`,
    {
      description: "Node.js process uptime",
      unit: "s",
    },
  );
  uptime.addCallback((result: ObservableResult) => {
    result.observe(process.uptime(), labels);
  });
  const eventLoop = meter.createObservableGauge(
    `${METRIC_PREFIX}.process.event_loop.utilization`,
    { description: "Node.js event loop utilization ratio", unit: "1" },
  );
  let previous = performance.eventLoopUtilization();
  eventLoop.addCallback((result: ObservableResult) => {
    const current = performance.eventLoopUtilization(previous);
    previous = current;
    result.observe(current.utilization, labels);
  });
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
