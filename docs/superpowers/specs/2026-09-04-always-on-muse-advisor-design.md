# Always-On Muse Advisor Integration

## Status

Approved in chat on 2026-09-04. Colony-only implementation; no OMP SDK changes.

## Goal

Attach OMP's existing native advisor runtime to every Colony-owned primary Pi session except architect sessions. The advisor always uses `openai_compatible/router/muse-spark-1.3-contributor` at `xhigh`, receives only read-only repository tools, and never falls back to another model.

## Decisions

- Implement entirely in `so/colony`; do not fork, patch, or release Oh My Pi.
- Enable the advisor for developer, reviewer, and plan-reviewer primary sessions. Architect sessions and all nested task sessions remain unadvised.
- Register Muse Contributor independently from each primary model chain so reviewer roles can use it without adding it as a primary fallback.
- Set the isolated SDK session's `modelRoles.advisor` to the exact Contributor selector.
- Set `retry.modelFallback: false` for advised sessions. Colony's existing explicit primary fallback loop continues to call `session.setModel()` and therefore remains independent of OMP retry fallback.
- Keep `advisor.syncBacklog` off so advisor work never blocks the primary.
- Grant only OMP's default advisor tools: `read`, `grep`, and `glob`.
- Store the advisor declaration in a private, per-run agent directory rather than the checked-out repository.
- Prompt the advisor to emit `nit` for non-blocking feedback and `blocker` only when immediate steering is required. It must never emit `concern` because OMP 17.3.7 interrupts both concerns and blockers.
- Do not add route-capacity arbitration. `max_parallel_runs` continues to govern Colony primary-run dispatch; advisor side requests use OMP's existing asynchronous runtime and pause/retry behavior on provider limits.
- Contributor-tier prompts and outputs may be used to improve Meta products; this data policy is accepted globally.

## Runtime Wiring

Add an optional `advisorModel: PiModelSpec` to `PiRunnerBaseOptions`. `createAgentWiring()` selects only model ID `router/muse-spark-1.3-contributor` from the resolved developer chain on provider `openai_compatible` and supplies it to developer, reviewer, and plan-reviewer runners. The deployed configuration contains that exact route; configurations without it remain unadvised. Architect runners do not receive the option.

`PiBaseAgentRunner` keeps primary candidates and session-available models distinct:

- Primary candidates remain `[model, ...fallbackModels]` and preserve all existing fallback order and capacity behavior.
- The model registry and credential broker additionally receive `advisorModel` when configured.
- Primary resolution and `scopedModels` include the advisor model for SDK advisor resolution, but Colony's explicit primary fallback loops continue to iterate only the primary candidates.

For each top-level eligible session, the runner creates a temporary agent directory containing `WATCHDOG.yml`:

```yaml
advisors:
  - name: colony-critic
    model: openai_compatible/router/muse-spark-1.3-contributor:xhigh
    tools: [read, grep, glob]
    instructions: |
      Emit nit for feedback that can wait. Emit blocker only when the primary must stop or change course immediately. Never emit concern.
```

The directory is outside the repository workspace and is removed during the runner's existing `finally` teardown. It is passed as `agentDir` only to the top-level primary session. Nested task sessions receive `advisor.enabled: false` and no `agentDir`, preventing advisor multiplication and configuration discovery from the user's machine.

Eligible primary settings add:

```ts
{
  "advisor.enabled": true,
  "advisor.syncBacklog": "off",
  "retry.modelFallback": false,
  modelRoles: {
    advisor: "openai_compatible/router/muse-spark-1.3-contributor:xhigh",
  },
}
```

Architect settings keep `advisor.enabled: false`. No project `WATCHDOG.yml` can override this policy because `disableExtensionDiscovery` remains enabled and Colony points eligible sessions at its private agent directory.

## Behavior

OMP receives primary transcript deltas asynchronously and runs `colony-critic` on Contributor. Read, grep, and glob execute against the run workspace. Advice enters the primary through OMP's native advisor event path.

No model fallback means a Contributor resolution, credential, quota, or transport failure never selects a different advisor model. The primary continues normally. Colony's own primary fallback remains unchanged.

Blocker-only interruption is prompt-enforced because OMP 17.3.7 has no interruption-threshold setting. A compliant `nit` is non-interrupting; a compliant `blocker` interrupts. If the model violates the instruction and emits `concern`, native OMP behavior interrupts it. That limitation is accepted to keep the implementation Colony-only.

## Security

- The advisor receives no `bash`, `edit`, `write`, submission, goal, task, MCP, or LSP tool.
- The private advisor configuration never enters the agent's checkout or commit.
- Existing OMP secret obfuscation and transcript separation remain in force.
- The advisor has no Colony run row, task lease, state-transition authority, or submission authority.

## Verification

Automated coverage must prove:

- An eligible primary session enables exactly one advisor on the exact Contributor model at `xhigh`.
- The advisor model is registered even when absent from the primary fallback chain.
- `retry.modelFallback` is false in the advised session while Colony primary fallback remains available.
- Nested task sessions and architect sessions have advisors disabled.
- The discovered advisor roster exposes only `read`, `grep`, and `glob`.
- The private `WATCHDOG.yml` is removed after run teardown.
- Existing model-fallback tests still pass.

A focused smoke test runs a reviewer against a local OpenAI-compatible fixture, observes one primary request and one Contributor advisor request, and verifies the primary can complete when the advisor endpoint fails.

## Non-Goals

- OMP SDK changes.
- Advisor model fallback.
- Advisor writes, shell access, delegation, or submission.
- Advising architect or nested sessions.
- Replacing Colony's plan review, code review, merge gates, or explicit primary fallback loop.
- Adding a new Colony run role, task state, or database schema.
