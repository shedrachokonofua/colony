# Auditing agent runs: findings and design

Research synthesis, 2026-08-30. Sources: three primary-source investigations — this repo's audit data flow, the @oh-my-pi SDK v17.3.7 source (`node_modules/@oh-my-pi/*`), and external prior art (OTel GenAI semconv, Langfuse, OpenHands, Claude Code, Harbor ATIF, git/overlayfs/JuiceFS/s3fs/asciicast docs). Motivating incident: run `38eaa037` on `col-0ed33d39.2` took 51 min; the events feed could show *that* 74 bash calls happened but not *which commands*, the first 12 minutes fell off the 200-row API cap, and a rejected completion submit recorded only `isError: true`.

## 1. The central finding: the data already exists and is thrown away

Colony's audit gap is not a missing capture mechanism. Every field an operator wants is present in-process at the moment the current sink discards it:

| Wanted | Where it already exists | Where it dies |
|---|---|---|
| Tool-call arguments (the shell command) | SDK `tool_execution_start.args`, `afterToolCall` context (`pi-agent-core/src/types.ts:864-885`) | `pi_tool_call` logs args only if `logToolArgs`; colonyd never sets it (`packages/agent-runtime/src/pi-base-agent-runner.ts:676-685`, `apps/colonyd/src/agent-runtime.ts:145-203`) |
| Tool result, details, tool-call id, intent | SDK `tool_execution_end`, `ToolResultMessage` (`pi-ai/src/types.ts:942-980`) | Never forwarded; only boolean `isError` survives |
| Command text, cwd, exit code, duration | Sandbox exec boundary — every agent command flows through `ExecRequest`/`ExecResult` (`packages/agent-runtime/src/sandbox-tools.ts:50-112`) | Consumed into the tool result, then dropped |
| Per-request model latency, TTFT, stop reason, error detail, provider/model | `AssistantMessage.duration/.ttft/.stopReason/...` (`pi-ai/src/types.ts:892-949`) | `pi_usage` logs 4 token buckets + cost total; computes its own inter-message interval instead (`pi-runner-common.ts:612-630`) |
| Full transcript (replayable JSONL, tool calls + results + usage per turn) | SDK file-backed `SessionManager` writes `<ts>_<id>.jsonl` (`pi-coding-agent/src/session/session-manager.ts:1132-1136`) | Colony passes `SessionManager.inMemory(cwd)` (`pi-base-agent-runner.ts:447-454`) — transcript exists only in RAM, lost at run end |
| Rejected-completion reason | Submit tool throws a detailed error (`pi-runner-common.ts:929-986`); `session_stop` carries `reason`/`additionalContext` (`pi-coding-agent/src/extensibility/shared-events.ts:393-403`) | Run event records `isError: true` and nothing else |
| Run summary (aggregated usage/cost/tool latencies) | `agent_end.telemetry`, `AgentTelemetryConfig.onRunEnd(summary, coverage)` (`pi-agent-core/src/telemetry.ts:319-405`) | No subscriber |

Note the SDK session runs **in the colonyd process** (tools exec remotely into the pod); a file-backed session manager writes its JSONL on the colonyd host, so transcript persistence does not even require pod exfiltration.

Storage/API defects compounding it: `/runs/:id/events` always returns the newest 200 rows with no pagination parameters (`packages/core/src/store.ts:1240-1248`, `apps/colonyd/src/http.ts:1095-1100`) — older rows *are* in SQLite but unreachable; `audit` has no `run_id` filter; `finishRun` emits no audit row; the root span's `run_id` attribute is generated before the store mints the real row id, so trace→run correlation is misaligned; SDK child spans carry no run id at all.

## 2. Verdict on "agent filesystem based on S3"

**No — not as the audit primitive.** An S3-backed live workdir (JuiceFS/s3fs-style) is a state-persistence mechanism, not an audit log:

- It captures only the *latest* tree — no temporal history, no command chronology, no causality. "State at minute 47" still requires explicit snapshots.
- s3fs-class semantics are documented as non-local: whole-object rewrites on random writes, non-atomic rename, no multi-client coordination (s3fs README). JuiceFS is a real filesystem (metadata engine + chunk store, close-to-open consistency) but adds a metadata service, cache management, and network round-trips to compile/test workloads dominated by small-file and metadata I/O.
- FUSE mounts inside the sandbox are a runtime-integration problem, and it would not even preserve the transcript (which lives in colonyd, not the pod).

