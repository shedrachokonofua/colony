# Pi Agent Runtime — Integration Research

**Audience:** whoever picks up COL-2.15 / 2.16 / 2.17 / 2.18.
**Goal:** plan the real `PiAgentRuntimeAdapter` (developer + reviewer) without further reading.
**Constraint (per `docs/research/pi-integration.addendum.md`):** Colony imports the Pi SDK **in-process**. We do not spawn `pi` as a subprocess. The fake adapter stays in-process; the real one stays in-process and calls SDK functions. Sandbox isolation is a Node process / Kubernetes pod boundary that _contains_ the SDK call, not a CLI exec.

> What "Pi" actually is: a TypeScript monorepo at https://github.com/badlogic/pi-mono publishing several `@mariozechner/*` npm packages. There is **no package literally named `pi-mono`**; the repo's design.md shorthand "pi-mono SDK" maps to `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`. The "pi-coding-agent" shorthand maps to `@mariozechner/pi-coding-agent`, which depends on the other two and adds tools, sessions, modes, and an SDK.

---

## 1. Packaging & install

### Packages in scope (latest tag at time of research, npm `dist-tags.latest`)

| Package                         | Latest   | Role for Colony                                                                                                                                                                                                                                 | Source                                                                                                        |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@mariozechner/pi-ai`           | `0.70.2` | Unified LLM client (Anthropic / OpenAI / Google / Bedrock / Mistral / Vertex / Azure / OpenRouter / Groq / DeepSeek / etc.). Token & cost tracking. The bottom of the stack.                                                                    | https://www.npmjs.com/package/@mariozechner/pi-ai , https://github.com/badlogic/pi-mono/tree/main/packages/ai |
| `@mariozechner/pi-agent-core`   | `0.70.2` | Stateful `Agent` class with tool calling, streaming events, steering / follow-up, abort. Built on `pi-ai`. This is what design.md calls "pi-mono SDK."                                                                                          | https://github.com/badlogic/pi-mono/tree/main/packages/agent (note: directory is `agent`, not `agent-core`)   |
| `@mariozechner/pi-coding-agent` | `0.70.2` | Built on `pi-agent-core`. Adds Pi's built-in coding tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`), session JSONL persistence, compaction, extensions/skills, plus a CLI `pi` and modes (`interactive`, `print`, `json`, `rpc`). | https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent                                           |
| `@mariozechner/pi-tui`          | `0.70.2` | Terminal UI (only matters if we run interactive mode — we won't). Pulled in transitively.                                                                                                                                                       | https://github.com/badlogic/pi-mono/tree/main/packages/tui                                                    |

(Also published from the same monorepo but **not relevant** to Colony: `pi-mom`, `pi-pods`, `pi-web-ui`.)

### Install command

```bash
npm install --save-exact \
  @mariozechner/pi-coding-agent@0.70.2 \
  @mariozechner/pi-agent-core@0.70.2 \
  @mariozechner/pi-ai@0.70.2
```

Pinning all three is intentional — see §12 (release cadence is multiple per day).

### Distribution shape

- **JS-only.** All three packages are pure ESM TypeScript compiled to JS, distributed as `.js` + `.d.ts` (`"type": "module"`, `exports` map). Source: `package.json` files (`/tmp/pim-coding-pkg.json`, `/tmp/pim-ai-pkg.json`, `/tmp/pim-agent-pkg.json`). No native bindings.
- Optional native deps in `pi-coding-agent`:
  - `optionalDependencies: { "@mariozechner/clipboard": "^0.3.3" }` — clipboard, can fail to install on headless and pi still runs.
  - `@silvia-odwyer/photon-node` (image processing, WASM) is a hard dependency. WASM, not native — works in Node.
- `pi-coding-agent` declares a CLI bin (`"bin": { "pi": "dist/cli.js" }`) — useful for the dev shell, **not** what Colony uses at runtime.
- Engines: `node >=20.6.0` for `pi-coding-agent`, `>=20.0.0` for the others. Colony's flake currently provides `nodejs_24` — fine.

### Is there a CLI distinct from the SDK?

Yes. The `pi` binary in `@mariozechner/pi-coding-agent` runs four modes: `interactive`, `--print` / `-p`, `--mode json` (event JSONL), `--mode rpc` (LF-delimited JSON RPC over stdin/stdout). **All four are layered on top of the same in-process SDK** (`createAgentSession`, `createAgentSessionRuntime`, `Agent`). Per the addendum, Colony skips the CLI entirely and imports those SDK functions directly. The CLI is still useful as a developer ergonomic + "live test against my account" tool.

### Nix

There is **no Nix derivation** for these packages either in nixpkgs (none in `nixos-25.11` channel) or upstream. The Pi monorepo only documents `PI_PACKAGE_DIR` as a hint for "Nix/Guix where store paths tokenize poorly" (source: `packages/coding-agent/README.md` env table) — i.e. they're aware Nix users exist but don't ship a derivation. Colony continues installing via npm in the existing TypeScript monorepo (`packages/agent-runtime/package.json`); Nix only provides the Node toolchain (`flake.nix` already does). No `flake.nix` change required.

---

## 2. SDK shape — the "pi-mono" surface (`@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`)

### `pi-ai` — model + LLM call layer

Public exports (from `packages/ai/README.md` and `package.json` `exports`):

```ts
import {
  // Model registry / discovery
  getModel,
  listModels,
  // High-level call API
  complete,
  stream,
  // Re-exports of TypeBox helpers used for tool params
  Type,
  Static,
  TSchema,
  // Types
  // Model, Context, Message (User|Assistant|ToolResult), Tool, Usage, Cost
} from "@mariozechner/pi-ai";
```

Per-provider sub-exports also exist (`@mariozechner/pi-ai/anthropic`, `/openai-responses`, `/google`, `/google-vertex`, `/bedrock-provider`, `/oauth`, etc.) for direct provider access. These are normally not needed — `getModel(provider, id)` returns a `Model<any>` with everything the agent needs.

`stream` and `complete`:

- Take `(model, context, options)`. Both accept `signal: AbortSignal` for cancellation; aborted requests have `stopReason === "aborted"` and `usage` returns partial token counts.
- Emit streaming events: `start`, `text_start|delta|end`, `thinking_start|delta|end`, `toolcall_start|delta|end`, `done`, `error`.
- Built-in **prompt caching** (Anthropic `cache_control` headers, OpenAI 24h) keyed on `sessionId` + `cacheRetention: "short"|"long"`. Cost reporting is **per message**: `assistantMessage.usage.cost = { input, output, cacheRead, cacheWrite, total }`.
- The `Context` object (`{ systemPrompt, messages, tools }`) is plain JSON — `JSON.stringify` + `JSON.parse` round-trip. This is how design.md's "long-lived Architect session" can be persisted to Postgres.

### `pi-agent-core` — the loop ("pi-mono SDK")

The class design.md actually means by "pi-mono session":

```ts
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt,
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    thinkingLevel: "medium",
    tools: [...],          // AgentTool[] — TypeBox-typed
    messages: [],
  },
  convertToLlm: (msgs) => msgs.filter(/* keep user|assistant|toolResult */),
  beforeToolCall: async ({ toolCall, args, context }) => {
    // Hook used by Colony to enforce per-tool capability checks via Tool Gateway
  },
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    // Hook used by Colony to record tool-call audit rows
  },
  toolExecution: "parallel",      // or "sequential"
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  sessionId: scopeId,             // turns on prompt caching by ID
  getApiKey: async (provider) => fetchKey(provider), // <-- LLM credential broker hook
});

await agent.prompt("Decompose this scope...");
```

Important `Agent` capabilities (from `packages/agent/README.md`):

- `agent.subscribe((event, signal) => ...)` — observer; awaited in registration order; `agent_end` is the run barrier. Returns unsubscribe.
- `agent.abort()` — cancellation that propagates to the underlying `pi-ai` `AbortSignal`.
- `agent.waitForIdle()` — settle promise for the entire run including async listeners.
- `agent.steer(msg)` / `agent.followUp(msg)` — message queue.
- `agent.state.messages` — full conversation; `agent.state.streamingMessage` — partial during streaming.
- `agent.continue()` — restart the loop from current state; useful after a tool error.
- Tool result hooks can return `{ terminate: true }` to stop the loop without an extra LLM round-trip.

### "Print/JSON mode"

This is a CLI thing (`pi -p "..."`, `pi --mode json "..."`) — see `packages/coding-agent/docs/json.md`. The JSON mode emits one JSON object per line of `AgentSessionEvent` (full schema below in §3). Because Colony imports the SDK directly, **we never call print or JSON mode**. Instead we subscribe to the same events in-process via `agent.subscribe(...)` or `session.subscribe(...)`. The JSON-mode schema is still useful as documentation of what events look like.

JSON output schema (verbatim from `docs/json.md`):

```jsonc
// First line: session header
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
// Then events from AgentSessionEvent | AgentEvent:
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"...","contentIndex":0,"partial":{...}}}
{"type":"message_end","message":{...}}
{"type":"tool_execution_start","toolCallId":"...","toolName":"bash","args":{...}}
{"type":"tool_execution_update","toolCallId":"...","toolName":"...","args":{...},"partialResult":{...}}
{"type":"tool_execution_end","toolCallId":"...","toolName":"...","result":{...},"isError":false}
{"type":"turn_end","message":{...},"toolResults":[...]}
{"type":"queue_update","steering":[...],"followUp":[...]}
{"type":"compaction_start","reason":"manual|threshold|overflow"}
{"type":"compaction_end","reason":"...","result":{...}|null,"aborted":false,"willRetry":false,"errorMessage":"..."}
{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"..."}
{"type":"auto_retry_end","success":true,"attempt":2,"finalError":"..."}
{"type":"agent_end","messages":[...]}
```

Final assistant text lives in `agent_end.messages[last].content` where blocks have `type: "text" | "thinking" | "toolCall"`.

---

## 3. Coding-agent surface (`@mariozechner/pi-coding-agent`)

### Public SDK entry points

```ts
import {
  // Top-level convenience
  createAgentSession, // single AgentSession
  createAgentSessionRuntime, // multi-session runtime (new/switch/fork/import)
  // Composable building blocks
  createAgentSessionServices,
  createAgentSessionFromServices,
  // Required collaborators
  AuthStorage, // OAuth + API key storage
  ModelRegistry, // resolves provider/model strings to Models
  SessionManager, // .create(cwd) | .inMemory() | persisted JSONL
  // Helpers
  getAgentDir,
  // Types
  // AgentSession, AgentSessionRuntime, AgentSessionEvent, PromptOptions
} from "@mariozechner/pi-coding-agent";
```

The `AgentSession` interface (verbatim from `packages/coding-agent/docs/sdk.md`):

```ts
interface AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  sessionFile: string | undefined;
  sessionId: string;
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;
  agent: Agent;                 // <-- raw pi-agent-core Agent for hooks
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;
  navigateTree(targetId: string, options?: { ... }): Promise<{ editorText?: string; cancelled: boolean }>;
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;
  abort(): Promise<void>;
  dispose(): void;
}
```

### Headless / non-interactive use

`createAgentSession({ sessionManager: SessionManager.inMemory(), authStorage, modelRegistry })` is the canonical headless setup. With `SessionManager.inMemory()` no JSONL files are written, so we have no `~/.pi/agent/sessions/...` filesystem dependency in pods. Builtin tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) come bundled via the default `ResourceLoader`; pass an explicit `tools: [...]` to `createAgentSession()` to allowlist what Colony exposes per role.

