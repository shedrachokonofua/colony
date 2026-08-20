/**
 * Colony playbooks: skill files provisioned into every run workspace at
 * `.colony/skills/`. The role prompts carry the always-on senses; these
 * carry the deep doctrine that does not fit a prompt budget, loaded lazily
 * by the agent when the situation arises.
 *
 * Delivery note: the SDK's own skills mechanism (loadSkills) discovers on
 * the daemon filesystem, but Colony routes the read tool into the sandbox
 * pod, so SDK-advertised paths would be unreadable. Instead the daemon
 * writes these files into the workspace before the engine ships it to the
 * pod - same relative path on both sides, readable by every tool.
 *
 * Distilled from: mattpocock/skills (diagnosing-bugs, codebase-design,
 * code-review), obra/superpowers (systematic-debugging, writing-plans,
 * test-driven-development), Trail of Bits skills (differential-review,
 * fp-check), and Google's eng-practices review guide.
 */

export interface ColonySkill {
  /** Filename under .colony/skills/ */
  readonly file: string;
  /** One-line trigger description used by role prompts. */
  readonly trigger: string;
  readonly content: string;
}

const DEBUGGING = `# Debugging playbook

Root cause before fixes, always. A symptom fix is a failure.

## Phase 1 - build the feedback loop (this IS the skill)
One command that goes red on THIS bug and green when it is fixed.
Candidates, in order: a failing test at the nearest seam; a curl against a
dev server; a CLI invocation diffed against known-good output; a replayed
captured payload; a throwaway harness that calls the broken path directly.
- "Runs without erroring" is not a loop - it must assert the user's exact
  symptom.
- Tighten it: faster (skip unrelated setup), sharper (assert the specific
  symptom), deterministic (pin time, seed RNG, isolate fs).
- Flaky bug? Raise the reproduction rate until debuggable: loop the trigger
  100x, add stress, narrow the timing window. 50% reproduction is
  debuggable; 1% is not.
- Cannot build a loop at all? Say so explicitly in your report/blocked
  reason with what you tried. Do NOT proceed to hypothesize without one.

## Phase 2 - reproduce and minimise
Run the loop; watch it go red for the user's exact symptom (a nearby
different failure is a different bug). Then shrink the reproduction one cut
at a time - inputs, callers, config, data - re-running after each cut,
until every remaining element is load-bearing. The minimal repro shrinks
the suspect space and becomes the regression test.

## Phase 3 - hypothesize scientifically
List 3-5 ranked hypotheses BEFORE testing any (one hypothesis anchors you).
Each must be falsifiable: "if X is the cause, changing Y makes the loop go
green". A hypothesis without a prediction is a vibe - discard it.

## Phase 4 - instrument and fix
- Probe only at boundaries that distinguish hypotheses. One breakpoint or
  targeted log beats ten; never "log everything and grep".
- Tag every debug line with one unique prefix (e.g. [DBG-4f2a]); one grep
  removes them all. Grep for the prefix before finishing.
- Multi-layer systems (CI -> build -> test, API -> service -> DB): log what
  enters and exits each layer, run once, find WHERE it breaks, then ask why.
- Performance: measure a baseline, then bisect. Logs are the wrong tool.
- ONE minimal change per hypothesis. Never stack a second speculative fix
  on an unverified first.
- Write the regression test at a seam that exercises the real bug pattern.
  A seam too shallow to replicate the trigger gives false confidence - if
  no correct seam exists, that is itself a finding worth reporting.

## Three-strikes rule
After 3 failed fixes the diagnosis is wrong, not unlucky. If each fix moves
the failure somewhere new, the architecture of the approach is wrong -
stop, reconsider the design, or report blocked with the ranked analysis.
Never paper over: no sleeps for races, no retries around deterministic
bugs, no catch-and-ignore, no weakened assertions.

State the confirmed root cause in the commit message.
`;

