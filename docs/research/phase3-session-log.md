# Phase 3 session log — 2026-04-29

## Status (live)

Phase 3 build is **complete**. All sub-tasks COL-3.0a → COL-3.6 landed
and pushed; the headline COL-3.7 acceptance is iterating against
home-lab GitLab with `AGENT_RUNTIME=pi` (Codex/gpt-5.5 across
developer / reviewer / architect).

## What's in the repo

| Task                                 | What landed                                                                                    | Commit               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------- |
| COL-3.0a Architect run               | Schema + builder + `PiArchitectRunner` + worker activity                                       | `701b62e`            |
| COL-3.0a Reviewer spec/DAG           | `decomposition-review-run` activity + 4 DB tests                                               | `7354ca1`            |
| COL-3.0a Scope-level command routing | webhook mirror lookup + supervisor handler + `applyDecompositionCommand` activity + 5 DB tests | `c92e749`            |
| COL-3.0a UI                          | Decomposition tab on scope page + GET endpoints + 22 API tests still green                     | `e99b3b3`            |
| COL-3.1a Rework loop                 | `requestTaskRework` invalidates approvals + 3 DB tests                                         | `a7c55c0`            |
| COL-3.3 Outage handling              | `provider.health()` + `markScopePendingSync` + supervisor freeze + 3 DB tests                  | `afb44cc`            |
| COL-3.4 Conflict state               | `recordTaskConflict` + `resolveTaskConflict` + 4 DB tests                                      | `8e34d0b`            |
| COL-3.5 Operator override            | `applyOperatorOverride` gated by `policy.override` + 4 DB tests                                | `4923858`            |
| COL-3.5a Blocker + requeue           | `ingestBlockedEnvelope` + `requeueBlockedTask` + 4 DB tests                                    | `dbc3d82`            |
| COL-3.5b Scope close                 | `evaluateScopeCloseReadiness` + `requestScopeReview` + `closeScope` + 5 DB tests               | `4156117`            |
| COL-3.6 UI ops                       | Closure tab on scope page + `GET /scopes/{scopeId}/close-readiness`                            | `75a8834`            |
| COL-3.7 Acceptance script + bench    | `task acceptance:phase3` + `task bench:runners`                                                | `b94cac2`, `4dc6d3e` |

## Test counts

- **134** unit tests passing across 12 files
- **8 new DB-backed integration test files** (architect, decomposition reviewer, decomposition command, task rework, provider outage, task conflict, operator override, blocker, scope close) — **35 new integration tests**, all green against the docker-compose `colony_test` Postgres
- Existing suites (developer-run live, phase2-flow, reconciliation, api-http) still green

## Phase 3 acceptance results

(filled in live as the run completes)

## Next actions for you

1. Inspect the scope at `http://localhost:3000/scopes/<scope_id>` — Tasks, Decomposition, Closure, Provider Sync, Audit tabs all populated.
2. `task acceptance:phase3` (or `npm run acceptance:phase3`) re-runs end-to-end. Each attempt costs roughly the Codex tokens for one 6-min architect run + N short developer/reviewer cycles per proposed task.
3. `task bench:runners` (or `npm run bench:runners`) writes a numbers sheet at `docs/research/bench-results-<stamp>.{md,json}`. First-cut benches whatever's wired in `config/colony.yaml`; per-model swap-out lands in the next iteration once you decide which Ollama-cloud roster to score.
4. The Ollama-cloud Developer (kimi-k2.6 / glm-5.1 / deepseek-v4-pro) swap-in is parked under task #21. The finalizer prompts already lift envelope-quality reliably; once you pick a model from the bench, swap `agents.developer.provider/model` in `config/colony.yaml` and re-run phase3.
