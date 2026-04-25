<script lang="ts">
  import type { PageData } from "./$types";
  import { Tabs } from "bits-ui";
  import AuditTimeline from "$lib/AuditTimeline.svelte";

  let { data }: { data: PageData } = $props();
  let tab = $state<"tasks" | "audit">("tasks");
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
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {#each data.tasks as task (task.id)}
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

      <Tabs.Content value="audit">
        <AuditTimeline items={data.audit} />
      </Tabs.Content>
    </Tabs.Root>
  {/if}
</section>