const DESIGN = `# Design playbook

For new functions, types, modules, or interfaces the spec requires.

## Deep modules
A module is anything with an interface and an implementation. Its interface
is EVERYTHING a caller must know: signature, invariants, ordering
constraints, error modes, required configuration. Design deep: a lot of
behavior behind a small interface. Ask of every interface: can I reduce the
methods? simplify the parameters? hide more inside?

- The deletion test: imagine deleting the module. If its complexity would
  just reappear spread across N callers, it earns its place. If complexity
  would vanish, it was a shallow pass-through - remove or inline it.
- The interface is the test surface: callers and tests cross the same seam.
  Wanting to test past the interface means the module is the wrong shape.
- One adapter is a hypothetical seam; two adapters is a real one. Never
  introduce an abstraction only one implementation will ever fill.

## Testability by construction
- Accept dependencies as parameters; never construct them inside.
- Return results; avoid mutating state the caller must inspect.
- Small surface: fewer methods = fewer tests; fewer params = simpler setup.

## Design it twice
For any non-trivial interface, sketch a second, materially different shape
(different entry points, different seam placement) before implementing, and
keep the better one. Compare on depth (leverage per entry point) and
locality (where future change concentrates). The first idea is rarely best;
this costs minutes.

## Consistency beats novelty
In an existing codebase, the established pattern wins even when your
alternative is marginally better - a second convention is a defect. Follow
the repo's file layout, naming, error handling, and test conventions
exactly; make the change look like the repository wrote it.
`;

const CODE_REVIEW = `# Review playbook

## Risk triage (never triage by size - famous CVEs were two lines)
Deepest read for hunks touching: authn/authz, crypto, secrets handling,
input validation, external calls, money, migrations, and anything
concurrency. A "pure refactor" in those areas is high-risk until proven
otherwise - refactors break invariants.
- Removed checks/guards/validation: run \`git log -S '<removed code>'\` -
  if it arrived in a fix commit, its removal is a regression until the diff
  proves the protection lives elsewhere.
- High-risk change with no test touching it: elevate the severity of
  whatever you find there.
- Blast radius: for every changed exported symbol, count and read callers.
  Wide-radius changes get proportionally deeper review.

## The two axes (report both, never let one mask the other)
1. Spec fidelity: requirements missing or partial; behavior nobody asked
   for (scope creep); requirements implemented but wrong.
2. Codebase health: does it look like the repository wrote it? Departures
   from established patterns/helpers/naming are findings (minor unless they
   break behavior). Skip anything a formatter or linter already enforces.

## Smell baseline (judgment calls, always minor, repo conventions override)
Mysterious names; duplicated logic shapes across hunks; the same few
params travelling together (a type wanting to be born); primitives standing
in for domain concepts; one logical change scattered across many files;
speculative generality (hooks and params for needs the spec does not have);
a class that mostly delegates onward; slop comments (narration of what the
code plainly does, change-log comments like "// added X", commented-out
code) - noise a maintainer must now carry.

## Tests as contracts
- Mentally delete the feature: does some test go red? If not - finding.
- A test asserting only that a mock was called, or restating the
  implementation, is a defect, not coverage.
- Weakened, skipped, or deleted tests to get green: blocker.

## False-positive discipline (you are biased toward over-reporting)
Before any blocker/major enters the envelope:
1. Restate the defect precisely - claim, root cause, trigger, impact. Half
   of false positives collapse at restatement.
2. Trace the actual data flow from where the bad value enters to where it
   bites. "This pattern looks dangerous" is not analysis - upstream
   validation may already cover it. Similar code being vulnerable elsewhere
   proves nothing about this instance.
3. Devil's advocate your own claim: what would make this a non-issue?
A finding you could not defend to the implementer does not get submitted.

## Verdict standard
The bar is the spec plus codebase health, not perfection. An imperfect
change that satisfies the spec, is tested, and leaves the code no worse is
approvable. Reject only for findings that matter; never inflate a minor.
`;

