# Lessons for Colony — Steve Yegge's beads and Gas Town (2025-10 → 2026-10)

Research compiled 2026-10-21. Sources are Yegge's own essays (read in full from the yegge.ai archive, which mirrors the Medium originals), the beads and Gas Town repositories pinned at a commit, the published beads docs site, and first-hand practitioner write-ups. Dates are the articles' own publication metadata. Quotes are verbatim; ellipses are marked. Where Yegge's later posts contradict earlier ones I keep both and date them. Gas Town's repo mixes shipped behavior with design specs, so each mechanism below carries a status. Self-reported operational numbers are labeled as such; estimates that only exist inside a design doc are marked **[UNVERIFIED]**.

Colony problem references: **(1)** 46% of 1,174 implement runs died to non-model causes (colonyd restarts/deploys 129, sandbox provisioning 117, rate limits 75, unclassified 106, watchdog 31); **(2)** big-task churn (11–13 implement runs, 3–6 review rounds, cold repairs) versus 1–4 runs on small tasks; **(3)** the no-deviation rule turned impossible requirements into human blocks (since changed to deviate/rebut with evidence); **(4)** hand-built reliability mechanisms collide and fail silently (20-min watchdog killed 23-min test runs; spec steering failed 9/9 for three weeks; scopes parked with runnable work); **(5)** the agent sandbox differs from CI.

Design decisions under consideration: run all agents on **daimyo** (journaled tasks, sessions, Claude Code/omp harness agents, outcome graders, workflows); one writer owns each leaf through review/CI; small leaves; planners that can add leaves at runtime.

---

## 1. Lessons for Colony

1. **Delete the plan document: the plan must be a queryable work graph, because a fixed document is re-derived by every cold agent instead of being read.** Yegge spent "a year of hard time with agentic workflows using plans and TODO lists" and ended up with "six hundred and five markdown plan files in varying stages of decay" (_The Beads Revolution_, 2025-10-15; _Introducing Beads_, 2025-10-13); his postmortem lists the defects: markdown plans "are text, not structured data", "not queryable", and "agents rarely update the plans as they work, so the plans bit-rot very fast" (_The Beads Revolution_, 2025-10-15); the replacement is `bd ready`, which the docs define as open issues with no active blockers, excluding "in*progress, blocked, deferred, and hooked" work — "truly claimable work" (beads `bd ready` reference, pinned 2026-10-21). "\_Your markdown plans form a work graph, but they aren't linked together in a queryable, reified form*" (_The Beads Revolution_, 2025-10-15). Bears on **(2)** and on Colony's up-front 20-task plan: a plan the architect writes once and no runtime queries is still a markdown plan, even if it is stored as JSON.

2. **One leaf should equal one fresh session; decompose until every leaf fits inside the model's reliable attention budget, not its advertised context window.** Yegge measured that "even with a 1M context window, coding agents can only get a usable 10–15% out of that" and that "working at full speed, this means you get 5–10 minutes of work before they poop out and need a restart (which is like death) or compaction (which is a mind wipe)" (_Beads for Blobfish_, 2025-10-19). His operating rule became "Agents should tackle one task at a time. Once it's done, kill the process and start a new agent. Beads acts as the working memory between sessions" (_Beads Best Practices_, 2025-11-24). Gas Town's polecat design encodes it: "Polecats do NOT complete complex molecules end-to-end. Instead, each molecule step gets one polecat session" (`docs/design/polecat-lifecycle-patrol.md`, pinned 2026-10-21). The MAKER result Yegge cites (1M+ LLM steps, zero errors) rests on "an extreme decomposition of a task into subtasks, each of which can be tackled by focused microagents" plus per-step voting (Meyerson et al., arXiv 2511.09030, 2025-11-12). Bears on **(2)**: an 11–13-run task is not a scheduling failure; it is evidence the leaf is several leaves with a cold start between each.

3. **Make state external, durable, and claimable before making the agent smarter: the session is disposable, the identity and sandbox are not.** Gas Town's lifecycle doc calls the early conflation of concepts the root problem and separates three layers: "Polecat _identity_ is permanent; sessions are ephemeral, sandboxes are persistent" (`docs/concepts/polecat-lifecycle.md`). Work is a bead on a git-backed hook, so "it doesn't matter if Claude Code crashes, or runs out of context. As soon as another session starts up for this agent role, it will start working on that step in the molecule immediately" (_Welcome to Gas Town_, 2026-01-01). Claims are atomic (`bd update <id> --claim` sets assignee and in_progress together; `bd ready --claim --json` claims the first match), and closing a bead is idempotent. Bears on **(1)** and on daimyo's journal: Colony's adoption/autosave/steering machinery is trying to preserve a session; the cheaper invariant is that a new session can always reconstruct its position from the ledger plus the sandbox.

4. **Propulsion must be re-asserted by the runtime at session start and backed by an external nudge; never rely on the agent remembering that it has work.** Gas Town's GUPP states: "If there is work on your hook, YOU MUST RUN IT" (_Welcome to Gas Town_, 2026-01-01), and the hook is "persistent, also a Bead backed by Git". But Yegge immediately documents the failure: "We tell the agent, YOU MUST RUN YOUR HOOK, and it sometimes doesn't do anything at all. It just sits there waiting for user input." The fix is a nudge "roughly 30 to 60 seconds after it starts up" and "within 5 minutes or so" (ibid.); mechanically, Claude Code hooks run `gt prime --hook` on `SessionStart` and `PreCompact`, and `gt mail check --inject` on `UserPromptSubmit` (`docs/HOOKS.md`, pinned 2026-10-21). Bears on **(4)**: Colony's spec steering that "failed 9/9 for 3 weeks unnoticed" is the same class of failure — a prompt instruction with no runtime event and no observability. Propulsion work must be a state transition the supervisor can see, not a sentence in a system prompt.

5. **Detect "stuck" from multiple evidence stores and have an AI adjudicate; a single wall-clock timeout is a murder weapon, and false positives are worse than slow detection.** Gas Town keeps three heartbeat stores and its own documentation warns: "never declare an agent stuck from a single store", because "a live session with a stale store is _heartbeat-write divergence_, not a stuck agent" (`docs/concepts/heartbeats.md`). The patrol design uses deliberately generous thresholds — 30 minutes with a hooked bead and no progress, 30 minutes of no tmux output, 60 seconds stuck-in-done — and states: "False positives (the 'Deacon murder spree' bug) are worse than slow detection… Only the witness (an AI agent) should make judgment calls about whether a polecat is truly stuck" (`docs/design/polecat-lifecycle-patrol.md`). The original incident is Yegge's: "The Deacon did it. It was cleaning up 'stale' workers that weren't stale and murdering entire crews mid-task" (_Gas Town Emergency User Manual_, 2026-01-13). Bears on **(4)** directly: Colony's 20-minute watchdog killing 23-minute test runs is the same bug with a different name.

6. **Optimize for liveness, not for zero duplicate work; make every step idempotent so re-execution is always safe.** Gas Town's design doc is explicit: "The system prioritizes **liveness** (work eventually completes) over strict safety (no duplicate work)", with "duplicate detection is best-effort", "idempotent operations are preferred", and crash recovery that "may re-execute partial work" (`docs/design/polecat-lifecycle-patrol.md`). Git serializes the writers, so two sessions on one step fail one push rather than corrupting the branch. Bears on **(4)** (scopes parked with runnable work) and **(1)** (restart casualties): parking is a safety-first choice that trades a small risk of duplicate work for a large risk of no work. Gas Town chose the opposite and paid for it with duplicate sessions, not with lost work.

7. **Separate the worker, the observer, and the lander; the observer must not gate, and exactly one role owns the merge queue.** Gas Town's architecture doc: "Polecats manage their own lifecycle end-to-end. The Witness observes but does NOT gate completion. This prevents the Witness from becoming a bottleneck." The Refinery owns the queue: it rebases, runs gates, and if "rebase fails, Refinery creates a conflict-resolution task" (`docs/concepts/polecat-lifecycle.md`); "No work can be lost, though it is allowed to escalate" (_Welcome to Gas Town_, 2026-01-01). Bears on **(2)** and on the "one writer owns each leaf through review/CI" decision: the writer should own the branch through CI, but landing should belong to a single queue owner. If the adversarial reviewer also owns the queue, every review delay becomes a merge delay — which is what Colony's 3–6 review rounds already look like.