For Reviewer "fresh per review, no session reuse" semantics, every reviewer invocation builds a fresh `createAgentSession(...)` call — there is no "system-wide singleton."

### Output: there is no envelope by default

Pi returns a _conversation_, not a structured object. To get a Colony envelope we must either:

1. Force the model to use a single tool call whose params _are_ the envelope shape (recommended — see §8), or
2. Post-parse the final assistant text expecting a JSON code block.

`agent_end.messages[last]` is the place to look in either case.

---

## 4. Model / provider abstraction

### Providers supported out of the box (verified from `packages/coding-agent/README.md` and `packages/ai/package.json` exports)

- **Anthropic** (API key + OAuth Pro/Max subscription)
- **OpenAI** (API key + ChatGPT Plus/Pro Codex)
- **Azure OpenAI**, **OpenAI Responses**, **OpenAI Codex Responses**, **OpenAI Completions**
- **Google Gemini** (API key + Vertex + Gemini CLI OAuth + Antigravity)
- **Amazon Bedrock**
- **Mistral**, **Groq**, **Cerebras**, **xAI**, **DeepSeek**
- **OpenRouter**, **Vercel AI Gateway**, **Hugging Face**, **Fireworks**, **Kimi**, **MiniMax**, **GitHub Copilot**, **ZAI**, **OpenCode Zen/Go**