const TASK_SPECS = `# Spec-writing playbook

Write for a skilled engineer with ZERO context who cannot ask questions.

## Right-sizing
Split two pieces of work only where a reviewer could meaningfully reject
one while approving the other. Fold setup, config, scaffolding, and docs
into the task whose deliverable needs them. Prefer the smallest plan: every
extra task must buy real concurrency or it costs review cycles and merge
risk for nothing. One task is a legitimate plan.

## Contracts between tasks
Implementers see only their own spec. When task B consumes anything task A
produces, B restates the contract concretely (exact paths, exported
symbols, signatures, schema shapes) and A declares it produces exactly
that. If two specs need the same detail, repeat it verbatim in both - never
"like task 2 does". Name and type consistency across specs is load-bearing:
clearLayers in one spec and clearFullLayers in another costs a full attempt.

## Banned spec content (plan failures, not shortcuts)
"TBD"; "add appropriate error handling"; "handle edge cases"; "as needed";
"and similar"; verification steps without the exact command; references to
files, symbols, or types that no task defines and the repo does not contain.

## Evidence
Every task names falsifiable evidence: exact commands that fail on the
default branch today and pass when the task is done. "Verify it works" is
banned. Scope-level acceptance criteria prove the GOAL from a fresh
checkout, not that individual tasks landed.

## Self-review before submitting
1. Design it twice: sketch a materially different decomposition; keep the
   better one.
2. Coverage walk: every requirement in the goal maps to a task.
3. Consistency walk: every shared path/symbol/type matches across specs.
4. Fresh-checkout walk: every empty-depends_on task is executable against
   the default branch alone.
`;

const CLEAN_CODE = `# Clean code playbook

## Comment discipline (agents chronically over-comment)
A comment that can be deleted without losing information is noise - delete
it. Comments earn their place only when they carry what the code cannot:
WHY a non-obvious approach was chosen, an invariant that must hold, a
gotcha, a workaround with its upstream cause, a spec/ticket constraint.

Slop patterns - never write these:
- Narration: "// loop through the items", "// call the helper",
  "// return the result". The code already says it.
- Change-log narration: "// added X", "// new helper", "// updated to
  handle Y", "// moved from foo.ts". Git history owns change narration;
  code is read in its present tense.
- Restating the signature: "/** Gets the user. @param id the id */".
  Doc comments on exported APIs document contract - inputs, invariants,
  error modes - or they do not exist.
- Section banners ("// ---- helpers ----") in files that did not already
  use them; apologetic hedges ("// this is a bit hacky"); commented-out
  code (delete it - git remembers).
If code seems to need a what-comment, rename or extract until it does not:
the comment is a smell of a murky name or an overlong function.

## Names
Names carry the design. A name states what the thing IS or DOES in the
domain's vocabulary - never its type, its history, or its author's plan
(no Manager/Helper/Util grab-bags, no processData, no newParser2). If an
honest name will not come, the design under it is murky - fix that first.
Match the repository's naming conventions exactly; a second convention is
a defect.

## Functions and shape
- One job per function; "and" in an honest description means split it.
- Guard clauses over nested conditionals; early return over else-chains.
- No boolean flag parameters that fork behavior - two functions.
- Keep the happy path unindented and readable top to bottom.

## Deletion is a feature
Dead code, unused exports, stale scaffolding, unreachable branches, and
obsolete aliases are defects to remove, not history to preserve. When a
migration completes, delete the old path entirely - no deprecated shims
unless the spec demands a compatibility window.
`;

export const COLONY_SKILLS: readonly ColonySkill[] = [
  {
    file: "debugging.md",
    trigger: "when anything fails and the fix is not immediately obvious",
    content: DEBUGGING,
  },
  {
    file: "design.md",
    trigger: "before creating a new function, type, module, or interface",
    content: DESIGN,
  },
  {
    file: "code-review.md",
    trigger: "before reading the diff of a merge request under review",
    content: CODE_REVIEW,
  },
  {
    file: "task-specs.md",
    trigger: "before decomposing a goal into task specs",
    content: TASK_SPECS,
  },
  {
    file: "clean-code.md",
    trigger:
      "before writing code, and again when reviewing your own diff for comments, names, and dead code",
    content: CLEAN_CODE,
  },
];

/** Prompt line pointing a role at its playbooks. */
export function playbookPrompt(files: readonly string[]): string {
  const rows = COLONY_SKILLS.filter((s) => files.includes(s.file)).map(
    (s) => `- \`.colony/skills/${s.file}\` — read it ${s.trigger}.`,
  );
  return ["# Playbooks", ...rows].join("\n");
}
