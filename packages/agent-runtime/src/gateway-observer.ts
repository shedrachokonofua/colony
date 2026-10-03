import type { Fault } from "@colony/core";
import type { Agent, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";

/**
 * Gateway exchange observation and quota-tier refusal classification.
 *
 * A routed request (e.g. a `moira/<tier>` alias) is rewritten by the
 * gateway's pre-call hook to one concrete deployment, but the response
 * `model` field and stream chunks echo the requested alias — only the
 * response headers name what actually served the call. A tier whose every
 * member lacks quota is refused with HTTP 429 and a structured
 * `tier_exhausted` error body; that refusal is provider quota, never a
 * model failure. Both facts live in the raw HTTP exchange, which pi-ai
 * flattens before Colony's runner sees it, so the one seam that still
 * carries them is the transport fetch behind the agent's stream function.
 * Everything here is structural: no classification ever reads message text.
 */

/** The concrete deployment headers a LiteLLM-family gateway surfaces. */
export interface ServedModelObservation {
  /** `x-litellm-model-group`: the model that served the call (e.g. `ollama-cloud/glm-5.3-flash`). */
  readonly model: string;
  /** `x-litellm-model-id`: the deployment's stable id. */
  readonly modelId?: string;
  /** `x-litellm-model-name`: the upstream wire name (e.g. `ollama_chat/glm-5.3-flash`). */
  readonly modelName?: string;
  /** `x-litellm-model-api-base`: the upstream endpoint. */
  readonly apiBase?: string;
  /** `x-litellm-call-id`: the gateway's per-request id. */
  readonly callId?: string;
}

/** One gateway HTTP exchange as the transport observer saw it. */
export interface GatewayExchange {
  readonly atMs: number;
  /** HTTP status; absent when the transport itself failed before a response. */
  readonly status?: number;
  readonly servedModel?: ServedModelObservation;
  /** Parsed JSON body of a non-2xx response, when it parsed. */
  readonly errorBody?: unknown;
  /** `Retry-After` in seconds (header or date form), when present. */
  readonly retryAfterSeconds?: number;
}

/**
 * A quota-tier refusal as Moira reports it. The classification reads only
 * the structured `error.type` field — the human `error.message` is never
 * inspected. Two shapes reach a client: the hook's own
 * `{"error":{"type":"tier_exhausted",...}}` and LiteLLM's envelope wrapping
 * that same object under `error.provider_specific_fields` (where the
 * top-level `error.type` is then `"None"`).
 */
export interface TierExhaustedRefusal {
  readonly tier?: string;
  readonly effort?: string;
  /** Quota window reset the gateway named (`earliest_reset`), when it knows one. */
  readonly earliestReset?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Parse a `tier_exhausted` refusal out of a structured gateway error body,
 * or undefined for anything else. Structural end to end: a body whose
 * message text merely *mentions* quota or `tier_exhausted` is not a refusal.
 */
export function parseTierExhaustedRefusal(
  body: unknown,
): TierExhaustedRefusal | undefined {
  if (!isObject(body)) return undefined;
  const error = isObject(body.error) ? body.error : body;
  const wrapped = isObject(error.provider_specific_fields)
    ? error.provider_specific_fields
    : undefined;
  for (const source of [wrapped, error]) {
    if (source?.type !== "tier_exhausted") continue;
    return {
      ...(optionalString(source.tier) !== undefined
        ? { tier: source.tier as string }
        : {}),
      ...(optionalString(source.effort) !== undefined
        ? { effort: source.effort as string }
        : {}),
      ...(optionalString(source.earliest_reset) !== undefined
        ? { earliestReset: source.earliest_reset as string }
        : {}),
    };
  }
  return undefined;
}

/**
 * The provider fault a gateway exchange carries: a `tier_exhausted` refusal
 * is provider quota (`quota_exhausted`), free-retried and never charged to
 * the model, with `retryNotBefore` pinned to the later of the response's
 * `Retry-After` and the refusal's `earliest_reset`. Undefined when the last
 * exchange was not such a refusal, so callers fall through to their existing
 * text classifiers unchanged.
 */
export function classifyGatewayExchange(
  exchange: GatewayExchange | undefined,
): Fault | undefined {
  const refusal = exchange
    ? parseTierExhaustedRefusal(exchange.errorBody)
    : undefined;
  if (!refusal || !exchange) return undefined;
  const resetsAtMs = refusal.earliestReset
    ? Date.parse(refusal.earliestReset)
    : Number.NaN;
  const retryAfterMs = exchange.retryAfterSeconds
    ? exchange.atMs + exchange.retryAfterSeconds * 1000
    : Number.NaN;
  const notBeforeMs = Math.max(
    Number.isFinite(resetsAtMs) ? resetsAtMs : 0,
    Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
  );
  return {
    layer: "provider",
    code: "quota_exhausted",
    detail: `tier_exhausted: ${refusal.tier ?? "unknown tier"}${
      refusal.effort ? ` effort=${refusal.effort}` : ""
    }`,
    ...(notBeforeMs > exchange.atMs
      ? { retryNotBefore: new Date(notBeforeMs).toISOString() }
      : {}),
  };
}

type FetchLike = NonNullable<SimpleStreamOptions["fetch"]>;

/**
 * A fetch that reports each exchange to `note` and returns the original
 * response untouched. Observation is strictly best-effort: a failure to
 * inspect a response must never fail the request it belongs to. Only
 * non-2xx bodies are read (via a clone), so streamed successes pass
 * through with headers inspected alone.
 */
function observedFetch(
  base: FetchLike,
  note: (exchange: GatewayExchange) => void,
): FetchLike {
  return async (input, init) => {
    const atMs = Date.now();
    let response: Response;
    try {
      response = await base(input, init);
    } catch (err) {
      note({ atMs, errorBody: undefined });
      throw err;
    }
    try {
      const servedHeader = (name: string): string | undefined => {
        const value = response.headers.get(name);
        return value && value.length > 0 ? value : undefined;
      };
      const modelGroup = servedHeader("x-litellm-model-group");
      const modelName = servedHeader("x-litellm-model-name");
      const modelId = servedHeader("x-litellm-model-id");
      const apiBase = servedHeader("x-litellm-model-api-base");
      const callId = servedHeader("x-litellm-call-id");
      const servedModel: ServedModelObservation | undefined =
        (modelGroup ?? modelName)
          ? {
              model: (modelGroup ?? modelName)!,
              ...(modelId !== undefined ? { modelId } : {}),
              ...(modelName !== undefined ? { modelName } : {}),
              ...(apiBase !== undefined ? { apiBase } : {}),
              ...(callId !== undefined ? { callId } : {}),
            }
          : undefined;
      const retryAfterRaw = servedHeader("retry-after");
      const retryAfterSeconds =
        retryAfterRaw === undefined
          ? undefined
          : Number.isFinite(Number(retryAfterRaw))
            ? Number(retryAfterRaw)
            : Number.isFinite(Date.parse(retryAfterRaw))
              ? (Date.parse(retryAfterRaw) - atMs) / 1000
              : undefined;
      if (response.status < 400) {
        note({ atMs, status: response.status, servedModel, retryAfterSeconds });
        return response;
      }
      const clone = response.clone();
      const text = await clone.text();
      let errorBody: unknown;
      try {
        errorBody = JSON.parse(text) as unknown;
      } catch {
        errorBody = undefined;
      }
      note({
        atMs,
        status: response.status,
        servedModel,
        retryAfterSeconds,
        errorBody,
      });
    } catch {
      note({ atMs, status: response.status });
    }
    return response;
  };
}

/**
 * Wrap `agent.streamFn` so every provider request it dispatches runs
 * through {@link observedFetch}, reporting each gateway exchange to `note`.
 * Installed per session by pi-session's arm seams (run, stage, and subagent
 * sessions share the run's observer state).
 */
export function armGatewayObserver(
  agent: Pick<Agent, "streamFn">,
  note: (exchange: GatewayExchange) => void,
): void {
  const inner = agent.streamFn;
  agent.streamFn = ((model, context, options) =>
    inner(
      model,
      context,
      options === undefined
        ? { fetch: observedFetch(globalThis.fetch as FetchLike, note) }
        : {
            ...options,
            fetch: observedFetch(
              options.fetch ?? (globalThis.fetch as FetchLike),
              note,
            ),
          },
    )) as StreamFn;
}
