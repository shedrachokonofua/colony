# Investigating failures and blocked work

Diagnose Colony by joining four evidence planes: Colony state, run events and
artifacts, LiteLLM requests, and deployed runtime state. A plausible log line
is not a root cause; establish the decision timeline and compare it with a
successful control.

## Safety boundary

Investigations are read-only unless the user explicitly requests an operator
action.

- Never print `.env`, Kubernetes Secrets, bearer tokens, private-token
  headers, raw prompts, or complete model responses. Parse credentials
  in-process and emit only status, IDs, timestamps, model names, counts, and
  redacted errors.
- Never quote hidden reasoning. Report structural facts: reasoning
  present/absent, visible-content length, tool-call count, and stop reason.
- Do not attribute unrelated traffic by timestamp alone. Correlate run ID,
  source IP, model route, request ID, and event ordering where available.
- Treat `workspace_capture_failed`, transcript upload, disposal, and sandbox
  destruction as teardown until event ordering proves they preceded the run
  decision.
- Before any mutation, snapshot current state and verify the state guard. A
  stale unblock can create duplicate work (see
  [playbooks.md](playbooks.md) §4).

## Aether environment reference

| Surface                  | Location                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| Colony API/UI            | `https://colony.home.shdr.ch`                                      |
| Keycloak token endpoint  | `https://auth.shdr.ch/realms/aether/protocol/openid-connect/token` |
| Operator client          | `colony-operator`                                                  |
| Local secret key         | `COLONY_OPERATOR_CLIENT_SECRET` in `.env`                          |
| Colony namespace         | `colony`                                                           |
| Sandbox namespace        | `colony-sandboxes`                                                 |
| LiteLLM namespace        | `litellm`                                                          |
| LiteLLM deployment       | `deployment/litellm`                                               |
| LiteLLM database         | CNPG PostgreSQL in `litellm`                                       |
| Production Colony config | `config/colony.deploy.yaml`, baked into the colonyd image          |

Prefer the operator API over reading the local `data/colonyd.db`: the local
database may be a development instance unrelated to Aether production.

## Workflow

### 1. Establish the target snapshot

Resolve the supplied scope, task, or run through the API (`get_scope`,
`get_task`, `get_run`; CLI `colony scope|task|run`). Record:

- scope status, repository, project, approvals mode;
- task state, state version, attempt, MR IID, head SHA, blocked reason,
  retry time;
- every run's ID, kind, model ID, status, start/end time, error, inspected
  SHA;
- audit transitions (`GET /audit` / `colony audit`) around the first failure
  and the final block.

Fetch every run-events page (`run_events` / `colony logs`, paging with
`before_id`) and `GET /runs/:id/artifacts` (`colony artifacts <run-id>`)
for each failed run. Never infer absence from the first page.

### 2. Build the decision timeline

For each failed run, count and order:

- model turns and `pi_usage` stop reasons;
- tool calls and tool errors;
- completion rejection or accepted-envelope events;
- continuation nudges and model fallback events;
- run summary, terminal error, and later teardown events.

For `finalize_no_submission`, answer these separately:

1. Was the submit tool invoked?
2. Was an envelope rejected by schema or policy?
3. Did the model stop normally without an envelope?
4. Was a fallback model attempted?
5. Did teardown fail only after the decision?

Download transcript artifacts only when event structure is insufficient.
Decompress and parse locally, redact before display, report counts rather
than model reasoning.

### 3. Correlate LiteLLM

Use LiteLLM access logs and `LiteLLM_SpendLogs` for the exact run window.
Select only safe fields: `startTime`, `endTime`, `model_group`, `model`,
`custom_llm_provider`, `status`, prompt/completion token counts, duration,
response `finish_reason`, visible-content length, reasoning-content length,
tool-call count. Do not select `messages`, full `response`, API keys, proxy
request bodies, or metadata until a specific safe field is required.

Interpretation:

- HTTP 200 / `status=success` proves transport success, not task success.
- `finish_reason=stop`, visible content length zero, reasoning present, and
  zero tool calls is a semantic/tool-choice failure.
- A submission schema failure requires an actual submit call plus rejection
  evidence.
- MCP errors from another source IP or an unused tool are unrelated traffic.

### 4. Compare a successful control