### Configuration

Three layers, all available to Colony:

1. **Per-call** (preferred for Colony): `getModel(provider, id)` returns a `Model<any>`; pass it as `initialState.model` or call `agent.state.model = ...`. API key resolution is `Agent.getApiKey?: (provider) => Promise<string>` — **dynamic** per call. This is the hook for OAuth refresh and for our broker.
2. **Env vars**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. (`pi-ai` falls back to env if `getApiKey` not set; we will set `getApiKey` so we never depend on env in pods).
3. **CLI-only** config files (`~/.pi/agent/settings.json`, `~/.pi/agent/models.json`) — irrelevant to embedded SDK use; we drive everything from `initialState` + `getApiKey`.

### Caching / streaming / cost

- **Caching** (built in): set `Agent({ sessionId })` and an env-flag-equivalent `cacheRetention` per call. `pi-ai` simulates Anthropic-style cache-control on system + last user/tool slot. Cost is reported via `usage.cost.cacheRead` / `cacheWrite`.
- **Streaming**: events flow through `agent.subscribe`. Colony likely doesn't stream user-facing text; we still subscribe to lifecycle (`agent_start`, `tool_execution_*`, `agent_end`) for telemetry.
- **Cost reporting**: per-message `usage.cost.total` (USD). Colony should sum this across the run and stamp `agent_runs.usd` from it.

---

## 5. Tools / capability surface

### Built-in tools (`pi-coding-agent`)

`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. CLI flags `-t/--tools` and `-nbt/--no-builtin-tools` allowlist them; **the SDK equivalent is `createAgentSession({ tools: [explicit list] })`**.

### Custom tools (Colony's primary path)

Define an `AgentTool` (TypeBox params) and pass it in `tools: [...]`:

```ts
import { Type } from "@mariozechner/pi-ai"; // re-exported

