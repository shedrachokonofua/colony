# Always-On Muse Advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the existing OMP advisor for every non-architect Colony primary session using only Muse Spark 1.3 Contributor at xhigh with read-only tools and no OMP model fallback.

**Architecture:** Colony registers a dedicated advisor model beside, not inside, each runner's primary fallback chain. Each eligible top-level session receives isolated advisor settings and a private run-scoped `WATCHDOG.yml`; architect and nested sessions stay disabled. No OMP source or package version changes.

**Tech Stack:** TypeScript, Bun, `@oh-my-pi/pi-coding-agent@17.3.7`, Bun test

**Spec:** `docs/superpowers/specs/2026-09-04-always-on-muse-advisor-design.md`

## Global Constraints

- Change only `so/colony`; no OMP SDK changes.
- Advisor model is exactly `openai_compatible/router/muse-spark-1.3-contributor:xhigh`.
- Advisor tools are exactly `read`, `grep`, and `glob`.
- Advisor model fallback is disabled; Colony's explicit primary fallback stays intact.
- Architect and nested task sessions never receive advisors.
- Blocker-only interruption is enforced by instructing the advisor never to emit `concern`.

---

### Task 1: Colony advisor wiring

**Files:**

- Modify: `packages/agent-runtime/src/pi-runner-common.ts`
- Modify: `packages/agent-runtime/src/pi-base-agent-runner.ts`
- Modify: `apps/colonyd/src/agent-runtime.ts`
- Create: `packages/agent-runtime/src/pi-advisor-wiring.test.ts`
- Modify: `docs/superpowers/specs/2026-09-04-always-on-muse-advisor-design.md`

**Interfaces:**

- Consumes: existing `PiModelSpec`, `PiRunnerBaseOptions`, `Settings.isolated()`, `createAgentSession()`, and Colony's explicit `session.setModel()` fallback loop.
- Produces: `PiRunnerBaseOptions.advisorModel?: PiModelSpec`; eligible session settings and private advisor discovery configuration.

- [x] **Step 1: Add failing advisor wiring coverage**

Create a local OpenAI-compatible fixture with distinct `primary` and `router/muse-spark-1.3-contributor` models. Run a reviewer with `advisorModel` configured. Assert requests include the primary and Contributor models, the advisor request advertises only `read`, `grep`, and `glob`, and a failed advisor response does not fail the primary result. Add direct assertions that architect/no-option and nested sessions do not issue advisor requests.

- [x] **Step 2: Run the focused test and observe failure**

Run:

```bash
bun test packages/agent-runtime/src/pi-advisor-wiring.test.ts
```

Expected before implementation: TypeScript/runtime failure because `advisorModel` is not accepted and no advisor request is created.

- [x] **Step 3: Add the dedicated advisor model option**

Extend `PiRunnerBaseOptions` with:

```ts
readonly advisorModel?: PiModelSpec;
```

In `PiBaseAgentRunner.run()`, keep the primary candidate array unchanged and add the optional advisor model only to provider credential lookup, model registry registration, and session `scopedModels`.

- [x] **Step 4: Configure only top-level non-architect sessions**

Create a private run-scoped agent directory and canonical `WATCHDOG.yml`. For the top-level session, pass its path as `agentDir` and construct isolated settings with `advisor.enabled: true`, `advisor.syncBacklog: "off"`, `retry.modelFallback: false`, and the exact `modelRoles.advisor` selector. For nested/transient and architect sessions, set `advisor.enabled: false`, omit `agentDir`, and preserve current settings. Remove the private directory in the existing runner teardown.

- [x] **Step 5: Wire the deployed Contributor model**

In `createAgentWiring()`, select only `router/muse-spark-1.3-contributor` from the resolved developer model chain on provider `openai_compatible`. Supply that resolved model as `advisorModel` to developer, reviewer, and plan-reviewer runners only; configurations without the exact route remain unadvised.

- [x] **Step 6: Run focused and regression tests**

Run:

```bash
bun test packages/agent-runtime/src/pi-advisor-wiring.test.ts
bun test packages/agent-runtime/src/pi-model-fallback.test.ts -t "continues the same session on the next configured model after a provider failure"
```

Expected: all pass; local fixture observes Contributor advisor traffic, nested/architect exclusion, and successful primary completion during advisor failure.

- [x] **Step 7: Typecheck and smoke the changed path**

Run:

```bash
bun run typecheck
```

Then run the focused advisor fixture once as the behavioral smoke test and verify its request log contains the exact Contributor ID and no alternative advisor model.

- [x] **Step 8: Commit the Colony-only implementation**

```bash
git add apps/colonyd/src/agent-runtime.ts packages/agent-runtime/src/pi-runner-common.ts packages/agent-runtime/src/pi-base-agent-runner.ts packages/agent-runtime/src/pi-advisor-wiring.test.ts docs/superpowers/specs/2026-09-04-always-on-muse-advisor-design.md docs/superpowers/plans/2026-09-04-always-on-muse-advisor.md
git commit -m "feat: enable Muse Contributor advisor"
```
