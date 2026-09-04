# Run Visibility, Repair Integrity, and CI Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut pipeline wall time, make long tool calls visible, and prevent reviewer repairs from succeeding without changing the rejected head.

**Architecture:** Keep runtime behavior unchanged except for two test-only delay seams and the repair submit invariant. Reuse the existing logger→RunEventSink path for active-tool persistence. Remove duplicated CI work and replace per-job nix shell realization with pinned runtime images.

**Tech Stack:** Bun 1.3.14, TypeScript, SQLite, Hono, Lit, GitLab CI, Playwright 1.62.1.

**Spec:** `docs/superpowers/specs/2026-09-04-run-no-progress-recovery-design.md`

## Global Constraints

- Production retry and jiggle timings remain unchanged.
- Unit tests keep every existing behavioral assertion.
- The existing liveness watchdog remains unchanged.
- Active-tool detail is redacted and capped at 200 characters before persistence.
- Reviewer-repair completions must advance beyond the rejected review head.
- Existing first-implementation and already-satisfied-on-main behavior remains unchanged.

---

### Task 1: Deterministic fallback timing and CI test partition

**Files:**

- Modify: `packages/agent-runtime/src/pi-base-agent-runner.ts`
- Modify: `packages/agent-runtime/src/pi-model-fallback.test.ts`
- Modify: `package.json`
- Modify: `.gitlab-ci.yml`

**Interfaces:**

- Produces: `PiRunnerBaseOptions.jiggleBackoffMs?: number`
- Produces: `PiRunnerBaseOptions.retryMaxRetries?: number`
- Produces: root script `test:integration`

- [x] Add a test-only 1 ms jiggle and zero SDK retry budget while preserving fallback event sequences.
- [x] Record the isolated file baseline: 449.3 seconds.
- [x] Add the two optional runner settings; keep production defaults 15000 and 4.
- [x] Isolate runner retry policy from `pi-ai`'s independent transport retry loop.
- [x] Run the file in 12.3 seconds with all seven tests and 39 assertions passing.
- [x] Add `test:integration` selecting only tracked `*.integration.test.ts` files.
- [x] Change `e2e-tests` to run `bun run test:integration && bun run test:e2e` rather than `npm test`.
- [x] Run `bun run test:unit`: 1258 pass, 2 skip, 0 fail in 50.47 seconds.
- [x] Commit as `test: eliminate real fallback backoffs`.

### Task 2: Persist and render active tool operation

**Files:**

- Modify: `packages/core/src/schema.sql`
- Modify: `packages/core/src/migrations.ts`
- Modify: `packages/core/src/store.ts`
- Modify: `packages/core/test/store.test.ts`
- Modify: `packages/agent-runtime/src/pi-runner-common.ts`
- Modify: `apps/colonyd/src/agent-runtime.ts`
- Modify/Test: `apps/colonyd/test/audit-sink-wiring.test.ts`
- Modify: relevant console run-row element and test located via symbol search

**Interfaces:**

- Produces: `Store.setRunActiveTool(runId, tool, detail, startedAt): void`
- Produces: `Store.clearRunActiveTool(runId, progressAt): void`
- Produces: `Store.touchRunProgress(runId, at): void`
- Produces: run columns `last_progress_at`, `active_tool`, `active_tool_detail`, `active_tool_started_at`
- Consumes: existing logger event path and `run-duration`

- [x] Add store tests for start, progress, clear, terminal-row no-op, finish cleanup, and migration parity.
- [x] Add schema columns and migration 14; extend `Run`.
- [x] Implement atomic running-row-only store methods and pass focused core tests.
- [x] Emit `pi_tool_start` with redacted bounded detail from the existing tool start subscription.
- [x] Map start/end/turn events in `createRunEventSink` to store methods; add focused sink tests.
- [x] Locate the shared console run line, add active command text and live duration, and add a DOM test.
- [x] Run focused core, colonyd sink, console, and typecheck checks.
- [x] Commit as `feat: expose active run operations`.

### Task 3: Enforce reviewer-repair head advancement

**Files:**

- Modify: `apps/colonyd/src/runs/packets.ts`
- Modify: `apps/colonyd/src/runs/implement.ts`
- Modify: `packages/agent-runtime/src/pi-base-agent-runner.ts`
- Modify: implement submit-tool construction in `packages/agent-runtime/src/pi-runner-common.ts` if required by the existing seam
- Modify/Test: existing implement packet/runtime/orchestration test files located via symbol search

**Interfaces:**

- Produces: `ImplementContinuity.rejectedHeadSha?: string`
- Produces: packet `repair.rejected_head_sha`
- Produces: failure code `repair_no_change`

- [x] Add a packet test proving latest request-changes review head is included only for reviewer repair.
- [x] Add a runtime test where the first submission uses the rejected SHA and is rejected without ending the session; accept a changed pushed SHA.
- [x] Add runtime tests for repeated no-change fallback and model exhaustion.
- [x] Implement submit interception using the existing completion-rejection and model-fallback machinery.
- [x] Add a colonyd orchestration test using a non-Pi adapter that returns the rejected SHA; assert run failed and task never reaches `mr_open`.
- [x] Add the final defensive verified-head check in `implement.ts` with structured audit.
- [x] Run focused runtime and colonyd tests.
- [x] Commit as `fix: reject unchanged reviewer repairs`.

### Task 4: Replace nix CI shells with pinned images

**Files:**

- Modify: `.gitlab-ci.yml`
- Create only if necessary: a small CI Dockerfile under `docker/ci/`

**Interfaces:**

- Consumes: `colony-versions.json` bun/node versions and `package.json` Playwright version.
- Produces: validate/unit/integration/browser jobs with identical commands and runtime versions.

- [x] Verify exact upstream image tags and installed binaries for Bun 1.3.14 and Playwright 1.62.1.
- [x] Replace `.with-deps` nix setup with pinned images; preserve dependency cache.
- [x] Ensure git is present for workspace and test helpers.
- [x] Use Playwright's bundled Chromium and fonts.
- [ ] Validate GitLab YAML locally if available and let the branch pipeline prove the container contract.
- [ ] Commit as `ci: remove nix shell setup from test jobs`.

### Task 5: Full verification

**Files:**

- No new files.

- [ ] Run `bun run typecheck`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run test:unit` and report duration.
- [ ] Run `bun run test:integration`.
- [ ] Run the Playwright smoke path available on the host; if Chromium is unavailable locally, report CI as the browser verification boundary.
- [ ] Confirm the original checkout's `README.draft.md` and `docs/development.md` changes remain untouched.
- [ ] Push the branch, observe the pipeline, and report per-job before/after durations.