const submitEnvelopeTool: AgentTool = {
  name: "submit_developer_completion",
  label: "Submit Developer Envelope",
  description:
    "Final action. Submits the developer_completion envelope. Call exactly once at the end.",
  parameters: developerCompletionTypeBoxSchema, // generated from packages/schemas
  executionMode: "sequential",
  execute: async (callId, params, signal) => {
    // params is already validated; capture and signal terminate
    return {
      content: [{ type: "text", text: "envelope captured" }],
      terminate: true,
    };
  },
};
```

Two `Agent` hooks are the integration points:

- `beforeToolCall({ toolCall, args, context })` — return `{ block: true, reason }` to deny. **This is the right place to enforce Tool Gateway capability checks** (e.g. `bash` requires `sandbox.exec`, `provider.mr.open` requires the right credential binding).
- `afterToolCall(...)` — return `{ details: { ...auditFields } }` and/or `{ terminate: true }`. **Right place to record tool-call audit rows.**

### MCP

**No native MCP support.** Pi's philosophy explicitly: _"No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."_ (source: `packages/coding-agent/README.md` §Philosophy). For Colony this is fine: our Tool Gateway and skills package (`packages/agent-runtime/src/skill-registry.ts`, COL-2.3) already do the same job. Skills are SKILL.md files (Agent Skills standard) loadable from the SDK via `--skill <path>` (CLI) or by passing them through `createAgentSessionServices({ cwd })` (SDK).

### Sandboxed execution

**Pi does not sandbox tool execution itself** — `bash` is `child_process.spawn` of the host shell, full file access, full network. Colony's existing model still applies: the **k8s sandbox pod** is the boundary; the Pi SDK call runs _inside_ the pod with `cwd` set to the writable scratch dir, and `beforeToolCall` enforces our allowlist. Don't expose the full default toolset to a freshly-spawned reviewer pod with broad credentials — pass a **narrow `tools: [...]`** explicitly.

---

## 6. Cancel, timeout, telemetry

| Concern                        | Mechanism                                                                                                                                                                                                                        | Source                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Cancel                         | `session.abort()` or `agent.abort()`. Internally chains `AbortSignal` into `pi-ai` `stream`/`complete`. After abort, the assistant message has `stopReason === "aborted"`.                                                       | `pi-agent-core` README, `pi-ai` README §Aborting Requests           |
| Per-tool cancel                | The 4th argument to `AgentTool.execute(callId, params, signal, onUpdate)` is an `AbortSignal` — Colony tools should honor it for any external IO.                                                                                | `pi-agent-core` README §Tools                                       |
| Timeout                        | **No native timeout**. Colony enforces with `setTimeout(() => session.abort(), runtimeBinding.runMaxMs)`.                                                                                                                        | inferred from absence of timeout option in any of the three READMEs |
| Auto-retry on transient errors | Built in: 529/overloaded/5xx → exponential back-off, max attempts. Emits `auto_retry_start` / `auto_retry_end` events. Disable with `set_auto_retry: false` (RPC) or by ignoring (SDK has no top-level off-switch as of 0.70.2). | `packages/coding-agent/docs/rpc.md`                                 |
| OTel traces                    | **No built-in OTel.** Colony adds traces around `session.prompt(...)` in the activity wrapper, with `scope_id`/`task_id` as span attributes (matches design.md §Observability).                                                  |                                                                     |
| Structured logs                | `agent.subscribe(...)` is the structured-event source. We map to Colony's logger (Pino) keyed by `runId`.                                                                                                                        |                                                                     |
| Token / cost metrics           | Per-`AssistantMessage` `.usage.cost`. Sum on `agent_end`. Push to Prometheus as `colony_agent_run_cost_usd{role, scope, model}`.                                                                                                 | `pi-ai` README                                                      |
| Sensitive log redaction        | Pi does not redact. Colony's structured logger must redact `Authorization`, `x-api-key`, `*_TOKEN` headers in any tool/IO logging the activity does on top.                                                                      |                                                                     |

---

## 7. Session persistence

- **Native format:** JSONL on disk. `~/.pi/agent/sessions/<bucket>/<id>.jsonl` (one entry per turn, tree structure with `id` / `parentId`). See `packages/coding-agent/docs/session.md` (referenced from README; we inferred shape from `--fork`/`/tree` semantics).
- **For Colony:** `SessionManager.inMemory()` keeps everything in RAM (no filesystem dependency). For Architect's per-scope resumable session, we serialize the conversation ourselves.
  - The `Context` (`{ systemPrompt, messages, tools }`) and `agent.state.messages` are plain JSON; `JSON.stringify` round-trips. This is documented in `pi-ai` README §Persistence.
  - **Storage plan**: a Postgres table `architect_sessions(scope_id PK, agent_state JSONB, version INT, updated_at TIMESTAMPTZ)`. On Architect activity invocation: `LOAD state from row -> new Agent({ initialState: state }) -> agent.prompt(...) -> SAVE agent.state.messages back to row`. Use Postgres advisory lock per scope_id to prevent concurrent writers.
  - Tool definitions are not persisted (they live in code) — only `messages`, `systemPrompt`, and the resolved `model.id` need to be in JSONB.

- **What about S3 / object store?** Not needed for Phase 2. If sessions ever blow past row size limits we move to the existing artifacts blob store the design already calls out for "transcripts/diffs/logs outside workflow history."

---

## 8. Determinism + envelope shape

Colony envelopes are strict Zod schemas (`packages/schemas/src/...`), e.g. `developerCompletionEnvelopeSchema` and `reviewerReviewEnvelopeSchema`. Pi knows nothing about them. Three options to bridge:

### Option A — Tool-call-as-envelope **(recommended)**

Register a single terminal tool whose TypeBox params match the envelope schema and whose execution returns `terminate: true`. The model literally cannot produce an envelope it can't validate, because TypeBox validation runs before `execute()`.

Pros:

- Strong typing all the way through Pi's loop.
- Validation errors are surfaced _to the model_ as tool errors (the model retries naturally; design.md §11 calls this "automatic retry (1 attempt) with specific errors → return to author").
- Works on every provider that supports tool calling — and `pi-ai` README explicitly states "this library only includes models that support tool calling."

Cons:

- Need to maintain a TypeBox schema _or_ a Zod→TypeBox conversion. Recommend hand-written TypeBox + a `vitest` round-trip test that proves it accepts the same payloads as the Zod schema (build a fuzz seed from `developerCompletionEnvelopeSchema._def`).

### Option B — JSON-block-in-final-message

Prompt: _"end your reply with `<envelope>...</envelope>`"_. Parse on `agent_end`. Validates with our Zod schema; on fail, re-prompt or escalate.

Pros: provider-agnostic, no tool def needed.
Cons: brittle. Models forget the markers. Worse error surface.

### Option C — `pi-ai` structured outputs

`pi-ai` does _not_ expose a generic "structured output" / `response_format: { type: "json_schema" }` knob in 0.70.2 (verified by grepping the README — no `response_format`, no `json_schema` outside the tool path). So this isn't a real option today.

### Decision

Use **Option A**. Define `submitDeveloperCompletionTool` and `submitReviewerReviewTool`. Make them the **only** tool the model has _that ends the loop_ — give the developer the normal `read`/`write`/`edit`/`bash` plus the submit tool; give the reviewer `read`/`grep`/`find`/`ls` plus the submit tool. Treat any `agent_end` without a successful submit-tool call as `envelope_rejected`.

---

## 9. Sandbox / process model

Per the addendum: **embedded SDK, no `pi` exec.** Implications:

- The `PiCodingAgentRunner` is just a TypeScript class that imports `@mariozechner/pi-coding-agent` and calls `createAgentSession(...)` followed by `session.prompt(...)`. No `child_process.spawn`. No JSONL framing concerns. No RPC mode.
- Per-run isolation comes from the layer _above_ the runner: in dev/CI the Node worker process is the boundary, in pilot/prod each task gets its own k8s pod (`SandboxClaim`) that `import`s the runner — i.e., the runner module is loaded once per sandbox pod, called once, and the pod is destroyed.
- **Side effects we still need to manage in-process:**
  - `cwd`: pass to `createAgentSessionServices({ cwd })`. Set to the prepared scratch dir from `tool-materialization.ts`. Pi's built-in `read`/`write`/`bash` are `cwd`-relative.
  - `process.env` mutation: `pi-ai` reads `ANTHROPIC_API_KEY` etc. when `getApiKey` is not provided. **Always provide `getApiKey`** so we never touch `process.env`. (`getApiKey` is on `Agent`, also reachable via `createAgentSession({ ... }).agent.getApiKey = ...`.)
  - `~/.pi/agent/`: avoided by `SessionManager.inMemory()` and `--no-skills` / `--no-extensions`-equivalent SDK options (`createAgentSessionServices({ resourceLoader })` — pass a stub loader that returns no skills/extensions/themes/templates).
  - `console`: Pi may `console.warn` on retries. Capture by setting Colony's logger as a global override at worker boot, or by wrapping per-call.
  - File handles: `dispose()` after each session.
- **Tool Gateway broker integration:** lives **in `beforeToolCall`** for any tool that touches a credential. The gateway client is held by the activity, injected into the runner, and queried per call.

The Reviewer's "fresh per review" requirement is satisfied by constructing a brand-new `createAgentSession(...)` per invocation — no shared `SessionManager`, no shared `AuthStorage`, no shared `Agent`.

---

## 10. Failure modes

Empirically + from `pi-ai` / `pi-agent-core` READMEs:

| Mode                          | Surface                                                                                                                                          | Colony handling                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider rate-limit / 5xx     | `auto_retry_start`/`auto_retry_end` events; if exhausted, assistant `stopReason: "error"`, `errorMessage` populated.                             | Map to `agent_run.status = failed`, `failure_class = upstream_rate_limit`. Retry via Temporal activity policy.                                                                                       |
| `AbortSignal` cancel          | `stopReason: "aborted"`.                                                                                                                         | Mark `canceled`. Idempotent.                                                                                                                                                                         |
| Bad tool args                 | `pi-agent-core` validates TypeBox before `execute`; on fail emits `tool_execution_end` with `isError: true` and feeds the error back to the LLM. | Counts as one model retry inside the loop. Bound the loop with `maxTurns` (we own this in our `beforeToolCall` — increment a counter in run-scoped state).                                           |
| Tool throws                   | Pi catches the throw, sets `isError`, surfaces to model.                                                                                         | Same as above.                                                                                                                                                                                       |
| Compaction failure            | `compaction_end.aborted: false, errorMessage: "..."`.                                                                                            | Treat as run failure.                                                                                                                                                                                |
| Runaway cost                  | No native cap.                                                                                                                                   | Maintain a per-run cost budget; in the `message_end` listener add `usage.cost.total` and `agent.abort()` if it crosses `runtimeBinding.maxUsd`. Mirrors design.md "budget/time bounds" HITL trigger. |
| Schema drift in envelope tool | TypeBox rejects bad payload before `execute`. Surfaces to model as `tool_execution_end.isError`.                                                 | If model never converges (e.g. exits without calling submit tool, or hits max turns), runner returns no envelope → `parseEnvelope` rejects → adapter sets `envelope_rejected`.                       |
| Provider auth expired (OAuth) | `getApiKey` is async — design.md OAuth token refresh path handles this naturally.                                                                |                                                                                                                                                                                                      |
| Network egress blocked (k8s)  | `pi-ai` `fetch` fails. Bubbles up as run error.                                                                                                  | Pre-flight from `runtimeBinding.egress`. We already have `RuntimeEgressBinding`.                                                                                                                     |

---

## 11. Prior integrations

- **Pi's own README** points to `https://github.com/openclaw/openclaw` as a "real-world SDK integration."
- **`packages/coding-agent/examples/sdk/`** in the pi-mono repo — minimal-to-full-control SDK samples (referenced from `packages/coding-agent/docs/sdk.md`).
- **`packages/coding-agent/test/rpc-example.ts`** + **`packages/coding-agent/src/modes/rpc/rpc-client.ts`** — typed client for spawning a sub-process. We won't use this directly but it's the canonical reference for RPC framing.
- **Mario Zechner's blog**: `https://mariozechner.at/posts/2025-11-30-pi-coding-agent/` (rationale post, linked from README §Philosophy). Also the no-MCP post `https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/`.

