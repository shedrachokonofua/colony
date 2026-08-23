import {
  context,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type SpanKind,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SamplingDecision,
  SimpleSpanProcessor,
  type Sampler,
  type SamplingResult,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "@colony/observability";
const RUN_SPAN = "colony.run";
const TICK_SPAN = "colony.tick";
const WEBHOOK_SPAN = "colony.webhook";
const HTTP_SERVER_SPAN = "colony.http.server";

// Root spans emitted outside any HTTP request: the ratio must never drop them.
const ALWAYS_SAMPLED_SPANS: Record<string, true> = {
  [RUN_SPAN]: true,
  [TICK_SPAN]: true,
  [WEBHOOK_SPAN]: true,
};

const DEFAULT_TRACE_HTTP_RATIO = 0.1;

export interface TraceConfig {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  readonly otlpTracesEndpoint?: string;
  readonly traceHttpSampleRatio?: number;
  readonly spanExporter?: SpanExporter;
}

export interface ColonyRunSpan {
  readonly traceId: string;
  readonly spanContext: Context;
  end(status: string, reason?: string): void;
}

let tracerProvider: NodeTracerProvider | undefined;
let initializedTraceService: string | undefined;

export function isTracingEnabled(): boolean {
  return tracerProvider !== undefined;
}

function startSpan(name: string, attributes?: Attributes): Span | undefined {
  if (!tracerProvider) return undefined;
  return trace.getTracer(TRACER_NAME).startSpan(name, { attributes });
}

export function startColonyRunSpan(attrs: {
  readonly scope_id: string;
  readonly task_id: string | null;
  readonly run_id: string;
  readonly kind: string;
  readonly model_id: string | null;
}): ColonyRunSpan | undefined {
  const span = startSpan(RUN_SPAN, {
    "colony.scope_id": attrs.scope_id,
    "colony.task_id": attrs.task_id ?? "",
    "colony.run_id": attrs.run_id,
    "colony.run.kind": attrs.kind,
    "colony.model.id": attrs.model_id ?? "",
  });
  if (!span) return undefined;
  return {
    traceId: span.spanContext().traceId,
    spanContext: trace.setSpan(context.active(), span),
    end(status: string, reason?: string) {
      span.setAttribute("colony.run.status", status);
      if (reason !== undefined) {
        span.setAttribute("colony.run.failure_reason", reason);
      }
      span.end();
    },
  };
}

export function withSpanContext<T>(
  spanContext: Context,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  // Without an SDK registered, running under a detached span context would
  // still nest no-op API spans; stay on the active context instead.
  return context.with(tracerProvider ? spanContext : context.active(), fn);
}

export function startHttpServerSpan(
  method: string,
  route: string,
): ((statusCode: number) => void) | undefined {
  const span = startSpan(HTTP_SERVER_SPAN, {
    "http.request.method": method,
    "http.route": route,
  });
  if (!span) return undefined;
  return (statusCode) => {
    span.setAttribute("http.response.status_code", statusCode);
    span.end();
  };
}

export function startWebhookSpan(eventType: string): () => void {
  const span = startSpan(WEBHOOK_SPAN, {
    ...(eventType ? { "colony.webhook.event_type": eventType } : {}),
  });
  if (!span) return () => undefined;
  return () => {
    span.end();
  };
}

export function startTickSpan(): { end(): void } {
  const span = startSpan(TICK_SPAN);
  if (!span) return { end: () => undefined };
  return {
    end() {
      span.end();
    },
  };
}

/**
 * TEST ONLY. Registers a global tracer provider backed by an in-memory
 * exporter so tests can assert on emitted spans; the returned shutdown
 * unregisters the provider and clears captured spans.
 */
export function registerInMemorySpanExporter(): {
  exporter: InMemorySpanExporter;
  shutdown: () => Promise<void>;
} {
  if (tracerProvider) {
    throw new Error(
      `tracing already initialized for ${initializedTraceService}; cannot register the in-memory test exporter`,
    );
  }
  const exporter = new InMemorySpanExporter();
  tracerProvider = buildTracerProvider(
    { serviceName: "colony-test", spanExporter: exporter },
    resolveRatio(),
  );
  initializedTraceService = "colony-test";
  trace.setGlobalTracerProvider(tracerProvider);
  return { exporter, shutdown: resetTracing };
}

export function configureTracing(
  options: TraceConfig,
): (() => Promise<void>) | undefined {
  if (tracerProvider) {
    if (initializedTraceService !== options.serviceName) {
      throw new Error(
        `tracing already initialized for ${initializedTraceService}; cannot initialize ${options.serviceName}`,
      );
    }
    return undefined;
  }
  if (!options.spanExporter && !options.otlpTracesEndpoint) return undefined;

  const provider = buildTracerProvider(
    options,
    // Fixed at construction so one ratio governs the whole provider lifetime.
    resolveRatio(options.traceHttpSampleRatio),
  );
  tracerProvider = provider;
  initializedTraceService = options.serviceName;
  trace.setGlobalTracerProvider(provider);
  return resetTracing;
}

function buildTracerProvider(
  options: TraceConfig,
  ratio: number,
): NodeTracerProvider {
  const exporter =
    options.spanExporter ??
    (options.otlpTracesEndpoint
      ? new OTLPTraceExporter({ url: options.otlpTracesEndpoint })
      : undefined);
  if (!exporter) throw new Error("no span exporter configured for tracing");
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "unknown",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment ?? "unknown",
    }),
    sampler: new ColonySampler(ratio),
    spanProcessors: [
      options.spanExporter
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter),
    ],
  });
  // Registers the global context manager + propagator alongside the tracer,
  // so spans created inside context.with(...) nest under their parent.
  provider.register();
  return provider;
}

async function resetTracing(): Promise<void> {
  const current = tracerProvider;
  tracerProvider = undefined;
  initializedTraceService = undefined;
  trace.disable();
  if (current) await current.shutdown();
}

export { resetTracing as shutdownTracing };

function resolveRatio(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env["COLONY_TRACE_HTTP_RATIO"];
  if (raw === undefined || raw === "") return DEFAULT_TRACE_HTTP_RATIO;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_TRACE_HTTP_RATIO;
}

class ColonySampler implements Sampler {
  constructor(private readonly ratio: number) {}

  shouldSample(
    parentContext: Context,
    traceId: string,
    spanName: string,
    _spanKind: SpanKind,
    attributes: Attributes,
    _links: Link[],
  ): SamplingResult {
    const decision =
      ALWAYS_SAMPLED_SPANS[spanName] === true ||
      isSampledParent(parentContext) ||
      isAlwaysSampledHttpMethod(attributes) ||
      isWithinRatio(this.ratio, traceId)
        ? SamplingDecision.RECORD_AND_SAMPLED
        : SamplingDecision.NOT_RECORD;
    return { decision };
  }

  toString(): string {
    return `ColonySampler(ratio=${this.ratio})`;
  }
}

function isSampledParent(parentContext: Context): boolean {
  const parent = trace.getSpanContext(parentContext);
  return parent !== undefined && (parent.traceFlags & 1) === 1;
}

function isAlwaysSampledHttpMethod(attributes: Attributes): boolean {
  return (
    attributes["http.request.method"] === "POST" ||
    attributes["http.request.method"] === "PATCH"
  );
}

/** Deterministic: the same trace id always lands on the same side of the cut. */
function isWithinRatio(ratio: number, traceId: string): boolean {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  const fraction = Number.parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000;
  return fraction < ratio;
}
