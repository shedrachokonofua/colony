<script lang="ts">
  import type { PageData } from "./$types";
  import { Tabs } from "bits-ui";
  import AuditTimeline from "$lib/AuditTimeline.svelte";

  let { data }: { data: PageData } = $props();
  let tab = $state<"tasks" | "sync" | "audit">("tasks");

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

  {#if data.scope}
    {#if data.scope.description}
      <div class="card">
        <p style="margin:0; white-space:pre-wrap">{data.scope.description}</p>
      </div>
    {/if}

    <Tabs.Root bind:value={tab}>
      <Tabs.List class="tabs-list">
        <Tabs.Trigger value="tasks" class="tabs-trigger"
          >Tasks ({data.tasks.length})</Tabs.Trigger
        >
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