8. **Verify at the boundary against external truth (PR merged, CI green), not against the agent's claim that a leaf is done; encode that boundary as a gate the scheduler understands.** Beads gates exist because "closing a beads issue means 'work is done' but the code may still be on a feature branch, waiting for PR review" (beads `dependencies.md`, pinned 2026-10-21). Gate types are `gh:pr`, `gh:run`, `timer`, `bead`, and `human`, and `bd gate check --escalate` re-escalates failed gates. Gas Town's Refinery runs the quality gates on the batch tip before landing (`docs/design/architecture.md`). Bears on **(5)** and **(3)**: the sandbox may legitimately close a leaf before CI has spoken, but the _next_ leaf must depend on the PR/CI gate, not on the leaf's status. This is also the guardrail for "deviate/rebut with evidence": a rebuttal can close a leaf, but it cannot satisfy the merge gate.

9. **Batch the merge queue; and when commit rate outruns gate capacity, stop bisecting and fix forward with a swarm.** Gas Town's design describes a Bors-style batch-then-bisect queue: rebase a batch as a stack, test the tip, fast-forward on pass, binary-bisect on fail (`docs/design/architecture.md`; at the pinned commit the batching phase is still marked "Blocked by Phase 1", so this is partly design). Yegge later hit the arithmetic limit in Wheelhouse: 175 "real" commits/day (up to 250) against a 30-minute build gate, a 100+ MR queue, and "bisection loops [where] nothing would make forward progress". His replacement, the **Land Rush**, "whenever the MQ hits 100… abandon the bisection and just smash it all in with a megabatch. And then we do swarm diagnosis (_not_ bisection) to fix it", clearing batches of "120 to 150 commits" (_The Shape of Things to Come_, 2026-08). He supports it with the pigeonhole argument: "in the limit, the only real choice I see is to land the whole flock at once, and then sort out the squawking." Bears on **(2)** and **(5)**: Colony serializes merges and re-runs CI per MR. Start with batching plus integration branches; treat the Land Rush as a dated experiment (one week of use at the time of writing), not settled doctrine.

10. **Memory decays by design: prune the working set aggressively, keep the full history, and re-inject only durable facts at session start.** Yegge runs `bd cleanup` every few days: "Whenever I get more than about 200 issues I start thinking about cleaning up, and I rarely let it go beyond 500", deleting closed issues older than two days, because "the issues are always in git history" (_Beads Best Practices_, 2025-11-24). Beads also has commit compaction (`bd compact`) and history flattening (`bd flatten`), and _wisps_ — ephemeral beads that are "burned (destroyed)" at the end of a run, optionally squashed to a one-line digest (_Welcome to Gas Town_, 2026-01-01; beads `wisps.md`). Re-injection is explicit: `bd prime` exists "to prevent agents from forgetting bd workflow after context compaction" and emits ~50 tokens in MCP mode versus ~1–2k in CLI mode; `bd remember` stores facts that are "injected at prime time… so you have them in every session" (beads `prime.md`, `remember.md`). Wheelhouse later formalizes the split: `brain/` for strategy (pulled on demand), `doc/` for system docs (pulled by owner), beads for work and spec detail (loaded only by the claimant), `bd remember` for one-paragraph gotchas (pushed into every session), and private skills (auto-loaded on match) (_The Shape of Things to Come_, 2026-08). Bears on **(2)** and **(4)**: cold repairs are cold because the leaf's spec and the project's durable facts are not in the fresh context; the fix is a small, deliberate injection, not a longer session.

11. **Put the project's axioms into priming, and re-audit every harness mechanism each model generation, because agents propagate wrong architectural beliefs and a harness tuned to one model can be destroyed by the next.** Yegge's failure taxonomy includes "heresies: compelling but wrong beliefs about the architecture that spread invisibly… often multiple times", and his remedy is "capture your guiding principles in the agent priming (onboarding)"; his example is the persistent belief in "idle polecats" when "there is no such thing as an idle polecat; it's not a pool" (_Gas Town Emergency User Manual_, 2026-01-13). Later: "Gas Town fell apart at the seams with Opus 4.7… the introduction of the 'just two more things' tic, which prevented Opus from ever converging… Gas Town effectively burned down" (_The Shape of Things to Come_, 2026-08). Bears on **(3)** and **(4)**: Colony's switch to "deviate/rebut with evidence" is an axiom change and belongs in every agent's prime, not in a document some agents never read; and the 20-minute watchdog, attempt budgets, and review epochs are model-behavior assumptions that expire.

12. **Scale and cost are governed by concurrency and by the human's read-and-validate rate; keep the fleet machine-sized, and collapse the human's surface to one conversation.** Yegge: "I try to keep it under 30 workers right now… typically I'll only have a dozen or so active"; "a town is about machine-sized. Gas Town scales by having lots of towns, much like Git scales by having lots of repos, which really just pushes the scaling problem onto the user" (_Welcome to Gas Town_, 2026-01-01; _The Future of Coding Agents_, 2026-01-05). In Wheelhouse: "adding more fleet overwhelms both my laptop and my own ability to track their progress", and "in the limit, I am the bottleneck" (_The Shape of Things to Come_, 2026-08). A six-week practitioner reports that "you can burn through half of a Pro Max account (or several) in six to eight hours running hot" and that "the limiting factor is how fast you can think, give direction, and validate" (Eric Koziol, 2026-02-15). The Mayor exists to make N workers feel like one correspondent — "the Mayor giving you less stuff to read" (_Gas Town: from Clown Show to v1.0_, 2026-04-03). Bears on the daimyo/model-mix decisions: Colony's hard project needed ~4–6 operator actions per merge; that is the number to reduce. It also argues for the strong model on the two judgment points that cascade — design and review — with cheap models executing, which is what Wheelhouse converged on: "Fable design, Opus implementation, Fable review."

### 1.1 What this implies for the rebuild (inference, not source claims)

**[INFERENCE]** The sources do not describe daimyo; these are my mappings from the evidence above, to be tested rather than adopted wholesale.

| Lesson   | Concrete implication for Colony/daimyo                                                                                                                                                                   | Why this is the first move                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2, 10 | Replace the 20-task fixed plan with a graph query (`ready`) plus spec beads; split any leaf that cannot finish inside one context; let discoveries be filed as new leaves with a `discovered-from` edge. | It attacks both churn (2) and cold repairs at once, and it is a data-model change, not another daemon.                           |
| 3, 4     | Make the journal the only work state; on session start, inject a small prime (role axioms, leaf spec, durable memories) and assert the hook.                                                             | It removes the need for adoption/autosave/steering to reconstruct sessions, which is where Colony's silent failures cluster (4). |
| 5, 6     | Replace timer-kill with multi-signal stall detection plus an adjudicator; separate "nudge" from "kill"; accept duplicate work and make steps idempotent.                                                 | Directly addresses the watchdog and parked-scope failures without loosening safety on merges.                                    |
| 7, 8     | One writer per leaf through CI; one queue owner for landing; downstream leaves gate on `gh:pr`/`gh:run`, not on leaf status.                                                                             | Preserves Colony's factory policy (review + merge gate) while removing reviewer-as-queue and false completion.                   |
| 9        | Batch merges and use integration branches for epics; only experiment with Land Rush after the queue is measurable.                                                                                       | Merge throughput is the next bottleneck once leaves are small; batching is the low-risk half.                                    |
| 11, 12   | Put axioms in prime; re-audit watchdogs/attempt budgets per model; put the strong model on plan and review; measure operator actions per merge.                                                          | These are the cheap changes that make the other changes observable instead of silent.                                            |

---

## 2. Per-source findings

### 2.1 "Introducing Beads: A coding agent memory system" — Steve Yegge, 2025-10-13

**Architecture.** A git-backed issue tracker with dependency links, queried by agents (`bd ready`), written by agents (`bd create`, `bd close`). Beads is not a database server: it is "external memory for agents, with dependency tracking and query capabilities". Yegge reports 350k lines of Go written in forty days of vibe coding, and claims "95 to 99% of the interactions we have with coding agents could have been handled by a properly briefed model" — i.e., the bottleneck is briefing, not capability.

**The markdown failure, in his words.** The original design mistake was "embracing markdown plans". His follow-up postmortem lists three defects: plans "are text, not structured data" and must be parsed, which "places a high cognitive load on the model"; "they're not queryable", so building a work queue is hard; and "agents rarely update the plans as they work, so the plans bit-rot very fast" (_The Beads Revolution_, 2025-10-15). His cascade anecdote is the cleanest statement of Colony's cold-repair problem: a task becomes six phases, then each phase becomes five, then the agent arrives at "phase 3 (out of 5) of phase 3 (out of 6)", "gone full-blown bugshit amnesiac", and creates "a dozen 6-phase plans a day" until there are "literally hundreds of new markdown files".