There is nothing publicly visible that exactly matches our shape (Temporal activity → in-process Pi SDK → tool-call envelope). We're early adopters.

---

## 12. Versioning & stability

- **Cadence:** 261 versions between `0.6.2` (2025-11-12) and `0.70.2` (2026-04-24) — roughly 1.6 versions/day. Multiple bumps the same day are common (`0.70.0` and `0.70.1` both 2026-04-23). Source: `https://registry.npmjs.org/@mariozechner/pi-coding-agent`.
- **API stability:** the README explicitly invites the model to "build what you want or install a third party pi package," and CHANGELOG-style breaking changes are not unusual at minor bumps. We've already seen the SDK rename `pi-agent` → `pi-agent-core` and shift the directory layout in this monorepo (see `package.json` `directory` field; the dir is `packages/agent` but the npm name is `pi-agent-core`).
- **Our policy** — codify in a new ADR (proposed: **ADR-008 Pi runtime version pinning**):
  - Pin all three pi packages to **exact** versions in `packages/agent-runtime/package.json` (`"@mariozechner/pi-coding-agent": "0.70.2"`, no caret).
  - Bump in lockstep — never independently.
  - Bumps require a CI test that runs `AGENT_RUNTIME=pi` against a sealed fixture (e.g., a recorded provider). Treat each bump as a Phase 2 acceptance candidate.
  - Renovate / Dependabot disabled for these three packages; bumps land via a manual ADR-amending PR.

---

## Integration recommendations

### A. PiRunner sketches

Both runners live in `packages/agent-runtime/src/`. Wiring stays behind the `PiRunner` interface that's already in `pi-adapter.ts` (no signature change required). Both runners are **in-process** — they import the SDK, do not spawn anything.

