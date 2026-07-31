# Dark-factory research digest — 2026-07-31

Four parallel literature reviews plus a full read-only audit of the codebase,
run while Colony was being taken to production on Aether. Captured here because
the source agent artifacts are ephemeral.

Everything below is a **proposal**, not implemented, unless the session notes
say otherwise. Recommendations are mapped to Colony components with rough effort
(S/M/L) and the phase they belong to in `docs/tasks.md`.

Sections:

1. Multi-agent software organisations
2. Reliability and safety of long-running agent systems
3. Lights-out / dark-factory operations principles
4. Beads and agent-native work tracking
5. Coding-agent implementation (SOTA vs Colony's Pi runner)
6. Codebase audit findings
7. Suggested priority order

---

## 1. Multi-agent software organisations

Sources: ChatDev (ACL'24) <https://aclanthology.org/2024.acl-long.810/> ·
AutoDev <https://arxiv.org/abs/2403.08299> ·
OpenHands <https://arxiv.org/abs/2407.16741> ·
Magentic-One <https://arxiv.org/abs/2411.04468> ·
scaling agent collaboration <https://arxiv.org/abs/2406.07155> ·
SWE-agent <https://arxiv.org/abs/2405.15793> ·
Agentless <https://arxiv.org/abs/2407.01489> ·
SWE-Gym <https://arxiv.org/abs/2412.21139> ·
AutoCodeRover <https://arxiv.org/abs/2404.05427> ·
SWE-Search <https://arxiv.org/abs/2410.20285> ·
LLM-as-judge for SE <https://arxiv.org/abs/2502.06193> ·
MetaGPT <https://arxiv.org/abs/2308.00352> ·
Devin <https://cognition.com/blog/introducing-devin>

Findings that matter for Colony:

- **Difficulty-based routing.** Agentless beats several agent frameworks on
  SWE-bench Lite at ~$0.70/instance using a fixed localise → repair → validate
  pipeline. Not every task needs a full agent loop.
  → _Route easy/mechanical tasks through a deterministic pipeline; reserve the
  planner/executor/reviewer loop for hard ones._ (M, Phase 3.5/4)
- **Planner ≠ executor.** MetaGPT's SOPs and Magentic-One's Orchestrator both
  separate planning from execution so the planner can be the stronger reasoner.
  Aider ships the same idea as its architect/editor split.
  → _Done this session_: the per-task planner now runs on the architect model.
- **Review redundancy.** SWE-Search uses an explorer + value agent + discriminator
  debate for ~23% relative gain. The LLM-as-judge survey finds output-based
  judges correlate well with humans but are **order-sensitive** in pairwise mode.
  → _N-version review for high-risk MRs: two reviewers, different models/prompts,
  supervisor quorum. Never a single judge alone on security-relevant diffs._
  (M/L, Phase 3.5/4)
- **Diminishing returns on agent count.** MacNet shows logistic performance
  growth with scale, and irregular topologies beat regular ones.
  → _Don't fix a reviewer bottleneck by adding developers._ See WIP limits below.
- **Convergence controls.** Bound turns/tokens/cost/time, detect no-op and
  oscillation, escalate on plateau rather than looping. (S, Phase 3.5)

## 2. Reliability and safety of long-running agent systems

Sources: Temporal workflows <https://docs.temporal.io/workflows> ·
continue-as-new <https://docs.temporal.io/workflow-execution/continue-as-new> ·
activity failure detection <https://docs.temporal.io/encyclopedia/detecting-activity-failures> ·
LangSmith online evaluators <https://docs.langchain.com/langsmith/online-evaluations-llm-as-judge> ·
Braintrust online scoring <https://www.braintrust.dev/docs/evaluate/score-online> ·
OpenAI Agents HITL <https://openai.github.io/openai-agents-python/human_in_the_loop/> ·
Google SRE SLOs <https://sre.google/sre-book/service-level-objectives/> ·
SRE alerting <https://sre.google/sre-book/practical-alerting/> ·
NIST GenAI Profile <https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf>

- **Run-health SLOs.** Track heartbeat age, state-transition age, queue latency,
  retries, envelope-rejection rate, spend, tool denials, reconciliation
  freshness. Use p95/p99 and burn-rate alerting; alert on scope health but keep
  task/run drill-down. (M, Phase 4/X.1)
- **Durable checkpoints + heartbeats.** Long agent activities should heartbeat
  with a payload so a retry resumes rather than restarts.
  → _Partially done_: `agent_runs` now records per-run start/finish and status.
- **Online evaluation before gates.** Score every state-changing envelope
  (correctness, tests, acceptance evidence, policy, uncertainty), persist
  evaluator version + input hash + score, and require a fresh passing score
  before merge/close. Sample non-critical, 100% on critical. Both LangSmith and
  Braintrust document async scoring with sampling and cost caps. (L, Phase 3.5/4)
- **Evidence-based gates with TTL.** Gate readiness should derive only from
  immutable facts (commit SHA, pipeline status, approvals, evaluator score,
  reconciliation version), each with a freshness bound; missing or contradictory
  evidence → conflict, never inferred approval. (M, Phase 3.1a/3.5b)
  → _This session's stale-head bug is exactly this principle failing in
  practice: the gate compared against a recorded head that had gone stale._
- **Quarantine flaky tasks.** Classify failure reason, bound retries per
  task/model, then quarantine with cooldown and escalate. (M, Phase 3.5a)
  → _Partially done_: heartbeat now backs off 1/2/4/8 and opens a circuit
  breaker after five consecutive failures.
- **Budget/anomaly kill switch.** Per-run and per-scope ceilings on tokens,
  spend, tool calls, wall time, diff size, egress; hard-stop and revoke
  credentials on breach, with audited operator override. (M, Phase 4)
- **NIST MG-2.4** explicitly calls for defined deactivation criteria and
  escalation paths, and for recording errors and near-misses with postmortems.

## 3. Lights-out / dark-factory operations

Sources: LEI jidoka <https://www.lean.org/lexicon-terms/jidoka/> ·
andon <https://www.lean.org/lexicon-terms/andon/> ·
error-proofing <https://www.lean.org/lexicon-terms/error-proofing/> ·
theory of constraints <https://www.lean.org/lexicon-terms/theory-of-constraints/> ·
Kanban guide <https://kanban.university/kanban-guide/> ·
NIST SPC handbook <https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc31.htm> ·
Google SRE release engineering <https://sre.google/sre-book/release-engineering/> ·
chaos principles <https://principlesofchaos.org/> ·
Backstage templates <https://backstage.io/docs/features/software-templates/> ·
GitHub cloud agent <https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent>

- **Jidoka + andon — automatic line stop.** Detect the abnormal condition and
  stop immediately at a deterministic boundary, with the reason visible.
  → Maps to `blocked`/`conflict` transitions with audit evidence. Partially done
  via the circuit breaker; the general principle (stop, don't spin) is the
  single most useful frame for this codebase.
- **Poka-yoke — mistake-proofing.** Derive allowed transitions and preconditions
  from schema so impossible states are unrepresentable, and require
  machine-readable verification evidence rather than prose claims. (M, Phase 2/4)
- **WIP limits / theory of constraints.** Cap concurrent claims per scope and
  per role, pull only when downstream capacity exists, and surface the current
  bottleneck. (M, Phase 1/3.1a)
  → _Observed live_: the supervisor drives one task at a time, so a single
  blocked gate stalled five ready tasks for 25 minutes. Bottleneck visibility
  would have made that obvious immediately.
- **SPC — control charts.** Per model/role/project-type time series of
  envelope-rejection, verification-pass, rework, retry, lead time, conflict and
  rollback rates; detect out-of-limit points _and_ non-random runs; de-rate a
  degrading model automatically. (L, Phase 4/X.1)
  → `agent_runs` (added this session) is the data source this needs.
- **Golden paths.** Versioned per-project-type task-packet templates carrying
  acceptance criteria, mandatory test commands, review checklist and sandbox
  profile. (M, Phase 3.5/4)
  → _The CI-baseline problem this session is a golden-path problem_: the factory
  assumed the target repo had sane CI, and three separate stalls came from it
  not having one.
- **Progressive delivery + automated rollback**, and **chaos engineering** with
  steady-state hypotheses for worker crash, duplicate webhook, provider outage,
  stale event, malformed envelope. (L, Phase 4)
  → The 2026-07-31 Aether incident was an unplanned chaos experiment; Colony
  passed the "fail loudly" part and failed the "recover unattended" part.

## 4. Beads and agent-native work tracking

Sources: Beads <https://github.com/gastownhall/beads> (v1.1.2, 2026-07-26) ·
dependencies <https://github.com/gastownhall/beads/blob/main/docs/core-concepts/dependencies.md> ·
hash IDs <https://github.com/gastownhall/beads/blob/main/docs/core-concepts/hash-ids.md> ·
sync <https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md> ·
CLI reference <https://github.com/gastownhall/beads/blob/main/docs/CLI_REFERENCE.md> ·
git-bug <https://github.com/MichaelMure/git-bug> ·
OpenHands SDK <https://github.com/OpenHands/software-agent-sdk> ·
Devin <https://cognition.com/blog/introducing-devin>

Beads is a graph issue tracker built for agents: "replaces messy markdown plans
with a dependency-aware graph", four dependency kinds
(`blocks`, `parent-child`, `related`, `discovered-from`), `bd ready` for
unblocked work, atomic `--claim`, hash IDs for coordination-free creation, and
`bd admin compact` for semantic decay of closed issues.

Mapped to Colony:

1. **`discovered_from` edges (S).** `docs/design.md` §7 already lists
   `discovered_from` as a dependency kind, but
   `ProposedDecompositionDependencyInput.kind` in
   `packages/db/src/repository.ts` only accepts
   `blocks | parent_child | related`. An agent literally cannot record "I found
   new work while doing this task". Add the edge with origin task, evidence and
   confidence; non-blocking by default.
2. **Richer ready-work query (S/M).** `readyTasks` currently orders by
   `created_at` and gates only on `blocks`. Add priority/role filters, blocker
   explanation, deterministic tie-break, and an atomic `claim_next` to remove
   the TOCTOU between "list ready" and "claim".
3. **Gate nodes as first-class blockers (M).** Beads models CI/PR/human gates as
   graph edges. Colony has gates in separate tables, so `ready` can't explain
   "blocked by pipeline". Return typed blocker reasons instead of making agents
   guess.
4. **Lease semantics (M).** Colony's claims are durable-until-released. For
   multiple concurrent workers, add `lease_expires_at` + heartbeat + a fencing
   token (the existing `claim_version` works) required on envelope writes.
5. **Semantic compaction (M/L).** Beads compacts closed, unreferenced issues
   into summaries after ~30 days. Colony has `memory_records`/`candidates`
   designed but unused. Compact closed tasks into typed memory records, refusing
   to compact anything still referenced by an open task or gate.
6. **Keep Postgres authoritative.** Beads makes a local Dolt DB the source of
   truth and treats JSONL as a non-canonical mirror. Colony's Task Graph should
   stay authoritative; don't let a git-native export become a second source of
   truth.

## 5. Coding-agent implementation (SOTA vs Colony's Pi runner)

Sources: Claude Agent SDK <https://code.claude.com/docs/en/agent-sdk/overview> ·
agent loop <https://code.claude.com/docs/en/agent-sdk/agent-loop> ·
permissions <https://code.claude.com/docs/en/agent-sdk/permissions> ·
Codex security <https://learn.chatgpt.com/docs/agent-approvals-security> ·
OpenHands architecture <https://docs.openhands.dev/sdk/arch/overview> ·
condenser <https://docs.openhands.dev/sdk/arch/condenser> ·
mini-SWE-agent <https://github.com/SWE-agent/mini-swe-agent> ·
Aider edit formats <https://aider.chat/docs/more/edit-formats.html> ·
Aider lint/test <https://aider.chat/docs/usage/lint-test.html> ·
SWE-bench <https://www.swebench.com/SWE-bench/>

Colony does well: typed packet/envelope contracts, provider prose treated as
untrusted, role separation, per-run working directories, intended gVisor/egress
policy. Gaps, highest first:

1. **Truthful terminal states.** The Claude SDK returns explicit
   `error_max_turns` / `error_max_budget_usd`. Colony used to synthesise a
   `done` envelope after abort. → _Fixed this session._
2. **Repo integrity.** A repo-required run must fail, not silently degrade to an
   empty scratch dir. → _Fixed this session_, which promptly exposed that the
   planner had **never** been getting credentials.
3. **Fail-closed tool authorisation.** Claude's permission chain and Codex's
   approval policy are ordered and default-deny; Colony's broker returned
   `{allow: true}`. → _Fixed this session_ (packet-capability enforcement).
4. **Prepared environment is dead data.** `tool-materialization.ts` computes
   `pathEntries`/env and the runner never applies them; `sandboxCwd` is unused.
   Declared tool profiles are metadata only. **Still open.**
5. **Compaction disabled.** `SettingsManager.inMemory` sets
   `compaction: {enabled: false}` while turn limits run to 250. Both Anthropic
   (automatic compaction) and OpenHands (Condenser, default max_size 120) treat
   this as essential. **Still open.**
6. **No hard verification gate.** Aider auto-runs tests and feeds failures back;
   SWE-bench only counts patches that apply and pass. Colony asks the agent to
   run tests in the prompt but never verifies before accepting the envelope.
   **Still open** — and it's the highest-value remaining item.
7. **Workspace boundary is prompt-enforced**, not OS-enforced. Codex and Claude
   both rely on an OS sandbox with network off by default.
8. **No model-specific edit format** (Aider documents whole/diff/udiff and
   per-model choices); no durable transcript/resume; no in-run subagents.

## 6. Codebase audit findings

A six-agent read-only audit ran at the start of the session. Most high-severity
findings were fixed (see `docs/handoff-2026-07-31.md`). Notable **unfixed** ones:

- `apps/api/src/app.ts` — `X-Actor-Id` is trusted with no authentication.
- `packages/policy/src/evaluate.ts` — resolves the effective policy then ignores
  `always_human_review`, `review_loop_cap`, `protected_paths`, `security_labels`.
- `apps/tool-gateway/src/server.ts` — `buildApp()` with no deps, so the service
  starts but can never do its job.
- `packages/domain/src/state-machines.ts` — recovery transitions allow
  `blocked → merged` and similar, bypassing gates; transition owner/precondition
  metadata is computed and then discarded by the repository.
- Freshness fields are hardcoded (`provider_event_ts: new Date(0)`,
  `policy_version: "policy:1"`), weakening stale-envelope detection.
- Per-run workspaces under `${tmpdir}/colony-pi-runs/` are never cleaned up.
- GitLab bootstrap ignores `rotate_tokens` and always mints 24h PATs — which is
  why every bot token in bao was expired at the start of this session.

## 7. Suggested priority order

1. Verification gate before envelope acceptance (§5.6) — run the tests, don't
   ask the agent whether it did.
2. Evidence freshness and head-of-branch correctness (§2, and the open bug in
   the handoff) — gates must compare against provider truth.
3. Authentication on the API (§6) — everything else is moot if actors are
   spoofable.
4. Apply the prepared sandbox environment for real (§5.4, §5.7).
5. Context compaction (§5.5) before raising turn limits any further.
6. WIP limits and bottleneck visibility (§3) — cheap, and immediately explains
   stalls.
7. SPC over `agent_runs` (§3) — the data now exists.
8. `discovered_from` edges and ready-work explanations (§4.1, §4.2).
9. Online evaluators and N-version review for risky diffs (§2, §1).
