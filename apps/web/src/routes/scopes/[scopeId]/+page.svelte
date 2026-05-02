<script lang="ts">
  import type { PageData } from "./$types";
  import { Tabs } from "bits-ui";
  import AuditTimeline from "$lib/AuditTimeline.svelte";

  let { data, form }: { data: PageData; form?: Record<string, unknown> | null } = $props();
  let tab = $state<
    "tasks" | "decomposition" | "closure" | "sync" | "audit"
  >("tasks");

  function taskSync(taskId: string) {
    return data.providerSync?.tasks.find((item) => item.colony_id === taskId);
  }
</script>

<section class="stack">
  <div>
    <p class="muted">
      <a href="/scopes">← All scopes</a>
    </p>
    {#if data.scope}
      <h1>{data.scope.title}</h1>
      <p class="muted">
        <code>{data.scope.id}</code>
        &middot;
        <span class="badge state-{data.scope.state}">{data.scope.state}</span>
        &middot; v{data.scope.state_version}
        &middot; updated {new Date(data.scope.updated_at).toLocaleString()}
      </p>
    {/if}
  </div>

  {#if data.loadError}
    <div class="error">{data.loadError}</div>
  {/if}
  {#if form?.action === "runArchitect" && typeof form.notice === "string"}
    <div class="card">{form.notice}</div>
  {/if}
  {#if form?.action === "runArchitect" && typeof form.error === "string"}
    <div class="error">{form.error}</div>
  {/if}

  {#if data.scope}
    {#if data.scope.description}
      <div class="card">
        <p style="margin:0; white-space:pre-wrap">{data.scope.description}</p>
      </div>
    {/if}

    {#if data.scope.state === "draft"}
      <form method="POST" action="?/runArchitect" class="card row">
        <label style="min-width:18rem">
          <span>Primary project</span>
          <select name="provider_project_id">
            <option value="">Use existing scope target</option>
            {#each data.providerProjects as project (project.id)}
              <option value={project.id}>{project.provider}: {project.path}</option>
            {/each}
          </select>
        </label>
        <button type="submit">Run architect</button>
      </form>
    {/if}

    <Tabs.Root bind:value={tab}>
      <Tabs.List class="tabs-list">
        <Tabs.Trigger value="tasks" class="tabs-trigger"
          >Tasks ({data.tasks.length})</Tabs.Trigger
        >
        <Tabs.Trigger value="decomposition" class="tabs-trigger"
          >Decomposition ({data.proposals.length})</Tabs.Trigger
        >
        <Tabs.Trigger value="closure" class="tabs-trigger">Closure</Tabs.Trigger>
        <Tabs.Trigger value="sync" class="tabs-trigger"
          >Provider Sync</Tabs.Trigger
        >
        <Tabs.Trigger value="audit" class="tabs-trigger"
          >Audit ({data.audit.length})</Tabs.Trigger
        >
      </Tabs.List>

      <Tabs.Content value="tasks">
        {#if data.tasks.length === 0}
          <div class="card muted">No tasks yet.</div>
        {:else}
          <div class="card" style="padding:0">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>State</th>
                  <th>Ready</th>
                  <th>Assignee</th>
                  <th>Sync</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {#each data.tasks as task (task.id)}
                  {@const sync = taskSync(task.id)}
                  <tr>
                    <td><code>{task.id}</code></td>
                    <td>
                      <a href="/scopes/{data.scope.id}/tasks/{task.id}"
                        >{task.title}</a
                      >
                    </td>
                    <td>
                      <span class="badge state-{task.state}">{task.state}</span>
                    </td>
                    <td>
                      {#if data.readyTaskIds.includes(task.id)}
                        <span class="badge state-ready">ready</span>
                      {:else}
                        <span class="muted">—</span>
                      {/if}
                    </td>
                    <td>
                      {#if task.assignee}
                        <code>{task.assignee}</code>
                      {:else}
                        <span class="muted">unassigned</span>
                      {/if}
                    </td>
                    <td>
                      <span class="badge state-{sync?.status ?? 'pending'}"
                        >{sync?.status ?? "pending"}</span
                      >
                    </td>
                    <td class="muted"
                      >{new Date(task.updated_at).toLocaleString()}</td
                    >
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="decomposition">
        {#if data.proposals.length === 0}
          <div class="card muted">
            No decomposition proposals yet. Architect runs land here as scope
            moves through <code>draft → decomposition_proposed</code>.
          </div>
        {:else}
          <div class="stack">
            {#each data.proposals as proposal (proposal.id)}
              <div class="card stack">
                <div style="display:flex; justify-content:space-between; gap:1rem; align-items:flex-start;">
                  <div>
                    <h3 style="margin:0">
                      <code>{proposal.id}</code>
                    </h3>
                    <p class="muted" style="margin:0.25rem 0">
                      <span class="badge state-{proposal.status}"
                        >{proposal.status}</span
                      >
                      &middot; submitted {new Date(
                        proposal.created_at,
                      ).toLocaleString()}
                      &middot; brief <code>{proposal.scope_brief_version}</code>
                      &middot; scope_state_version v{proposal.scope_state_version}
                    </p>
                  </div>
                  <div class="muted" style="font-size:0.85em; text-align:right">
                    <div>packet <code>{proposal.packet_hash.slice(0, 18)}…</code></div>
                    <div>envelope <code>{proposal.envelope_hash.slice(0, 18)}…</code></div>
                  </div>
                </div>

                <dl class="kv">
                  {#if proposal.reviewer}
                    <dt>Reviewer</dt>
                    <dd>
                      <code>{proposal.reviewer}</code>
                      &middot;
                      <span class="badge state-{proposal.reviewer_result}"
                        >{proposal.reviewer_result}</span
                      >
                    </dd>
                  {/if}
                  {#if proposal.human_approved_by}
                    <dt>Human approved by</dt>
                    <dd><code>{proposal.human_approved_by}</code></dd>
                  {/if}
                  <dt>Proposed tasks</dt>
                  <dd>{proposal.proposed_tasks.length}</dd>
                  <dt>Dependencies</dt>
                  <dd>{proposal.proposed_dependencies.length}</dd>
                </dl>

                {#if proposal.proposed_tasks.length > 0}
                  <details>
                    <summary>Proposed tasks</summary>
                    <ol>
                      {#each proposal.proposed_tasks as task (task.proposed_task_id)}
                        <li>
                          <code>{task.proposed_task_id}</code> &mdash;
                          <strong>{task.title}</strong>
                          {#if task.description}
                            <p class="muted" style="margin:0.25rem 0; white-space:pre-wrap">
                              {task.description}
                            </p>
                          {/if}
                          {#if task.acceptance_criteria.length > 0}
                            <ul>
                              {#each task.acceptance_criteria as criterion}
                                <li>{criterion}</li>
                              {/each}
                            </ul>
                          {/if}
                        </li>
                      {/each}
                    </ol>
                  </details>
                {/if}

                {#if proposal.proposed_dependencies.length > 0}
                  <details>
                    <summary>Dependencies</summary>
                    <ul>
                      {#each proposal.proposed_dependencies as dep, i (i)}
                        <li>
                          <code>{dep.from_task_id}</code> →
                          <code>{dep.to_task_id}</code>
                          <span class="muted">({dep.kind})</span>
                        </li>
                      {/each}
                    </ul>
                  </details>
                {/if}

                {#if proposal.assumptions.length > 0}
                  <details>
                    <summary>Architect assumptions</summary>
                    <ul>
                      {#each proposal.assumptions as a, i (i)}
                        <li>{a}</li>
                      {/each}
                    </ul>
                  </details>
                {/if}

                {#if proposal.open_questions.length > 0}
                  <details open={proposal.status !== "committed"}>
                    <summary>Open questions ({proposal.open_questions.length})</summary>
                    <ul>
                      {#each proposal.open_questions as q, i (i)}
                        <li>{q}</li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="closure">
        {#if data.closeReadiness}
          {@const r = data.closeReadiness}
          <div class="card stack">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h2 style="margin:0">Close readiness</h2>
              <span class="badge state-{r.ready ? 'closed' : 'blocked'}">
                {r.ready ? "ready to close" : "not ready"}
              </span>
            </div>
            {#if r.reasons.length > 0}
              <ul>
                {#each r.reasons as reason}
                  <li><code>{reason}</code></li>
                {/each}
              </ul>
            {:else}
              <p class="muted" style="margin:0">
                All child tasks are closed (or canceled). The scope is eligible
                for <code>scope_review_requested</code>.
              </p>
            {/if}
            {#if r.open_task_ids.length > 0}
              <details open>
                <summary>Open tasks ({r.open_task_ids.length})</summary>
                <ul>
                  {#each r.open_task_ids as taskId}
                    <li>
                      <a href="/scopes/{data.scope.id}/tasks/{taskId}"
                        ><code>{taskId}</code></a
                      >
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if r.blocked_task_ids.length > 0}
              <details open>
                <summary>Blocked tasks ({r.blocked_task_ids.length})</summary>
                <ul>
                  {#each r.blocked_task_ids as taskId}
                    <li>
                      <a href="/scopes/{data.scope.id}/tasks/{taskId}"
                        ><code>{taskId}</code></a
                      >
                      — operator must <code>requeue</code> or
                      <code>cancel</code> via the API/CLI before close can
                      proceed.
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if r.pending_sync_task_ids.length > 0}
              <details open>
                <summary>
                  Pending provider sync ({r.pending_sync_task_ids.length})
                </summary>
                <ul>
                  {#each r.pending_sync_task_ids as taskId}
                    <li>
                      <a href="/scopes/{data.scope.id}/tasks/{taskId}"
                        ><code>{taskId}</code></a
                      >
                      — provider was unhealthy when this task last advanced;
                      reconciliation will republish on the next healthy tick.
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if r.conflict_task_ids.length > 0}
              <details open>
                <summary>
                  Conflict tasks ({r.conflict_task_ids.length})
                </summary>
                <ul>
                  {#each r.conflict_task_ids as taskId}
                    <li>
                      <a href="/scopes/{data.scope.id}/tasks/{taskId}"
                        ><code>{taskId}</code></a
                      >
                      — see audit for the conflict class; resolve via
                      <code>resolveTaskConflict</code> on the worker.
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
          </div>
        {:else}
          <div class="card muted">
            Close readiness unavailable. Re-check after the next reconcile
            tick.
          </div>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="sync">
        {#if data.providerSync}
          <div class="grid-2">
            <div class="card stack">
              <h2>Scope Mirror</h2>
              <dl class="kv">
                <dt>Status</dt>
                <dd>
                  <span class="badge state-{data.providerSync.scope.status}"
                    >{data.providerSync.scope.status}</span
                  >
                </dd>
                {#each data.providerSync.scope.mirrors as mirror (mirror.id)}
                  <dt>Provider</dt>
                  <dd>{mirror.provider}</dd>
                  <dt>Projection</dt>
                  <dd>
                    <code>{mirror.source_version ?? "unversioned"}</code>
                    {#if mirror.projected_at}
                      <span class="muted">
                        · {new Date(mirror.projected_at).toLocaleString()}</span
                      >
                    {/if}
                  </dd>
                  <dt>Issue</dt>
                  <dd>
                    {#if mirror.provider_url}
                      <a href={mirror.provider_url} target="_blank" rel="noreferrer"
                        >{mirror.provider_id}</a
                      >
                    {:else}
                      <code>{mirror.provider_id}</code>
                    {/if}
                  </dd>
                {/each}
                {#if data.providerSync.scope.mirrors.length === 0}
                  <dt>Issue</dt>
                  <dd class="muted">pending</dd>
                {/if}
              </dl>
            </div>

            <div class="card stack">
              <h2>Workflow</h2>
              <dl class="kv">
                <dt>Supervisor</dt>
                <dd><code>supervisor-{data.scope.id}</code></dd>
                <dt>State</dt>
                <dd>
                  <span class="badge state-{data.scope.state}"
                    >{data.scope.state}</span
                  >
                </dd>
                <dt>Ready</dt>
                <dd>{data.readyTaskIds.length}</dd>
                <dt>Claimed</dt>
                <dd>{data.tasks.filter((task) => task.state === "claimed").length}</dd>
              </dl>
            </div>
          </div>

          <div class="card" style="padding:0; margin-top:1rem">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Projected</th>
                  <th>Version</th>
                  <th>Provider Issue</th>
                </tr>
              </thead>
              <tbody>
                {#each data.tasks as task (task.id)}
                  {@const sync = taskSync(task.id)}
                  {@const mirror = sync?.mirrors[0]}
                  <tr>
                    <td>
                      <a href="/scopes/{data.scope.id}/tasks/{task.id}"
                        >{task.title}</a
                      >
                    </td>
                    <td>
                      <span class="badge state-{sync?.status ?? 'pending'}"
                        >{sync?.status ?? "pending"}</span
                      >
                    </td>
                    <td class="muted">
                      {#if mirror?.projected_at}
                        {new Date(mirror.projected_at).toLocaleString()}
                      {:else}
                        pending
                      {/if}
                    </td>
                    <td><code>{mirror?.source_version ?? "—"}</code></td>
                    <td>
                      {#if mirror?.provider_url}
                        <a href={mirror.provider_url} target="_blank" rel="noreferrer"
                          >{mirror.provider_id}</a
                        >
                      {:else if mirror}
                        <code>{mirror.provider_id}</code>
                      {:else}
                        <span class="muted">pending</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="card muted">Provider sync status unavailable.</div>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="audit">
        <AuditTimeline items={data.audit} />
      </Tabs.Content>
    </Tabs.Root>
  {/if}
</section>