```ts
// packages/agent-runtime/src/pi-coding-agent-runner.ts
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { PiRunner, PiRunRequest, PiRunResult } from "./pi-adapter.js";
import { developerCompletionEnvelopeTypeBox } from "@colony/schemas"; // new export
import type { CredentialBroker } from "./credential-broker.js"; // new

export interface PiCodingAgentRunnerOptions {
  readonly broker: CredentialBroker; // resolves credential bindings → values
  readonly modelFactory: (role: "developer") => Promise<ModelDescriptor>;
  readonly maxTurns?: number; // default 60
  readonly maxUsd?: number; // default 10
  readonly runTimeoutMs?: number; // default 15min
  readonly logger: Logger;
}

export class PiCodingAgentRunner implements PiRunner {
  readonly kind = "pi-coding-agent" as const;

  constructor(private readonly opts: PiCodingAgentRunnerOptions) {}

  async run(request: PiRunRequest): Promise<PiRunResult> {
    const { packet, environment } = request;
    const sandboxId = `sb-${crypto.randomUUID()}`;
    const cwd = environment.tools.scratchDir;

    const authStorage = AuthStorage.create(); // empty — we use getApiKey
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = await this.opts.modelFactory("developer");

    let captured: unknown;
    const submitTool: AgentTool = {
      name: "submit_developer_completion",
      label: "Submit completion envelope",
      description:
        "Submit the developer_completion envelope. Call once at the end.",
      parameters: developerCompletionEnvelopeTypeBox,
      executionMode: "sequential",
      execute: async (_id, params) => {
        captured = params;
        return {
          content: [{ type: "text", text: "envelope captured" }],
          terminate: true,
        };
      },
    };

    const colonyTools: AgentTool[] = [
      submitTool /* + capability-checked read/edit/bash via beforeToolCall */,
    ];

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      model,
      tools: colonyTools,
      cwd,
      // Note: createAgentSession passes through to Agent options
      systemPrompt: buildDeveloperSystemPrompt(packet),
    });

    // LLM credential broker — never reads process.env
    session.agent.getApiKey = async (provider) =>
      this.opts.broker.resolve({
        capability: `agent.llm.${provider}.invoke`,
        bindingName: environment.runtimeBinding.binding.name,
      });

    // Capability + audit hooks
    session.agent.beforeToolCall = async ({ toolCall, args, context }) =>
      this.opts.broker.checkTool({ name: toolCall.name, args, environment });
    session.agent.afterToolCall = async ({
      toolCall,
      result,
      isError,
      context,
    }) => {
      this.opts.logger.info(
        { runId: sandboxId, tool: toolCall.name, isError },
        "tool_call",
      );
    };

    // Cost + turn ceilings
    let turns = 0;
    let usdSpent = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_end") turns += 1;
      if (event.type === "message_end" && event.message.role === "assistant") {
        usdSpent += event.message.usage?.cost?.total ?? 0;
      }
      if (
        turns > (this.opts.maxTurns ?? 60) ||
        usdSpent > (this.opts.maxUsd ?? 10)
      ) {
        session.abort().catch(() => {});
      }
    });

    const timer = setTimeout(
      () => {
        session.abort().catch(() => {});
      },
      this.opts.runTimeoutMs ?? 15 * 60_000,
    );

    try {
      await session.prompt(buildDeveloperUserPrompt(packet));
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }

    if (captured === undefined) {
      // Loop ended without calling submit — let adapter mark envelope_rejected
      return { sandboxId, envelope: { __unfinished: true } };
    }
    return { sandboxId, envelope: captured };
  }

  async cancel(_runId: string): Promise<void> {
    // PiAgentRuntimeAdapter holds the `runs` map and will call this; the runner
    // tracks active sessions in a private map keyed by runId in a fuller impl.
  }
}
```

```ts
// packages/agent-runtime/src/pi-mono-runner.ts
// Same shape, but for Reviewer:
//  - imports @mariozechner/pi-agent-core directly (not pi-coding-agent),
//    because Reviewer doesn't need write/edit/bash and we want a smaller
//    surface ("pi-mono SDK" in design.md vocabulary).
//  - tools = [submit_reviewer_review, read, grep, find, ls]  (read-only)
//  - SessionManager omitted — we use Agent directly, no session file.
//  - maxTurns lower (default 20), maxUsd lower (default 3).
//  - Always constructs a brand-new Agent per invocation — no instance reuse,
//    enforces design.md "fresh per review."
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
// ...
```

The two runners live behind the existing `PiAgentRuntimeAdapter` in `packages/agent-runtime/src/pi-adapter.ts` — no change to that class needed. Pick the runner per role at construction time.

### B. Satisfying COL-2.15 acceptance

Per the addendum, the acceptance criterion is now: _"the runner imports the Pi SDK and gets a schema-valid envelope from a synthetic packet."_ Concrete test plan:

1. `packages/agent-runtime/src/pi-coding-agent-runner.test.ts`:
   - Stub `getApiKey` and supply a recorded provider (use `nock` against `api.anthropic.com`, or a fake `Model` that goes through a custom `streamFn`). The latter is cleaner — `pi-agent-core` accepts `streamFn` in `Agent` config.
   - Pass a synthetic `TaskPacket`. Drive a single tool call to `submit_developer_completion` with a hard-coded valid payload (have the fake `streamFn` emit a `toolcall_*` event sequence containing the params).
   - Assert `result.envelope` parses through `developerCompletionEnvelopeSchema`.
   - Assert no envelope leaks the model's API key (capture logger output).
2. `packages/agent-runtime/src/pi-mono-runner.test.ts` — same shape for `reviewer_review`.
3. `cancel during run leaves no orphans` test: kick off a long stream, call `runner.cancel(runId)`, assert `session.isStreaming === false` and `Agent.state.streamingMessage === undefined` within `Promise.race(timeout(500))`.

The COL-2.15 deliverable bullets that mention "launch the real binary" / "process supervision" become **stale wording** under the addendum. Recommend rewriting them to _"import the SDK; per-run cost/turn/timeout caps; abort propagation; structured logging redacting LLM/provider secrets."_

### C. AGENT_RUNTIME=fake|pi (COL-2.16)

The selection is **module-level**, not adapter-level, so we can keep heavy Pi imports out of the CI hot path:

```ts
// apps/worker/src/agent-runtime-factory.ts
import { FakeAgentRuntimeAdapter, type AgentRuntimeAdapter } from "@colony/agent-runtime";

export interface AgentRuntimeWiring {
  developer: AgentRuntimeAdapter;
  reviewer: AgentRuntimeAdapter;
}

export async function createAgentRuntime(env: Env): Promise<AgentRuntimeWiring> {
  const choice = env.AGENT_RUNTIME ?? (env.NODE_ENV === "test" ? "fake" : "pi");
  if (choice === "fake") {
    const fake = new FakeAgentRuntimeAdapter();
    return { developer: fake, reviewer: fake };
  }
  // Lazy dynamic import — keeps pi-coding-agent out of vitest bundles when fake.
  const { PiAgentRuntimeAdapter } = await import("@colony/agent-runtime");
  const { PiCodingAgentRunner } = await import("@colony/agent-runtime/pi-coding-agent-runner");
  const { PiMonoRunner }       = await import("@colony/agent-runtime/pi-mono-runner");
  const broker = await createCredentialBroker(env);
  return {
    developer: new PiAgentRuntimeAdapter(new PiCodingAgentRunner({ broker, ... })),
    reviewer:  new PiAgentRuntimeAdapter(new PiMonoRunner({ broker, ... })),
  };
}
```

Two important consequences:

