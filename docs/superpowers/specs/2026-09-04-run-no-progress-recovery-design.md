# Run Visibility, Repair Integrity, and Pipeline Speed

## Incident (2026-09-04)

Two implement runs for `col-c8f58a57.3` appeared hung for ~10 minutes each: no run events, lease still renewing. Investigation showed neither run was stuck. Each was waiting on a sandbox `bash` call (`bun test packages/agent-runtime`, 476 s; `npm run test:unit`, 590 s). Only tool *end* is recorded in `run_events` (`tool_call`/`command` rows), so a long-running command is indistinguishable from a dead run in the API and console.

Two real defects surfaced alongside:

1. The repair run dispatched after a reviewer `request_changes` submitted `complete` with the **same head SHA the reviewer rejected** (`c14c7589…`). Colonyd accepted it and moved the task back to `mr_open` with the blocker unresolved.
2. `npm run test:unit` takes 500–590 s. 449 s of that is one file, `packages/agent-runtime/src/pi-model-fallback.test.ts`, which waits out real backoff sleeps. In the sandbox this landed 10 s short of the 600 s exec timeout; in CI the unit suite runs twice (unit stage, then again inside `npm test` in the e2e stage), and every job spends ~4–5 min realising a nix dev shell from an empty store.

The runtime already has a liveness watchdog (`installRunGuards`: 12 min silence with tool-in-flight exemption, 20 min tool-wedge cap). No new watchdog is added.

## Slice 1: test speed

### Runtime seams

`PiRunnerBaseOptions` gains two optional fields, defaults identical to today:

- `jiggleBackoffMs?: number` — replaces the `JIGGLE_BACKOFF_MS = 15_000` constant in `pi-base-agent-runner.ts`. Sleep is `jiggleBackoffMs * jigglesUsed`.
- `retryBaseDelayMs?: number` — forwarded to the SDK settings block beside `retry.maxRetries` as `retry.baseDelayMs` (SDK default 500).

Production config never sets them.

### Tests

`pi-model-fallback.test.ts` passes `jiggleBackoffMs: 1` and `retryBaseDelayMs: 1` and shrinks `runTimeoutMs` walls accordingly. Assertions are unchanged: same models requested, same `pi_model_fallback` / `pi_zero_output_jiggle` / stall events, same envelopes. Target: file under 10 s.

Any remaining fixed waits in unit tests that do not involve a live socket use `jest.useFakeTimers()` per the repo rule.

### CI dedupe

`package.json` gains `test:integration`: the `git ls-files` pipeline with `grep '\.integration\.test\.ts$'`. The `e2e-tests` job runs `bun run test:integration && bun run test:e2e` instead of `npm test`. `unit-tests` is unchanged. `npm test` (full suite) remains for local use.

## Slice 2: active-operation visibility

### Store

`runs` gains, via migration 14 `runs-active-operation`:

- `last_progress_at TEXT`
- `active_tool TEXT` — tool name while a tool call is in flight, else NULL
- `active_tool_detail TEXT` — redacted, bounded (200 chars) summary: the bash command, or the path for file tools
- `active_tool_started_at TEXT`

`Store.setRunActiveTool(runId, tool, detail, startedAt)` and `Store.clearRunActiveTool(runId, progressAt)` update only rows with `status = 'running'`. Both also set `last_progress_at`. `Store.touchRunProgress(runId, at)` sets `last_progress_at` alone.

### Runtime → colonyd

The runner already observes `tool_execution_start` / `tool_execution_end` in `installRunGuards` and emits `pi_tool_observation` at end. It additionally logs `pi_tool_start` `{tool, detail}` at start. colonyd's `createRunEventSink` maps:

- `pi_tool_start` → `setRunActiveTool`
- `pi_tool_observation` → `clearRunActiveTool`
- `pi_turn_usage` → `touchRunProgress`

The sink already persists every event to `run_events`; no second path is introduced.

### Read surface

The `Run` row type and every existing run payload (`GET /runs/:id`, `runs` in scope/task reads, `listProjectRunning`) carry the four fields automatically because they select `*`. The console run line shows `active_tool` + `active_tool_detail` with a live duration from `active_tool_started_at` when present, reusing `run-duration`.

## Slice 3: unchanged rejected head

### Packet

`buildImplementPacket` continuity already carries `reviewFindings`. It additionally carries `rejectedHeadSha: string | undefined` — the `head_sha` of the latest `review` run whose verdict was `request_changes` for this task. The packet exposes it as `repair.rejected_head_sha`.

### Submit-tool guard (runtime)

In the implementer submit tool, when `packet.repair?.rejected_head_sha` is set and the envelope has `status: "complete"` with `head_sha === rejected_head_sha`, the tool rejects with:

> Your submission names `<sha>`, the head the reviewer already rejected. Nothing was changed. Address the findings below, commit, push, then submit the new SHA. `<findings>`

The session stays open; the rejection is recorded as `completion_rejected` like any other. A second unchanged-head rejection on the same model leg advances to the next configured model on the same session (the existing `pi_model_fallback` path, reason `repair_no_change`). Exhausting candidates ends the run with failure reason `repair_no_change`.

### Defensive check (colonyd)

In `implement.ts`, after fact-checking the envelope and before `running -> mr_open`: if the run carried `rejectedHeadSha` and the verified branch head equals it, finish the run `failed` with error `repair_no_change`, fault `{layer:"colonyd", code:"repair_no_change"}`, audit `run.repair_no_change`, and let the existing rejected-review requeue policy handle the retry. This covers non-Pi adapters.

Not affected: first implementation, interrupted-run continuity, merge-gate landing mode, the "already satisfied on main" branch (`head_sha === baseSha` with no MR).

## Slice 4: CI without nix

`validate` and `unit-tests` run on `oven/bun:<colony-versions.json bun>` with git installed. `e2e-tests` runs on the Playwright image matching `@playwright/test` with bun installed on top; `COLONY_TEST_CHROMIUM_PATH` points at the bundled chromium. `flake.nix` stays for local development. Image tags are derived from `colony-versions.json` so the existing single-source pin holds.

## Tests

- Slice 1: `pi-model-fallback.test.ts` green under 10 s; full `test:unit` under 90 s locally.
- Slice 2: store tests for set/clear/touch and migration parity; sink test mapping the three events; console run-line test rendering the active tool.
- Slice 3: runtime test — reviewer-repair packet, model submits rejected SHA → `completion_rejected`, then pushes a new commit and is accepted; second no-change → fallback model; exhaustion → `repair_no_change`. colonyd integration test — fake adapter returns rejected SHA → run fails `repair_no_change`, task never enters `mr_open`.
- Slice 4: verified by the pipeline on the MR.