**Work disavowal.** Near the compaction limit, agents "start to panic and make executive decisions about getting your task 'done' at all costs. And that means… shortcuts!" This is the behavioral reason to externalize acceptance: the agent's self-report is least trustworthy exactly when it is trying to finish. His countermeasure is fine-grained work: "if you split issues up into fine-grained tasks, then each session will be quadratically cheaper, and your agents will make better decisions overall because they're generally at the beginning of their context windows".

**Adoption evidence.** "My agents have switched — without a hint of ever going back — from using markdown plans, to using the issue tracker exclusively." The essay ends with a Claude-authored assessment: markdown TODOs are "write-only memory for agents"; Beads' dependency types and ready-work detection "aren't features bolted onto a human tool. They're primitives for agent cognition."

**Coordination (Claude's assessment, quoted by Yegge).** Two agents "query the same logical database (via git), see what's claimed (`status: in_progress`), and work on different ready issues"; updates are logged "with a timestamp and actor". This is the minimum viable multi-agent protocol Yegge publishes with the essay: shared ledger, explicit claim state, append-only history.

**What it does not solve.** Beads is opt-in: "Beads is opt-in infrastructure, not automatic enforcement" (Ian Bull, 2026-01, glossing Yegge). Agents still forget to use it when context rots.

---

### 2.2 "The Beads Revolution: How I Built The TODO System That AI Agents Actually Want to Use" — Steve Yegge, 2025-10-15

**Build numbers.** Idea on Wednesday to 1,000 GitHub stars and ~50 forks six days later; ~15k lines of code; a dozen-ish community PRs merged in the first days, including race-condition fixes and an MCP server.

**Why markdown lost.** His summary: "pushing too hard on planning gives them amnesia, litters your disk with half-finished plans, and it all ends in tears." The graph exists on disk either way, but in markdown it is not "linked together in a queryable, reified form"; the AI must "reconstruct your work graph from disk, parsing potentially dozens of markdown files, every single time it tries to do a query (e.g., 'what should I work on next?')".

**Dependencies and forensics.** Beads epics can nest arbitrarily; issues have "four different kinds of dependency links, including provenance", which gives agents "unprecedented sleuthing and forensics powers when they are trying to figure out how a train-wreck happened with multiple workers". This is the `discovered-from` / `caused-by` family in today's docs, and it is how a work graph accumulates _why_ rather than only _what_.

**Self-healing, honestly framed.** A session starts with 72 issues when ~180 are expected, ends at 405 with "11,286 updated", and is recovered to 193 by deleting and re-importing the database. Because the ledger is in git, "you never actually lose anything", and "Beads comes with excellent tools for collision resolution". The lesson is not that corruption is fine; it is that a ledger with a cheap full rebuild is more robust than a bespoke in-memory state machine.

---

### 2.3 "Beads for Blobfish" — Steve Yegge, 2025-10-19

**The context budget, quantified.** "Even with a 1M context window, coding agents can only get a usable 10–15% out of that before their cost and performance both go the wrong direction. Most agents cut you off hard at around 20%, and it's best to stay below 15% before restarting your session." At full speed: "5–10 minutes of work before they poop out and need a restart (which is like death) or compaction (which is a mind wipe)." Yegge reports running "around 50+ sessions a day".

**Why markdown proliferates.** Agents are "TERRIBLE at managing Markdown plans": they create one "at the drop of a hat named something vague like `phase-6-design-review.md`" and bury them in paths that "quietly accumulate fifteen thousand .md files". The diagnosis is not laziness but the absence of a canonical place where a plan can be both written and queried.

**Implication for Colony.** Session length is a budget measured in usable tokens, not wall-clock time. A three-hour sandbox limit says nothing about whether a leaf is the right size; the reliable measure is whether the leaf can be completed before the model's usable context degrades.

---

### 2.4 "Beads Blows Up" — Steve Yegge, 2025-11-06

**Architecture at that date.** Git + JSONL (one issue per line) + SQLite "acting as a fast queryable cache layer, which hydrates on demand from the JSONL", with hooks and a daemon doing "intelligent multidirectional syncing". "It's just Git with some hooks and auto-syncing logic" — and that core design "makes up for a lot of Beads implementation deficiencies", because agents can query it and repair it.

**Failure modes.** The synchronization design produced "issues getting resurrected after deletion, or even issues getting deleted or overwritten". Yegge says he fixed "half a dozen major, heart-attack, show-stopper, oh-god-are-users-seeing-this type bugs every single day for the past 3 weeks". The escape hatch is always git history plus agent-driven repair.

**Maintenance load.** Yegge says he can "barely stay on top of it even with three full-time agents allocated" and credits a "growing team of contributors". This is the earliest evidence that an agent-facing ledger is itself a product with an operational tax, not a one-off tool.

---

### 2.5 "Beads Best Practices" — Steve Yegge, 2025-11-24

**Doctrine.** "Beads is an execution tool, not a planner — agents on rails." The operating rules that matter for Colony:

| Rule                       | Verbatim guidance                                                                                                                                                                                                | Mechanism                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| File work continuously     | "file beads to track any work that will take it longer than about 2 minutes to finish"                                                                                                                           | `bd create`, `discovered-from` |
| One task per session       | "Agents should tackle one task at a time. Once it's done, kill the process and start a new agent. Beads acts as the working memory between sessions."                                                            | handoff / kill                 |
| Keep the working set small | "Whenever I get more than about 200 issues I start thinking about cleaning up, and I rarely let it go beyond 500"; `bd cleanup` older than 2 days.                                                               | `bd cleanup`, git history      |
| Plan outside, then import  | Use a separate planning tool, then have the agent file epics/issues "focusing carefully on dependencies, detailed designs, and potential parallelization"; iterate the plan and the epics up to five times each. | planning pass, `bd create`     |
| Daily hygiene              | `bd doctor` every day; `bd upgrade` every week or two; expect merge conflicts and "ask the agent to clean up Beads messes".                                                                                      | `bd doctor --fix`              |

**Why the size limit is concrete.** Agents often read `issues.jsonl` directly with jQuery; that "fails if your file is larger than 25k tokens, the current limit for reading whole files, which is maybe 500-ish Beads issues". The pruning threshold is therefore a tooling constraint, not an aesthetic one.

**What it says about planning quality.** A one-shot plan is explicitly not the recommendation: the plan is revised up to five times, then the bead graph is revised up to five times, "before it will say, 'I don't think we can do much better than this.'" Colony's architect emits up to 20 tasks once; this source argues for an iterative plan-review loop before any implement run, and for a graph that can be re-planned.

---

### 2.6 "Welcome to Gas Town" — Steve Yegge, 2026-01-01

**The pitch.** "A 2026 IDE replacement for orchestrating 20–30 Claude Code instances at once. Roughly: Kubernetes and Temporal had an ugly baby." Gas Town is a workspace manager over a Beads ledger, with roles, mail, hooks, molecules, and a merge queue.

**Roles and why each exists.** The launch essay calls them "seven well-defined worker roles" plus the human Overseer, and singles out Boot as "a special Dog"; the repo architecture tabulates Boot as a town-level agent alongside the Deacon. The role set is best read as a list of failure modes that each role prevents.

| Role                 | Scope | Lifecycle                                                      | Why it exists (failure it prevents)                                                                                                                       | Source                 |
| -------------------- | ----- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Overseer** (human) | Town  | Permanent                                                      | Reads results and sets direction; has an identity and inbox, so escalations have a destination.                                                           | WTG 2026-01-01         |
| **Mayor**            | Town  | Persistent                                                     | One conversational surface over many workers; files and slings work, receives convoy completions; "the Mayor giving you less stuff to read" (v1.0 essay). | WTG; v1.0              |
| **Polecat**          | Rig   | Identity persistent, session ephemeral, sandbox per assignment | Executes one bead/step, submits an MR, retires; "ephemeral per-rig workers that spin up on demand".                                                       | WTG; polecat-lifecycle |
| **Refinery**         | Rig   | Persistent                                                     | Serializes merges; rebases, runs gates, creates conflict-resolution tasks; "No work can be lost, though it is allowed to escalate."                       | WTG; architecture      |
| **Witness**          | Rig   | Persistent                                                     | Detects and nudges stalled polecats, cleans up zombies, respawns crashes; "observes but does NOT gate completion".                                        | WTG; polecat-lifecycle |
| **Deacon**           | Town  | Persistent                                                     | Runs a patrol loop on a daemon heartbeat ("Do Your Job"), propagates it downward, runs town plugins, first escalation tier.                               | WTG; escalation        |
| **Boot**             | Town  | Ephemeral (every 5 min)                                        | Checks on the Deacon instead of the daemon interrupting it; decides heartbeat/nudge/restart/leave alone.                                                  | WTG                    |
| **Dogs**             | Town  | Variable                                                       | Maintenance and handyman work (stale branches, plugins) so the Deacon is not "bogged down and stuck on one of its steps".                                 | WTG                    |
| **Crew**             | Rig   | Persistent identity                                            | Long-lived named agents for design, review, PR shepherding; the human's direct reports.                                                                   | WTG; Emergency Manual  |

**The propulsion principle.** GUPP: "If there is work on your hook, YOU MUST RUN IT." The hook is a pinned bead per agent; slinging work puts it there. GUPP is supposed to make handoffs automatic, but "in practice, Claude Code often waits until you type something… before it checks its mail and hook" — hence the nudge (30–60 s, ≤5 min). This is the single most important operational detail in the essay: the architecture assumes the agent will not self-start, and compensates mechanically.

**Molecules and formulas.** A molecule is a chain of beads representing a workflow; a formula is a TOML source form cooked into a protomolecule and poured into a molecule. The motivating story is a 20-step release process: agents "would always skip steps", and long wait states (CI, deploys) made nagging necessary. "Make 20 beads for the release steps, chain them together in the right order, and make the agent walk the chain, one issue at a time." The payoff: "If the workflow is captured as a molecule, then it survives agent crashes, compactions, restarts, and interruptions. Just start the agent up in the same sandbox, have it find its place in the molecule, and pick up where it left off." For Colony, molecules are the shipped version of "procedural reliability without a long prompt": one step per issue, ordered by dependencies, resumable from the ledger.

**Wisps.** Ephemeral beads for operational work: "They are not written to the JSONL file, and thus not persisted to Git. At the end of their run, Wisps are 'burned' (destroyed). Optionally they can be squashed into a single-line summary/digest." This is the cleanest memory-decay mechanism in the system: operational noise does not accumulate in the ledger.

**Merge queue.** "As soon as you start swarming workers, you run into the Merge Queue (MQ) problem. Your workers get into a monkey knife fight over rebasing/merging and it can get ugly. The baseline can change so much during a swarm that the final workers getting merged are trying to merge against an unrecognizable new head." The Refinery is "the engineer agent responsible for intelligently merging all changes, one at a time, to main." Note the tension with the batching design in the repo: the essay describes one-at-a-time, the architecture doc describes batching. Both are real at different dates.

**Scale, cost, and what was missing.** "I try to keep it under 30 workers right now because I haven't implemented remote workers on hyperscalers yet… typically I'll only have a dozen or so active." Cost: "Gas Town is also expensive as hell… I had to get my second Claude Code account… I will need a third Claude Code account by the end of next week. It is a cash guzzler." No dollar figure is given. Launch numbers: "17 days, 75k lines of code, 2000 commits." Deferred: federation, GUI, plugin functionality on molecule steps, the Mol Mall, and the million-step wisp ("I wanted to run the million-step wisp but ran out of time"). He did run a 10-disc Tower of Hanoi "in a few minutes" as a thousand-step proof, and estimated the 20-disc wisp "would take about 30 hours".

**Kubernetes analogy, and its limit.** "Kubernetes asks, 'Is it running?' while Gas Town asks 'Is it done?'… K8s pods are anonymous cattle; Gas Town polecats are credited workers whose completions accumulate into CV chains, and the sessions are cattle." This is the design slogan Colony should keep: durable identities, disposable sessions, completion-oriented scheduling.

---

### 2.7 "The Future of Coding Agents" — Steve Yegge, 2026-01-05

**Colonies, not super-ants.** "Everyone seems to think that the future of coding agents is… coding agents… when work needs to be done, nature prefers colonies. Nature builds ant colonies… while Claude Code is 'the world's biggest fuckin' ant.'" His prediction: agent vendors will compete on "how well they support being factory workers", with an "Orchestrator API Surface" of hooks. Gas Town at launch had "a crummy, duct-taped API atop [agents] that offer barely any platform hooks".

**Decomposition is mandatory.** His earlier orchestrator used Temporal, the "gold standard" for durable workflows, but it "proved cumbersome for my needs": "the workflows I was orchestrating turned out to be micro-workflows, since you have to severely decompose tasks for LLMs to reliably follow them." He still expects Temporal to be "a key piece of the puzzle" at enterprise scale, which is the nuanced version — the workflow engine must support micro-workflows; durability itself is not the problem. This is a direct warning for Colony's daimyo/workflow layer: the unit of orchestration is a small step, not a 3-hour task.

**Scaling limit.** "Gas Town isn't super vertically scalable in its K8s-shaped form. A town is about machine-sized. Gas Town scales by having lots of towns, much like Git scales by having lots of repos, which really just pushes the scaling problem onto the user." The Wasteland (below) is his answer: federate towns rather than grow one.

**Cost anecdote (not his own bill).** Two practitioners with "unlimited tokens"; "Ryan's burning $60k/year or thereabouts, but is quickly pushing up into dev-salary territory." Gas Town + Beads were "pushing half a million lines of code, including contributor contributions."

**Language/implementation aside.** TypeScript wasted "a third to half" of diffs on type gymnastics; Go produced a single binary and fewer cleanup steps; Python was "fine" but felt like scripts. Not central to Colony, but relevant to harness maintenance cost.

---

### 2.8 "Gas Town Emergency User Manual" — Steve Yegge, 2026-01-13

**Failure modes, named.** "The Gas Town Serial Killer Murder Mystery… Spoiler: The Deacon did it. It was cleaning up 'stale' workers that weren't stale and murdering entire crews mid-task." Also "workers stalling out, getting lost, orphaned, confused about who they are", and "heresies: compelling but wrong beliefs about the architecture that spread invisibly." The manual is written as a survival guide, not a victory lap: "You shouldn't be using it now, unless you're either experimenting or you're contributing."

**Human operating doctrine.** The human role is explicitly _not_ watching agents work: "Don't watch your agents work… When you see that an agent is finished working, stop everything… read what it has to say… at some point you have to act on each agent's response or risk losing work. Spend your time reading agent responses and giving them direction — not watching them work." Handoff after every task, except when a session must accumulate context for a big design decision. "It's OK not to swarm all the time" — serial bottlenecks are normal. "You can use Polecats without the Refinery" — the roles are separable, which is the "degrades gracefully" property.

**Crew as the planning layer.** Polecats are "best for well-defined, well-specified work… They shouldn't have to make decisions." Crew are for "thought-intensive work, including design work, reviewing contributor PRs, creating implementation plans, and sometimes doing specific code reviews"; Yegge runs 7–8 crew per rig, and they "create guzzoline for the swarms". This is the production/consumption split Colony's architect lacks: a persistent design group that feeds a disposable execution fleet.

**A standing-order role.** The "PR Sheriff": a crew member with a permanent hook ("PR Sheriff Standing Orders") that, on every session start, checks open PRs, splits easy wins from human review, and slings the easy wins to other crew. "Every time I boot up my Beads crew, they automatically go merge another 5 or so PRs, and flag a couple more for me to review." This is a cheap, durable mechanism for reducing operator load — a template Colony could copy for merge-queue triage.

**Verification without reading code.** "Tending the Invisible Garden": "regular code review sweeps, followed by bug-fix sweeps that fix the issues filed during the code-review sweeps." You do this every day "and hope that most of the time you don't find anything bad." The garden metaphor also explains heresies: "Your garden can get diseases… If that wrong guess makes it into the code, sneaking through the review process, then it becomes enshrined and other agents may notice it and propagate the heresy in their own work." The remedy is priming axioms, not more review.

**Published numbers.** Twelve days in: "I've merged over 100 PRs from nearly 50 contributors, adding 44k lines of code that no human has looked at. This has grown Gas Town's total size to 189k lines of Go code since its first commit on Dec 15th, which is now 2684 commits ago… I carefully reviewed and merged 25 PRs today alone on Gas Town, and another 17 on Beads." This is the strongest available data point that human line-by-line review is not the binding constraint Yegge optimized for — and a warning about what "reviewed" means in an agent factory.

---

### 2.9 "Welcome to the Wasteland: A Thousand Gas Towns" — Steve Yegge, 2026-03-04

**Architecture.** A federation layer over Gas Towns: a shared Wanted Board of work; three actor kinds — rigs, posters, validators; item lifecycle `open → claimed → in review → completed`; validators issue multi-dimensional **stamps** (quality, reliability, creativity, each independently scored, with confidence and severity), anchored to the specific completion; a "yearbook rule" (you cannot stamp your own work); trust levels (registered → contributor → maintainer) gate who may validate; each wasteland is a sovereign database with the same schema, and rig identity/reputation is portable.

**Coordination/merge strategy.** "The Wasteland has opted into the classic Git pull-request based workflow, for literally all work." The reasons are conservative and relevant: the PR workflow is "already battle-tested"; Dolt is Git+SQL; "the models already know Git better than almost any other tool." Claiming an item marks it as yours, "preventing duplicate effort"; open-bounty work allows parallel attempts and closes on the first accepted solution.

**Numbers.** "Gas Town and Beads have had a combined 2400 submitted pull requests, with 1500 PRs merged from over 450 unique contributors" in roughly two months; 13k stars for Gas Town at three months; Beads crossed 20k stars in about five months (_Gas Town: from Clown Show to v1.0_, 2026-04-03).

**Relevance to Colony.** This is a review-economics design, not an execution design: it shows how to make verification cheap and portable when many independent producers submit work. Colony does not need a reputation ledger, but the "claim prevents duplicate effort" and "stamp is anchored to evidence" ideas map onto review epochs and merge-gate evidence.

---

### 2.10 "Gas Town: from Clown Show to v1.0" — Steve Yegge, 2026-04-03

**The postmortem, compressed.** "Three months from launch to v1.0 — through serial-killer worker bugs, a 22-nose clown show, and a Dolt migration." The serial killers were "viciously taking out random workers mid-job. (It's always the Deacon, the modern-day Butler in the Gas Town murder mysteries.)" The clown show: "the 22-nose Clown Show, where the Mayor scored a new clown nose every time it had massive data loss, which went on for weeks."

**What actually fixed it.** Not more watchdogs: a storage migration. "The inherent fragility of the v0.x Beads architecture, with its bidirectional sync, 3-way merge, two sources of truth, race conditions, and tombstone hell — that's all gone now. Dolt was designed to handle all this stuff gracefully." Dolt gives cell-level merge and version control over structured data; Beads moved from SQLite+JSONL sync to a Dolt backend (embedded or server). This is the single most important lesson in the corpus for Colony's problem (4): a class of silent failures disappeared when two sources of truth were collapsed into one, not when another supervisor was added.

**What Beads is for.** "Your project's Git commit history has always been your permanent ledger that contains the What, Where, Who, and How… Beads is the Why — the missing piece… for forensics, recovery, onboarding, design." "Beads is completely unaware of Gas Town"; it works with any agent "as long as it's roughly as smart as Claude Sonnet 3.5."

**Status.** "Gas Town is stable"; maintenance mode is "a good thing! It means it's not thrashing"; "hundreds of enthusiastic committers, and bugs get noticed and fixed fast". Beads at 20k stars, Gas Town at 13k at three months.

---

### 2.11 "The Shape of Things to Come, Part 1: The Continuous Thunderdome" — Steve Yegge, 2026-08

This is the most important late source: it is Yegge's post-mortem of Gas Town and the design of its successor, Wheelhouse.

**Why Gas Town ended (his account).** "Gas Town fell apart at the seams with Opus 4.7. Up through 4.6 it was working brilliantly. With 4.7 we saw the introduction of the 'just two more things' tic, which prevented Opus from ever converging on being ready to do real work — it always wanted to fiddle with Gas Town itself… Gas Town effectively burned down." Earlier: "Gas Town never quite succeeded in getting my workers to go all night long. It took too much elbow grease to keep it running… It was more like a chariot, with you driving." This is a dated, self-reported model-upgrade regression; it is also the strongest argument that a harness is coupled to a model's behavioral quirks and must be re-tested on every upgrade.

**Wheelhouse architecture (as of August 2026).** A Beads machine again, but with a cleaner producer/consumer split:

- **Crew**: 18 named agents, all Fable; work producers who write designs and translate them into beads implementation plans; the human's direct reports.
- **Fleet**: named Opus 5 agents, non-ephemeral, with their own clones; work consumers, managed by the Marshal (the new Witness), never directly by the human.
- **Role agents** for production operations: Gargoyle (SRE), Drawbridge (deploy-red monitor), Warden (abuse), Scryer (intake), Sheriff (chief of staff), Envoy (volunteer admins), plus Sage, Wanderer, Herald, Limner, Reeve, Forge, and a Builder Familiar.
- **Seneschal** is the new Mayor/concierge; **Marshal** runs the fleet; a **Beadle** is planned to nudge stuck/dropped agents ("Gas Town had this role in the Deacon").
- **"Crons watch, models act"**: about 45 launchd/systemd units wake an agent when something needs judgment; the schedulers and reapers do not reason.
- The implementation lifecycle is explicit: "Fable design, Opus implementation, Fable review. This keeps Opus on the rails and keeps the whole thing running relatively smoothly."

**Knowledge strategy.** A five-store table is worth copying almost verbatim:

| Store             | Charter                                                    | Lifetime              | How it reaches a session                 |
| ----------------- | ---------------------------------------------------------- | --------------------- | ---------------------------------------- |
| `brain/`          | Strategy, decisions-and-why, playbooks, post-mortems       | Months–years          | Pulled on demand                         |
| `doc/`            | How system X works                                         | Life of the system    | Pulled by whoever works on X             |
| Beads issues      | Units of work; spec beads carry full implementation detail | Until closed          | Loaded only by the claimant              |
| `bd remember`     | ≤1-paragraph operational facts and gotchas                 | Until falsified       | Pushed into every session via `bd prime` |
| `.claude/skills/` | Procedures for a recurring task type                       | Life of the task type | Auto-loaded on task match                |

**Cost, with numbers.** "My Wyvern development has been burning the equivalent of $87k/month of API token burn, or about 69 billion tokens in July (96% cache hits, fortunately)." He pays for 12 extra $200 Max accounts plus his own, each tied to a dedicated Google Workspace user, and rotates credentials; "~30x the list-price equivalent", "about $2800/month out of pocket". He notes this is a solo-user setup and "if you try this approach as a multi-person company then it's almost certainly a violation". Beads runs on a shared Dolt server backed by GCS, at "12,000 git commits/day" and "still a bit cranky".

**Throughput and the CI/CD collapse.** He averages "about 175 'real' commits per day this month, some days up to 250" against a build gate of "right around half an hour"; the MQ passed 100 and "we would get caught up in bisection loops and nothing would make forward progress". The Land Rush is the replacement: at MQ=100, abandon bisection, land a megabatch, then use agents to diagnose red main. He reports clearing "several very large batches of 120 to 150 commits", with a 166-deep queue at the time of writing. He corroborates the pattern with a game-industry practice ("Game DevOps": everyone blasts to main, release branch, main generally red) and the pigeonhole argument. Status: one week of personal use plus one external corroboration; not a controlled result.

**Human review.** "You can't work at agentic speeds and block everything with human reviews… in seven months, all the models will be that smart, and inference will be much cheaper. Plan now for that day to arrive, and get ready to replace your human code review with many, many rounds of agentic code review." This is a prediction, not a measured outcome.

**Harness cost and reuse.** "Working on Wheelhouse itself occupies about 20-25% of all my Wyvern work. I think that figure might turn out to be roughly constant over the life of systems with agentic harnesses." And: "I have given up on building reusable harnesses… Gas Town was intended to be reusable, but I only ever wound up using it to build itself." This directly challenges Colony's "one factory policy for every repo" premise; the counter-evidence is that Gas Town was used by outsiders (Wasteland, Gas City, community rigs), so the claim is about _his_ usage, not universal.

---

### 2.12 beads repository and docs — pinned 2026-10-21 (`gastownhall/beads` @ `9826fed`)

Live docs: `https://beads.gascity.com` (verified reachable 2026-10-21; content mirrors the repo docs).

**Core loop.** `bd create` → dependency graph → `bd ready` → `bd update --claim` → `bd close` → blockers released. `bd ready` "excludes in*progress, blocked, deferred, and hooked issues" and uses blocker-aware semantics to find "truly claimable work"; `--claim` atomically claims the first matching issue.
**How agents discover and file work.** Discovery is a database query, not a plan read: an idle agent runs `bd ready --json` (or receives a hook from the Mayor/scheduler) and claims the top result. Filing is symmetric: any agent can `bd create` a new issue, and the `discovered-from` edge attaches it to the issue that revealed it, so the new leaf appears in the same dependency graph and becomes `ready` when its own blockers clear. In Gas Town the conveyor is explicit: work sits in a rig's queue, `gt sling` puts one bead on a worker's hook, the worker runs it, and completion feeds convoys and the Mayor. Yegge's operating manual describes the review loop as "regular code review sweeps, followed by bug-fix sweeps that fix the issues filed during the code-review sweeps", with the swarm "filing Beads as it finds problems" — discovery is expected to produce new leaves, not to be an exception path (\_Gas Town Emergency User Manual*, 2026-01-13).

**Dependency types.** Blocking: `blocks`, `parent-child`, `conditional-blocks` (B runs only if A fails), `waits-for` (fanout aggregation). Non-blocking annotations: `related`, `tracks`, `discovered-from`, `caused-by`, `validates`, `supersedes`. The existence of `discovered-from` as a first-class edge is what makes runtime leaf creation cheap: an agent can file what it found without rewriting the plan.

**Gates.** Special issues that block dependents until an external condition: `gh:pr` (merged), `gh:run` (CI success), `timer`, `bead` (cross-rig issue closed), `human` (`bd gate resolve`). `bd gate check --escalate` evaluates and escalates failed gates. The documented rationale is exactly Colony's problem (5): with a decoupled store, "closing a beads issue means 'work is done' but the code may still be on a feature branch, waiting for PR review."

**Molecules and wisps.** A molecule is "just an epic" — a parent bead with children — plus workflow semantics; steps flow through `bd ready` in dependency order. `bd cook` compiles a TOML formula into a proto; `bd mol pour` instantiates a persistent molecule; `bd mol wisp` instantiates an ephemeral one; `bd mol squash` promotes a wisp to persistent; `bd burn` deletes without a digest. Wisps are excluded from federation push by default and garbage-collected by `bd purge` / `bd mol wisp gc`.

**Memory.** `bd prime` "prevents agents from forgetting bd workflow after context compaction"; in MCP mode it emits ~50 tokens, in CLI mode ~1–2k; `--memories-only` injects just persistent memories. `bd remember` stores a memory that "persists across sessions and account rotations" and is "injected at prime time… so you have them in every session". `bd memories` searches them.

**Maintenance.** `bd doctor --fix` for routine repairs; `bd admin cleanup` deletes closed issues (optionally older than N days, or ephemeral wisps only); `bd admin compact` squashes Dolt commits older than N days (default 30) and runs GC; `bd flatten` squashes all history. `bd bootstrap` clones an existing Beads Dolt database when setting up a new clone.

**Storage.** Dolt backend, embedded (single writer, file-locked) or server mode (many concurrent writers). Dolt gives "cell-level diffs and merges, not line-based", native branching, and a commit per write. The docs pin Dolt 2.2.0 because 2.3.0 regressed `DOLT_RESET('--hard')` (3/60 fresh databases broken) — an unusually concrete example of a supply-chain pin driven by measured failure rates.

**What the docs do not claim.** Beads does not plan; it does not enforce that agents use it; it does not make an agent's "done" true. It is a ledger plus a query engine.

---

### 2.13 Gas Town repository and docs — pinned 2026-10-21 (`gastownhall/gastown` @ `ef70b0b`)

**Architecture.** Two Beads levels: town (`hq-*` prefix; Mayor, Deacon, Boot, Dogs, role definitions, mail, convoys) and rig (project work, MRs, polecats, witness, refinery). All rigs share one Dolt SQL server per town; every agent writes `main` with transaction discipline (`BEGIN`/`DOLT_COMMIT`/`COMMIT`). Polecats and the Refinery are git **worktrees** off the canonical clone, not full clones; crew get full clones. There is "No per-directory CLAUDE.md or AGENTS.md"; context is injected by `gt prime` on the SessionStart hook.

**Roles.** The repo glossary and architecture confirm the launch taxonomy and add Boot as a special Dog. The Witness's responsibilities are explicitly bounded: it does not force session cycles, does not interrupt mid-step unless truly stuck, and does not reuse polecats while cleanup/MR state remains. It does nudge stalled sessions, clean up zombies, respawn crashes, and handle escalations.

**Stuck/drift detection (the mechanism, not the slogan).**

- Three heartbeat stores: a Deacon heartbeat file (read by the daemon; 5 min stale / 20 min very-stale → poke), a per-session state store (`working|idle|exiting|stuck`, read by the Witness "instead of inferring liveness from timers"), and a `heartbeat:<EPOCH>` label on the agent bead (second-order monitoring of the Deacon).
- Rule: "never declare an agent stuck from a single store"; cross-check tmux activity before escalating; a live session with a stale store is "heartbeat-write divergence, not a stuck agent".
- Patrol thresholds: GUPP violation = 30 min with `hook_bead` but no progress; hung session = 30 min of no tmux output; stuck-in-done = 60 s with `done-intent`. "These thresholds are intentionally generous… False positives… are worse than slow detection."
- Escalation: severity-routed (CRITICAL → bead+mail+email+SMS; HIGH → bead+mail+email; MEDIUM → bead+mail mayor), tiered Deacon → Mayor → Overseer, with `stale_threshold: 4h` and `max_reescalations: 2`; the design's future (not shipped) category routing includes `lifecycle` (worker stuck) routed to the Witness.

**Merge queue and verification.** The Refinery owns the queue; the architecture doc specifies Bors-style batch-then-bisect: rebase a batch as a stack, test the tip, fast-forward on pass, binary-bisect on failure; "Gates (test command, lint, etc.) are pluggable. The batching strategy is core." Status at the pin: "GatesParallel" is "In progress" and "Batch-then-bisect" is "Blocked by Phase 1", so the shipped behavior at that commit may still be closer to one-at-a-time than the design text suggests. Integration branches let an epic's child MRs target a shared `integration/{epic}` branch and land as "a single merge commit"; the documented reason is that without them, "each child merges independently… you're relying on merge order and hoping nothing breaks between lands."

**Memory and handoff.** The hook is a bead; `gt prime` injects role context on SessionStart and PreCompact; `gt mail check --inject` runs on UserPromptSubmit; `gt handoff` restarts a worker while preserving the tmux session and the hook. `gt seance` lets an agent "literally talk to predecessor sessions" via `claude --fork-session --resume <id>`, answering "Where did you put the stuff you left for me?" — the "#1 handoff question". Séance is a clever mitigation, but note the cost: it resumes a full predecessor context, which is the opposite of the small-prime strategy. It is best used for design archaeology, not routine repair.

**Propulsion.** `docs/concepts/propulsion-principle.md`: "If you find something on your hook, YOU RUN IT." The Handoff Contract says the agent will find the work, understand it (`bd show` / `gt hook`), and "BEGIN IMMEDIATELY", because "There is no supervisor polling asking 'did you start yet?'" and "The hook IS your assignment — it was placed there deliberately." The framing is physical, not moral: "This is physics. Steam engines don't run on politeness — they run on pistons firing. You are the piston."

**Idempotence.** NDI ("Nondeterministic Idempotence") is defined as "the overarching goal ensuring useful outcomes through orchestration of potentially unreliable processes. Persistent Beads and oversight agents (Witness, Deacon) guarantee eventual workflow completion even when individual operations may fail or produce varying results." The name admits the model is nondeterministic; the guarantee comes from the ledger and the supervisors, not from the model.

**Design docs that are not shipped.** `docs/design/witness-at-team-lead.md` (2026-02-08) explicitly says "Status: Future architecture — NOT YET IMPLEMENTED". Its spike measured Claude Code Agent Teams at "~7x" token cost per teammate, proposed Sonnet teammates with Opus only for the Witness lead, and estimated that AT's file-locked task claiming would cut Dolt write contention by "80-90%" **[UNVERIFIED: design estimate, not measured in production]**. Useful as a warning about nested-agent token multipliers, not as evidence of Gas Town behavior.

**Status of the project.** The repo is still active (last push 2026-10-21; 18,456 stars at fetch), but Yegge's August 2026 essay says Gas Town "effectively burned down" for his own use and that Wheelhouse is his harness now. His docs should therefore be read as a well-documented, partly shipped design that its author stopped operating at a model upgrade — not as a description of a currently operated system. The community fork/continuation (`gastownhall`) keeps the docs live; that does not make the deferred designs shipped.

---

### 2.14 First-hand practitioner reports

**Eric Koziol, "Exploring Gas Town", 2026-02-15 — six weeks of use.** His summary of the value: "The limiting factor is how fast you can think, give direction, and validate." Cost: "You can burn through half of a Pro Max account (or several) in six to eight hours running hot." Configuration: "I've worked up to 7-8 crew per rig"; Gas Town is designed for "20-30 agents". His explanation of why the roles exist is the best concise statement of the redundancy argument: "Without Beads, agents lose track of what's been done. Without the Witness, they'll insist finished work is correct when it isn't. Without the Deacon, stalled agents sit idle unnoticed. Without mail, agents working on related tasks can't coordinate. Each component exists because removing it causes a specific, predictable failure." He also states the design philosophy Colony needs: "You don't make agents better by giving them more freedom. You make them better by constraining their workflow and externalizing their state."

**Correction to Koziol.** He describes the Witness as verifying "against the actual requirements before allowing it to move on". Gas Town's own docs say the opposite: the Witness "observes but does NOT gate completion" and polecats self-manage completion. This is a practitioner simplification; use the repo docs for mechanism, the essay for felt experience.

**Ian Bull, "Beads — Memory for your Agent…", January 2026.** A practical, non-hyped guide. Architecture at that date: CLI → Unix socket → daemon → SQLite, with a JSONL export (5 s debounce) and optional git commit/push; the daemon provides auto-sync, file watching, connection pooling, and a claimed "60% CPU reduction vs polling approaches". On context rot he is blunt: "Beads won't solve context rot by magic. It's a tool, not a cure. But it gives you something markdown plans never could: structured, queryable, dependency-aware memory that survives session boundaries and syncs through git. The tool provides the memory. You provide the discipline." His remedies for context rot are all session-hygiene: kill sessions earlier, remind the agent, make `AGENTS.md` instructions stickier, use smaller tasks ("anything over ~2 minutes of work should be its own issue").

**DoltHub (Dustin Brown), "Common Beads Classic Workflows", 2026-04-15.** Written by a co-maintainer of the storage layer, and useful for the operational truth behind the architecture. In Beads v1.0.1 everything is mastered in a Dolt database; the default is a Dolt remote derived from the git `origin`; one git clone maps to one Beads Dolt database; multiple clones sharing one remote must synchronize writes and can hit merge conflicts; `bd bootstrap` clones the database to a new machine. He is candid about the cost of the migration: "although we know the opacity has caused some confusion for users"; Beads issues no longer travel with git branches, and pushes are "quite opaque" because they are invisible on GitHub. This is the kind of operational tax Colony would inherit if it adopted a versioned-SQL ledger without a single writer per scope.

**Note on inaccessible material.** The Medium post "10 hours with Gas Town (out of a possible 48)" (Enterprise Vibe Code, 2026-01-04) returned HTTP 403 and is therefore not used.

---

### 2.15 Commentary, not field reports

**Steve Klabnik, "How to think about Gas Town", 2026-01-15.** Explicitly a reading of the project, not a usage report. His useful observation is about legibility: "Gas town is two things simultaneously: something that's kind of boring and obvious, and something that's opaque and confusing, illegible almost." The essay's value to Colony is a warning about jargon and onboarding: a factory whose roles and invariants cannot be explained to a competent newcomer will be operated by folklore. Do not use it for architecture claims.

**paddo.dev, "Beads: Memory for Your Coding Agents", 2025-12-15.** A careful secondary summary, four weeks after launch. It supplies the memorable framing "Every session is 50 First Dates" and "Beads is shoes" (Yegge's own metaphor), and notes "hundreds of contributors" already. It adds no primary numbers; treat it as corroboration of the markdown-pain narrative only.

---

### 2.16 Background: the MAKER result Yegge cites — Meyerson et al., arXiv 2511.09030, 2025-11-12

**What it shows.** MAKER solves "a task with over one million LLM steps with zero errors" using "an extreme decomposition of a task into subtasks, each of which can be tackled by focused microagents" and "an efficient multi-agent voting scheme" at each step. The motivation is exactly Colony's long-horizon problem: models have "a persistent error rate that prevents scale-up"; in Towers of Hanoi experiments, "the process inevitably becomes derailed after at most a few hundred steps."

**How Yegge uses it.** He claims Gas Town's wisps/molecules can express such workflows, ran a 10-disc Hanoi "in a few minutes" as a thousand-step proof, and estimated a 20-disc run at "about 30 hours" (_Welcome to Gas Town_, 2026-01-01). He did **not** run the million-step task ("I wanted to run the million-step wisp but ran out of time"). Treat "Gas Town solves MAKER" as a hypothesis, not a result. The usable lesson is narrower and solid: decomposition plus per-step error correction is what makes long workflows survivable; a single agent with a long context is not.

---

### 2.17 Published numbers (consolidated)

| Metric                       | Value                                                                                 | Source and date                                | Status                         |
| ---------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| Beads prototype → 1k stars   | 6 days; ~15k LOC                                                                      | _The Beads Revolution_, 2025-10-15             | self-reported                  |
| Beads LOC written in 40 days | 350k lines of Go                                                                      | _Introducing Beads_, 2025-10-13                | self-reported                  |
| Beads bug rate (v0)          | "half a dozen major… bugs every single day" for 3 weeks                               | _Beads Blows Up_, 2025-11-06                   | self-reported                  |
| Beads stars                  | 20k in ~5 months; 28,065 at fetch                                                     | v1.0 essay, 2026-04-03; GitHub API, 2026-10-21 | verified at fetch              |
| Gas Town launch              | 17 days, 75k LOC, 2,000 commits                                                       | _Welcome to Gas Town_, 2026-01-01              | self-reported                  |
| Gas Town at day 12           | 189k LOC, 2,684 commits, 100+ PRs, ~50 contributors, 44k LOC "no human has looked at" | _Emergency User Manual_, 2026-01-13            | self-reported                  |
| Gas Town stars               | 13k at 3 months; 18,456 at fetch                                                      | v1.0 essay, 2026-04-03; GitHub API, 2026-10-21 | verified at fetch              |
| Gas Town/Beads community     | 2,400 PRs submitted, 1,500 merged, 450+ contributors in ~2 months                     | _Welcome to the Wasteland_, 2026-03-04         | self-reported                  |
| Gas Town concurrency         | "under 30 workers"; "a dozen or so active"; 20–30 in the pitch                        | _Welcome to Gas Town_, 2026-01-01              | self-reported                  |
| Practitioner concurrency     | 20–30 agents                                                                          | Koziol, 2026-02-15                             | self-reported                  |
| Gas Town crew size           | 7–8 crew per rig (up from 3)                                                          | _Gas Town Emergency User Manual_, 2026-01-13   | self-reported                  |
| Practitioner cost            | "half of a Pro Max account (or several) in six to eight hours running hot"            | Koziol, 2026-02-15                             | self-reported                  |
| Wheelhouse token burn        | $87k/month equivalent; 69B tokens in July; 96% cache hits                             | _Shape of Things to Come_, 2026-08             | self-reported                  |
| Wheelhouse out-of-pocket     | ~$2,800/month; 12 extra $200 Max accounts; ~30x list-price equivalent                 | ibid.                                          | self-reported                  |
| Wheelhouse commit rate       | 175 "real" commits/day, up to 250; 12,000 git commits/day on the Beads DB             | ibid.                                          | self-reported                  |
| Wheelhouse build gate        | ~30 minutes; MQ 100+ (166 at writing); megabatches 120–150                            | ibid.                                          | self-reported, one week of use |
| MAKER                        | >1,000,000 LLM steps, zero errors                                                     | arXiv 2511.09030, 2025-11-12                   | peer-review status not checked |

---

### 2.18 What was removed or stopped (and what replaced it)

| Doesn't work                                     | Why, in his words                                                                                                                           | Replacement                                                             | Date                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------- |
| Markdown TODO/plans as agent memory              | "text, not structured data"; "not queryable"; "bit-rot very fast"                                                                           | Beads graph + `bd ready`                                                | 2025-10-13                 |
| Letting agents manage their own TODO list        | They skip steps and disavow work near compaction                                                                                            | External ledger; one step per issue; `bd close` only on evidence        | 2025-10-13 / 2026-01-01    |
| Long sessions / big tasks                        | Usable context is 10–15% even at 1M; 5–10 minutes of full-speed work                                                                        | Kill and restart per task; fine-grained beads; molecules                | 2025-10-19 / 2025-11-24    |
| Mechanical "stuck" detection by timer            | It killed workers "that weren't stale"                                                                                                      | Three heartbeat stores + AI adjudication + generous thresholds          | 2026-01-13 / patrol design |
| The Witness gating every completion              | It would become a bottleneck                                                                                                                | Witness observes/nudges; polecat self-manages; Refinery gates the merge | architecture doc           |
| One-commit-per-green-build CI at high rates      | Pigeonhole: more commits than build slots; bisection loops starve throughput                                                                | Land Rush megabatch + swarm diagnosis (experimental)                    | 2026-08                    |
| Human line-by-line code review at agentic speed  | "You can't work at agentic speeds and block everything with human reviews"                                                                  | Many rounds of agentic review (prediction)                              | 2026-08                    |
| A reusable harness/framework for everyone        | "I have given up on building reusable harnesses"; Gas Town was "intended to be reusable, but I only ever wound up using it to build itself" | Bespoke harness per project                                             | 2026-08                    |
| Waiting for bigger context windows               | Usable fraction, not window size, is the constraint                                                                                         | Decomposition and external memory                                       | 2025-10-19                 |
| A town as the scaling unit                       | "A town is about machine-sized"                                                                                                             | Many towns / federation                                                 | 2026-01-05 / 2026-03-04    |
| Treating polecats as an idle pool                | "There is no such thing as an idle polecat; it's not a pool"                                                                                | Persistent identity, ephemeral session, on-demand spawn                 | 2026-01-13                 |
| Relying on the agent to self-start from a prompt | "It just sits there waiting for user input"                                                                                                 | Hook + nudge + SessionStart prime                                       | 2026-01-01                 |
| Two sources of truth for work state              | "bidirectional sync, 3-way merge… tombstone hell"                                                                                           | One Dolt-backed ledger                                                  | 2026-04-03                 |

### 2.19 Model mix and reported cost

Yegge rarely names models in the Gas Town essays, and that omission is itself a finding: the harness was designed for "Claude Code instances", not for a per-role model policy. The explicit statements are these.

| Period / system                           | Planner / design                                                | Producer / implementer                                   | Reviewer / merge             | Reported cost                                                                               |
| ----------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| Gas Town launch, 2026-01                  | Human Overseer + Mayor (a Claude Code session); model not named | Polecats, "20–30 Claude Code instances"; model not named | Refinery gates; human merges | None published; subscription accounts                                                       |
| Gas Town AT design, 2026-02 (not shipped) | Opus Witness lead                                               | Sonnet teammates                                         | Opus Witness lead            | "~7x" tokens per teammate in the spike **[UNVERIFIED design estimate]**                     |
| Wheelhouse, 2026-08                       | Fable crew (design)                                             | Opus 5 fleet; Fable crew also produces                   | Fable review                 | $87k/month list-equivalent; ~$2,800/month out of pocket; 69B tokens in July; 96% cache hits |
| Practitioner, Koziol 2026-02              | Human                                                           | 20–30 agents                                             | Human                        | "half of a Pro Max account (or several) in six to eight hours running hot"                  |

The cost lesson is not a per-task price; it is that **the bill is dominated by cache hits, subscription arbitrage, and how many agents you keep running**, not by the price of one model call. Yegge's model-mix preference is stable from the AT design to Wheelhouse: the expensive model does design and review (judgment); execution runs on cheaper models. The Gas Town launch itself is silent on which model the polecats used, so any claim that Gas Town's throughput came from a particular model is **[UNVERIFIED]**.

---

## 3. Sources (dated)

**Steve Yegge essays** (read in full at `yegge.ai`, which mirrors the Medium originals):

- 2025-10-13 — _Introducing Beads: A coding agent memory system_. https://yegge.ai/essays/introducing-beads-a-coding-agent-memory-system/
- 2025-10-15 — _The Beads Revolution: How I Built The TODO System That AI Agents Actually Want to Use_. https://yegge.ai/essays/the-beads-revolution-how-i-built-the-todo-system-that-ai-agents-actually-want-to/
- 2025-10-19 — _Beads for Blobfish_. https://yegge.ai/essays/beads-for-blobfish/
- 2025-11-06 — _Beads Blows Up_. https://yegge.ai/essays/beads-blows-up/
- 2025-11-24 — _Beads Best Practices_. https://yegge.ai/essays/beads-best-practices/
- 2026-01-01 — _Welcome to Gas Town_. https://yegge.ai/essays/welcome-to-gas-town/
- 2026-01-05 — _The Future of Coding Agents_. https://yegge.ai/essays/the-future-of-coding-agents/
- 2026-01-13 — _Gas Town Emergency User Manual_. https://yegge.ai/essays/gas-town-emergency-user-manual/
- 2026-03-04 — _Welcome to the Wasteland: A Thousand Gas Towns_. https://yegge.ai/essays/welcome-to-the-wasteland-a-thousand-gas-towns/
- 2026-04-03 — _Gas Town: from Clown Show to v1.0_. https://yegge.ai/essays/gas-town-from-clown-show-to-v10/
- 2026-08 — _The Shape of Things to Come, Part 1: The Continuous Thunderdome_. https://yegge.ai/essays/the-shape-of-things-to-come/

**Repositories and docs** (pinned at fetch, 2026-10-21):

- beads: `https://github.com/gastownhall/beads` @ `9826fed967bbeabd06b8cf96a5ba8370fb25c369` (28,065 stars at fetch; repo created 2025-10-12). Docs site: `https://beads.gascity.com`.
  - `docs/core-concepts/index.md`, `issues.md`, `dependencies.md`
  - `docs/multi-agent/index.md`
  - `docs/architecture/dolt.md`
  - `docs/workflows/molecules.md`, `wisps.md`
  - `docs/cli-reference/ready.md`, `prime.md`, `remember.md`, `memories.md`, `admin.md`, `compact.md`
- Gas Town: `https://github.com/gastownhall/gastown` @ `ef70b0bf9e588dce00708e36564bfc06b51fac2c` (18,456 stars at fetch; repo created 2025-12-16).
  - `docs/glossary.md`, `docs/overview.md`, `docs/WHY-THESE-FEATURES.md`
  - `docs/concepts/propulsion-principle.md`, `polecat-lifecycle.md`, `heartbeats.md`, `integration-branches.md`, `molecules.md`
  - `docs/design/architecture.md`, `polecat-lifecycle-patrol.md`, `escalation.md`, `witness-at-team-lead.md` (future, not implemented), `scheduler.md`
  - `docs/HOOKS.md`, `docs/reference.md`
  - `internal/cmd/seance.go`
  - `README.md`

**Practitioner and secondary sources:**

- 2025-11-12 — Meyerson, Paolo, Dailey, Shahrzad, Francon, Hayes, Qiu, Hodjat, Miikkulainen, _Solving a Million-Step LLM Task with Zero Errors_ (MAKER), arXiv:2511.09030. https://arxiv.org/abs/2511.09030
- 2025-12-15 — paddo.dev, _Beads: Memory for Your Coding Agents_. https://paddo.dev/blog/beads-memory-for-coding-agents/
- 2026-01 — Ian Bull, _Beads — Memory for your Agent and The Best Damn Issue Tracker You're Not Using_. https://ianbull.com/posts/beads/
- 2026-01-15 — Steve Klabnik, _How to think about Gas Town_. https://steveklabnik.com/writing/how-to-think-about-gas-town/ (commentary; explicitly not a usage report)
- 2026-02-15 — Eric Koziol, _Exploring Gas Town_. https://embracingenigmas.substack.com/p/exploring-gas-town
- 2026-04-15 — Dustin Brown (DoltHub), _Common Beads Classic Workflows_. https://www.dolthub.com/blog/2026-04-15-common-beads-workflows/

**Sourcing notes.** All quotes were checked against the fetched text of the cited page; line breaks and typographic quotes were normalized. The Medium-hosted "10 hours with Gas Town" (2026-01-04) could not be fetched (HTTP 403) and is not used. Yegge's operational numbers (LOC, commits, tokens, dollars, incident counts) are self-reported and not independently audited; stars and repo creation dates were verified through the GitHub API on 2026-10-21. Gas Town's design docs mix shipped behavior and future specs; status markers were taken from the documents themselves and are called out where they matter. No claim in this document depends on a number I could not trace to one of the sources above.