- `dynamic import()` keeps Pi packages out of `AGENT_RUNTIME=fake npm test`. Vitest never resolves them, so test runs don't pull `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/*`, etc. Saves install + boot time and isolates the test surface.
- **Worker boot validation (COL-2.16 acceptance):** `createAgentRuntime` is `await`-ed at boot. Throw on missing binding / missing model / missing broker. Boot fails closed.

### D. Secrets path (COL-2.17)

Existing architecture (verified from `packages/agent-runtime/src/runtime-bindings.ts`): we already have `RuntimeCredentialBinding` with `broker: "tool-gateway" | "kubernetes-secret" | "external"`. LLM keys are just another credential binding. Concrete plan:

1. Add to `secrets/dev.yaml` (SOPS, encrypted via OpenBao Transit) entries like `LLM_ANTHROPIC_KEY`, `LLM_OPENAI_KEY`. (`secrets/dev.yaml` is already sops-encrypted with `bao.home.shdr.ch` — confirmed.) For Aether, mirror to `kv/colony/llm/anthropic`, `kv/colony/llm/openai`.
2. Add a runtime binding fragment per environment:
   ```ts
   credentialBindings: [
     ...existing,
     {
       name: "llm-anthropic",
       capability: "agent.llm.anthropic.invoke",
       broker: "tool-gateway",
       env: undefined,
       mountPath: undefined /* both undefined is invalid; pick one */,
     },
   ];
   ```
   Note the existing validation requires `mountPath || env`; for in-process SDK use we don't actually want either — the broker hands the value to `getApiKey` directly. Either:
   - Relax the validation when `broker === "tool-gateway"`, or
   - Add a synthetic `env: "PI_LLM_KEY_PLACEHOLDER"` that the SDK never reads (the broker becomes the real source).
     The first is cleaner — record this in the COL-2.17 deliverable.
3. `createCredentialBroker(env)` in `apps/worker` returns an object with `resolve({ capability, bindingName }) -> Promise<string>` that calls the Tool Gateway. The runner's `agent.getApiKey = (provider) => broker.resolve({ capability: "agent.llm." + provider + ".invoke", ... })`. Per design.md §`tool gateway`: "agents call ... LLMs ... through auditable allowlisted tools. Secrets are redacted and credentials are short-lived." That redaction must be applied to logger output where API keys may transit.
4. **Rotation:** the broker fetches per-run (not at worker boot), so a key rotation in OpenBao is picked up on the next `getApiKey()` call without restart. Document `task secrets:rotate llm` (or equivalent shell command in `Taskfile.yml`) that re-encrypts `secrets/dev.yaml` and writes the new key to `kv/colony/llm/*`.
5. **Hard rule:** worker must not read `ANTHROPIC_API_KEY` etc. from `process.env`. Always set `agent.getApiKey`. Add a CI lint that greps for `process.env.ANTHROPIC_API_KEY` in `apps/worker/` and fails. (`packages/agent-runtime/` should also enforce.)
6. `git grep` for `.env` shows current state — confirm before COL-2.17 lands that no `.env*` file in the repo carries an LLM key.

### E. Live acceptance script (COL-2.18)

`apps/worker/scripts/acceptance-phase2-live.ts` (proposed):

```ts
// 0. Preconditions
//    - AGENT_RUNTIME=pi
//    - OpenBao logged in: `bao token lookup` succeeds (use scripts/bao-login.sh)
//    - GitLab project col-acceptance/sandbox-<runner-id> exists with one open issue
//    - Worker is running locally OR triggered via Temporal CLI
//
// 1. Open scope on the home-lab GitLab via the existing Sync bridge:
//      const { scopeId } = await api.scopes.create({ epicIid, projectPath })
// 2. Wait for Architect to commit decomposition (poll, max 5min).
// 3. Wait for one task to be claimed by Developer (poll status:in_progress).
// 4. Pi Coding Agent runs; Developer envelope hits the worker; commit + MR opens.
// 5. Reviewer runs; review envelope, posts review comment, sets approval label.
// 6. Pipeline succeeds (CI is the existing Phase 2 acceptance pipeline — must already be green).
// 7. Human posts /approve in MR. (Operator step — script prints "now post /approve to MR <iid>".)
// 8. Merge gates open; Developer merges; task closes; assert audit trail:
//      const audit = await api.audit.byScope(scopeId);
//      assert(audit.some(e => e.kind === "agent_run.envelope" && e.runtimeBindingName.startsWith("pilot")));
//      assert(audit.every(e => !e.runId.startsWith("fake-")));
//
// 9. Tear-down: delete branches, optionally close MR (--keep flag preserves it).
```

Add to `Taskfile.yml`:

```yaml
acceptance:phase2:live:
  desc: "Live Pi acceptance against home-lab GitLab. Requires bao login + AGENT_RUNTIME=pi."
  preconditions:
    - sh: 'test -n "$BAO_TOKEN"'
      msg: "Run scripts/bao-login.sh first"
  cmds:
    - AGENT_RUNTIME=pi npx tsx apps/worker/scripts/acceptance-phase2-live.ts
```

CI keeps `acceptance:phase2` (fake) for determinism; live target is operator-triggered, never CI.

---

## Next-step punch list (for COL-2.15 owner, ordered by risk)

