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
- Produces: `PiRunnerBaseOptions.retryBaseDelayMs?: number`
- Produces: root script `test:integration`

- [ ] Add failing assertions/tests that construct a runner with 1 ms retry/jiggle delays while preserving expected fallback event sequences.
- [ ] Run `bun test packages/agent-runtime/src/pi-model-fallback.test.ts` and record the baseline duration.
- [ ] Add the two optional runner settings; keep defaults 15000 and 500.
- [ ] Update every fallback test fixture to use short delays and shrink only timeout ceilings, not assertions.
- [ ] Run the file and require under 10 seconds with identical pass count.
- [ ] Add `test:integration` selecting only tracked `*.integration.test.ts` files.
- [ ] Change `e2e-tests` to run `bun run test:integration && bun run test:e2e` rather than `npm test`.
- [ ] Run `bun run test:unit` and record total duration.
- [ ] Commit as `test: eliminate real fallback backoffs`.

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

- [ ] Add failing store tests for start, progress, clear, terminal-row no-op, and migration parity.
- [ ] Add schema columns and migration 14; extend `Run`.
- [ ] Implement atomic running-row-only store methods and pass focused core tests.
- [ ] Emit `pi_tool_start` with redacted bounded detail from the existing tool start subscription.
- [ ] Map start/end/turn events in `createRunEventSink` to store methods; add focused sink tests.
- [ ] Locate the shared console run line, add active command text and live duration, and add a DOM test.
- [ ] Run focused core, colonyd sink, console, and typecheck checks.
- [ ] Commit as `feat: expose active run operations`.

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

- [ ] Add a packet test proving latest request-changes review head is included only for reviewer repair.
- [ ] Add a runtime test where the first submission uses the rejected SHA and is rejected without ending the session; accept a changed pushed SHA.
- [ ] Add runtime tests for repeated no-change fallback and model exhaustion.
- [ ] Implement submit interception using the existing completion-rejection and model-fallback machinery.
- [ ] Add a colonyd orchestration test using a non-Pi adapter that returns the rejected SHA; assert run failed and task never reaches `mr_open`.
- [ ] Add the final defensive verified-head check in `implement.ts` with structured fault/audit.
- [ ] Run focused runtime and colonyd tests.
- [ ] Commit as `fix: reject unchanged reviewer repairs`.

### Task 4: Replace nix CI shells with pinned images

**Files:**
- Modify: `.gitlab-ci.yml`
- Create only if necessary: a small CI Dockerfile under `docker/ci/`

**Interfaces:**
- Consumes: `colony-versions.json` bun/node versions and `package.json` Playwright version.
- Produces: validate/unit/integration/browser jobs with identical commands and runtime versions.

- [ ] Verify exact upstream image tags and installed binaries for Bun 1.3.14 and Playwright 1.62.1.
- [ ] Replace `.with-deps` nix setup with pinned images; preserve dependency cache.
- [ ] Ensure git is present for workspace and test helpers; use a tiny derived image only if the upstream image lacks it.
- [ ] Point Playwright at the bundled Chromium and preserve fonts.
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