**The right role for S3 is immutable evidence export:** transcripts, oversized tool results, stdout/stderr streams, run-end workspace bundles — content-hashed, with references in SQLite. This is the pattern OTel GenAI semconv recommends for large/sensitive content (externalize, reference on spans), Langfuse's architecture (DB for queryable metadata, S3-compatible blob store for raw events/media), and Claude Code/OpenHands practice (local JSONL/event files, durable storage a separate concern).

For workspace capture specifically, Colony has a cheaper native option than filesystem machinery: **the pod already has git and push credentials**. A run-scoped shadow ref (`refs/colony/runs/<run_id>`) pushed at phase boundaries + run end captures tracked tree states with dedup for free, queryable by `git log/diff`. Reflogs don't count (local, expirable). A final `git bundle`/tar of untracked-but-relevant files to S3 covers the rest.

## 3. Recommended design — four layers, in order of value per effort

**Layer 0 — stop dropping what you already hold (colonyd + agent-runtime only).**
Subscribe once per session to the SDK `AgentEvent` stream (or install `beforeToolCall`/`afterToolCall`): persist per tool call `{tool_call_id, tool, args (redacted), intent, started_at, ended_at, duration_ms, result_summary, result_ref?, isError, error_detail}`; per assistant turn the full usage breakdown plus `model`, `provider`, `duration`, `ttft`, `stopReason`, error fields; `session_stop`/submit-rejection reasons; `agent_end` summary via `onRunEnd`. Capture exec metadata (command, cwd, exit code, duration) at the `sandbox-tools` exec boundary — the choke point every agent command already flows through. Paginate `/runs/:id/events` (`before_id` cursor); add `run_id` filter to `/audit`; emit a `run.finished` audit row; write the root span attribute after the store mints the run id, and pass ambient `colony.run_id` into SDK telemetry attrs.

**Layer 1 — transcripts.** Replace `SessionManager.inMemory` with file-backed sessions under a colonyd-owned runs directory; on `finishRun`, gzip and upload the JSONL to S3 (any endpoint) as `runs/<run_id>/transcript.jsonl.gz` with SHA-256, store the reference + hash on the run row. Retention by policy (e.g. 90 days), append-only bucket.

**Layer 2 — workspace evidence.** Shadow ref pushed per phase + at run end; run-end bundle of untracked deltas to S3 with a manifest (paths, modes, hashes, deletions). Uploader must confirm completion before sandbox destroy (Langfuse's short-lived-process `flush()` warning applies verbatim to pod teardown).

**Layer 3 — optional deep forensics.** asciicast v3 PTY capture for shell-heavy runs (input capture off by default; casts are secret-bearing). Runtime-level syscall audit (gVisor seccheck `execve` trace points) is **not currently applicable**: the sandbox CR pins `runtimeClass: kata`, not gVisor (`packages/sandbox-k8s/src/contract.ts`). The SDK/exec-boundary capture in Layer 0 covers command provenance because sandboxed commands cannot bypass the exec contract.

**Interchange:** export runs as Harbor ATIF trajectories (steps, tool calls/results, metrics, subagents; Colony extensions in `extra` for shadow-ref SHA, bundle ref, transcript ref, trace id). Follow OTel GenAI span naming (`invoke_agent`/`plan`/`execute_tool`) but pin the schema version — the conventions are still Development status.

## 4. What each layer buys for the motivating incident

With Layer 0, "why did the latest agent on `.2` take 51 minutes" is one API call: every bash command with duration and exit code, model latency per turn, and the exact reason the 02:30:35 submit was rejected. Layer 1 makes the run replayable and reviewable turn-by-turn. Layer 2 answers "what did the tree look like when it committed at minute 36". Layer 3 is incident-grade fidelity.

## Source reports

Full agent reports (session-local artifacts): repo data-flow audit (`local://audit-repo-findings.md`), SDK/gVisor capabilities (`local://audit-sdk-findings.md`), external prior art with citations and comparison table (`local://audit-prior-art.md`). Key external sources: OTel GenAI semconv (execute_tool span, opt-in `gen_ai.tool.call.arguments/result`), Langfuse data model + blob storage, OpenHands event persistence, Claude Code sessions/hooks/checkpointing, Harbor ATIF RFC 0001, Linux OverlayFS docs, gVisor filesystem/seccheck docs, JuiceFS/s3fs READMEs, asciicast v3 spec, git-commit/push/reflog docs.