1. **Spike: prove SDK in-process round-trip (1 day).** Outside the worker, write a 50-line script that imports `@mariozechner/pi-coding-agent`, calls `createAgentSession({ sessionManager: SessionManager.inMemory() })`, registers a single TypeBox tool that captures params, and uses `agent.getApiKey` against a real Anthropic key from OpenBao. Ship the conversation transcript in the spike PR. **Risk:** the SDK behaves differently from the README on subtle points (e.g., `session.dispose()` not actually freeing fetch sockets in Node 24).
2. **TypeBox envelope schemas (1–2 days).** Add `developerCompletionEnvelopeTypeBox` and `reviewerReviewEnvelopeTypeBox` to `packages/schemas`. Vitest fuzz: every Zod-valid value must also be TypeBox-valid and round-trip identical. **Risk:** schema drift between Zod and TypeBox the day someone updates one; mitigation = the round-trip test.
3. **Credential broker shim (1 day).** Add `CredentialBroker` interface to `packages/agent-runtime`; implement an in-process `EnvBackedBroker` for tests and a stub `ToolGatewayBroker` for prod (real impl lives in COL-2.17). `agent.getApiKey` and `beforeToolCall` both consume it. **Risk:** a leaky broker logs the key; add unit test asserting the logger sink never sees the value.
4. **`PiCodingAgentRunner` happy path + tests (2 days).** Per §A above. Use a `streamFn` override to fake the LLM in tests (no network). Acceptance: synthetic packet → schema-valid envelope. **Risk:** `streamFn` shape changes between versions — pin first, document upgrades in ADR-008.
5. **`PiMonoRunner` happy path + tests (1 day).** Mirrors #4. Different defaults (lower turn cap, lower budget, read-only tools). **Risk:** Reviewer with `read` tool can still read secrets in `cwd` — make sure the scratch dir doesn't contain provider tokens.
6. **Cost / turn / timeout ceilings (1 day).** Implement the cost/turns subscriber and the abort timer in the base runner. Add `runtimeBinding.runMaxMs`, `runtimeBinding.maxUsd`, `runtimeBinding.maxTurns` (or a sub-object). **Risk:** abort during streaming sometimes leaves an open `fetch` connection — confirm via Node's `--detect-open-handles`.
7. **Worker bootstrap wiring + AGENT_RUNTIME (1 day).** Per §C. `dynamic import` keeps fake-mode test runs lean. Add boot-time validation: every required credential binding resolves before the worker registers activities. **Risk:** unhandled rejection at boot crashes the pod loop — wrap, log, exit 1 with a clean message.
8. **ADR-008 Pi version pinning (0.5 day).** Codify exact-version pinning, lockstep bumps, manual bump procedure tied to a phase-2 acceptance run. Disable Renovate on the three packages.
9. **COL-2.17 secret plumbing (1–2 days).** Relax the `mountPath || env` validation for `broker: "tool-gateway"`; add `secrets/dev.yaml` entries; add `kv/colony/llm/*` paths in tofu; add `task secrets:rotate llm`. **Risk:** rotation while a run is mid-flight; we accept that mid-flight runs use the stale key (broker reads per-call but the LLM provider may also have a TTL).
10. **COL-2.18 live target (1 day).** Per §E. Fail loudly if `AGENT_RUNTIME != pi`, if `BAO_TOKEN` is missing, or if the fixture project is dirty. **Risk:** flaky LLM behavior on first run — keep `--keep` flag so we can replay the conversation.

Estimate: **~10 working days** for one engineer to land COL-2.15 through COL-2.18 end-to-end, assuming the spike (#1) doesn't surface a blocker.

---

## Key references

- pi-mono root README: `https://github.com/badlogic/pi-mono/blob/main/README.md`
- pi-coding-agent README: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md`
- pi-coding-agent SDK doc: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md`
- pi-coding-agent JSON-mode doc: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md`
- pi-coding-agent RPC-mode doc: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md`
- pi-agent-core README: `https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md`
- pi-ai README: `https://github.com/badlogic/pi-mono/blob/main/packages/ai/README.md`
- pi-coding-agent npm: `https://www.npmjs.com/package/@mariozechner/pi-coding-agent` (latest 0.70.2)
- pi-agent-core npm: `https://www.npmjs.com/package/@mariozechner/pi-agent-core`
- pi-ai npm: `https://www.npmjs.com/package/@mariozechner/pi-ai`
- Mario Zechner blog: `https://mariozechner.at/posts/2025-11-30-pi-coding-agent/`, `https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/`
- Reference SDK consumer cited by Pi: `https://github.com/openclaw/openclaw`

### Colony-side files this work touches

- `packages/agent-runtime/src/pi-adapter.ts` — already has `PiRunner` interface; runners plug in here.
- `packages/agent-runtime/src/adapter.ts` — `parseEnvelope`, `FakeAgentRuntimeAdapter`. Unchanged.
- `packages/agent-runtime/src/runtime-bindings.ts` — relax `mountPath || env` for tool-gateway broker; add LLM credential binding entries.
- `packages/agent-runtime/src/tool-materialization.ts` — already produces scratch dir; runner consumes `environment.tools.scratchDir` as `cwd`.
- `packages/agent-runtime/package.json` — add three exact-pinned `@mariozechner/*` deps.
- `apps/worker/src/developer-run.ts` (line 532–535) and `apps/worker/src/reviewer-run.ts` (line 557) — currently hard-code `FakeAgentRuntimeAdapter`. Replace with the factory from §C.
- `apps/worker/src/worker.ts` — call `createAgentRuntime(env)` at boot.
- `secrets/dev.yaml` — add LLM key entries.
- `tofu/...` — add `kv/colony/llm/*` paths.
- `docs/adr/008-pi-runtime-pinning.md` — new ADR.
- `docs/research/pi-integration.md` — this file.

### Caveats / unverifiable items

- I could not directly fetch `npmjs.com/package/...` pages (HTTP 403) or some `github.com/.../tree/...` URLs (404). All package details above come from the **raw GitHub README/package.json** files (verified content lengths in `/tmp/pim-*`) and the npm registry JSON (`registry.npmjs.org`). Numbers (versions, release count, latest) are accurate as of `2026-04-25`.
- The README directs to `examples/sdk/` for SDK examples; I did not enumerate that directory. Recommend reading it before the spike (#1).
- The README also references `examples/extensions/` and `examples/rpc-extension-ui.ts` — useful only if we ever decide to support extensions inside Colony's runtime, which the addendum does not require.
- Pi's "context auto-loading" (`AGENTS.md`, `CLAUDE.md`) is a CLI feature; the SDK appears to follow the same convention via `DefaultResourceLoader` discovery from `cwd`. We should pass an explicit `ResourceLoader` stub in the runner to disable this — otherwise Pi may load arbitrary `.md` from the scratch dir.
- `pi-ai` 0.70.2 does not expose a generic `response_format: json_schema` option. If a future release adds one we should re-evaluate Option C for envelope coercion.