Find a nearby successful run with the same role, model route, and runtime
version. Compare its terminal sequence. For reviewer controls, success
includes a `submit_reviewer_verdict` observation and terminal
`stop_reason=toolUse`. Use cohort rates only after enumerating the complete
result set; state the time boundary and denominator.

### 5. Inspect the responsible control flow

Map evidence to source rather than guessing from error names. For Pi
reviews, inspect: reviewer prompt and submit-tool schema; continuation loop
and zero-output accounting; model fallback conditions; finalizer prompt
usage; `finalize_no_submission` assignment; the colonyd review retry/block
threshold; post-decision artifact capture.

A configured fallback list does not prove fallback happened. Require
`pi_model_fallback`, a changed `run.model_id`, or subsequent `pi_usage` from
the fallback route.

## Failure taxonomy

| Class                      | Required evidence                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Provider/gateway           | Connection failure, quota/rate limit, 5xx, timeout, or failed LiteLLM spend row tied to the run     |
| Model protocol/tool choice | Successful provider response, normal stop, no required tool call or visible envelope                |
| Submission validation      | Submit tool called and explicit completion/envelope rejection                                       |
| Runner policy              | Source path explains why observed model behavior did not trigger finalizer/fallback/retry correctly |
| Sandbox/workspace          | Provision, transfer, workspace-lost, RBAC, EACCES, or probe failure before decision                 |
| Colonyd lifecycle          | Process restart, expired lease, watchdog, reconciliation, or persistence failure                    |
| Teardown noise             | Transcript/workspace capture, dispose, cleanup, or sandbox destruction after decision               |

Rank causes. Name the primary root cause, amplifiers, and excluded
alternatives.

## Deployment-to-revival gate

Never revive a blocked task merely because `main` was pushed.

1. Record the exact pushed commit SHA and expected canonical model ID from
   that commit.
2. Require the SHA's GitLab pipeline to pass validate, unit, e2e, and
   `build:colonyd`.
3. Prove the immutable SHA image was pushed; for `main`, prove `latest`
   resolves to the same digest.
4. Verify the Aether deployment rolled out: one current ready pod, old pod
   gone, `/ready` returns 200.
5. Inside the pod, emit only `COLONY_VERSION` and the selected model ID from
   the resolved config. Never dump environment or the whole config.
6. Snapshot the blocked task and latest runs.
7. Only with explicit user authorization, call `task_action unblock`
   (`POST /tasks/:id/unblock`) with the caller's actor and token.
8. Verify the blocked→queued audit/state transition and a new run started
   after rollout/unblock.
9. Verify the new run's canonical `model_id` and `pi_usage` route; if
   capacity selected a fallback, report that instead of claiming the primary
   ran.

## Creating operational scopes

The console is project-first. For work on the Colony repository itself,
open scopes with `project: "colony"` (`open_scope` / `colony open`); a scope
without a project exists in the global API but is absent from the project
page.

After opening a scope, verify both:

- `get_scope` shows planning/active progress;
- `list_scopes project=colony` contains the new ID.

If an accidental orphan scope was just created, abandon it before creating
the correctly associated replacement so two architects do not implement the
same change.

## Report structure

1. **Problem:** exact failed component and user-visible consequence.
2. **Evidence:** run IDs, timestamps, terminal sequence, provider result,
   control comparison.
3. **Decision:** root cause and why competing causes are excluded.
4. **Current state:** what is running, blocked, deployed, or awaiting CI.
5. **Next action:** smallest safe recovery and durable correction.

Mark inference explicitly. Never say a route is deployed, a task revived, or
a fallback used without direct evidence.

## Common mistakes

| Mistake                                         | Correction                                                     |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Reading local SQLite for a production task      | Query the Aether operator API first                            |
| Blaming HTTP/provider because the run failed    | Correlate LiteLLM status and finish reason                     |
| Calling `finalize_no_submission` a schema error | Prove whether a submit call existed                            |
| Treating configured fallbacks as executed       | Require fallback events/model provenance                       |
| Quoting model reasoning                         | Report structural metadata only                                |
| Unblocking while CI or rollout is running       | Prove exact image/config is live first                         |
| Creating a scope without `project`              | Use `project: "colony"` and verify project-filtered visibility |
| Dumping pod env/config for convenience          | Select only non-secret fields in-process                       |
