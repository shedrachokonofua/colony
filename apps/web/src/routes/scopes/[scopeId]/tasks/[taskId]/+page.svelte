<script lang="ts">
  import type { PageData } from "./$types";
  import { Tabs } from "bits-ui";
  import AuditTimeline from "$lib/AuditTimeline.svelte";

  let { data }: { data: PageData } = $props();
  let tab = $state<"overview" | "audit">("overview");
  const mirror = $derived(data.providerSync?.mirrors[0]);
</script>

<section class="stack">
  <div>
    <p class="muted">
      <a href="/scopes/{data.scopeId}">← Back to scope</a>
    </p>
    {#if data.task}
      <h1>{data.task.title}</h1>
      <p class="muted">
        <code>{data.task.id}</code>
        &middot;
        <span class="badge state-{data.task.state}">{data.task.state}</span>
        &middot; state v{data.task.state_version}
        &middot; claim v{data.task.claim_version}
      </p>
    {/if}
  </div>

  {#if data.loadError}
    <div class="error">{data.loadError}</div>
  {/if}

  {#if data.task}
    <Tabs.Root bind:value={tab}>
      <Tabs.List class="tabs-list">
        <Tabs.Trigger value="overview" class="tabs-trigger">Overview</Tabs.Trigger>
        <Tabs.Trigger value="audit" class="tabs-trigger"
          >Audit ({data.audit.length})</Tabs.Trigger
        >
      </Tabs.List>

      <Tabs.Content value="overview">
        <div class="grid-2">
          <div class="card stack">
            <h2>Assignment</h2>
            <dl class="kv">
              <dt>State</dt>
              <dd>
                <span class="badge state-{data.task.state}">{data.task.state}</span>
              </dd>
              <dt>Assignee</dt>
              <dd>
                {#if data.task.assignee}
                  <code>{data.task.assignee}</code>
                {:else}
                  <span class="muted">unassigned</span>
                {/if}
              </dd>
              <dt>Created</dt>
              <dd class="muted">{new Date(data.task.created_at).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd class="muted">{new Date(data.task.updated_at).toLocaleString()}</dd>
            </dl>
          </div>

          <div class="card stack">
            <h2>Provider Sync</h2>
            <dl class="kv">
              <dt>Status</dt>
              <dd>
                <span class="badge state-{data.providerSync?.status ?? 'pending'}"
                  >{data.providerSync?.status ?? "pending"}</span
                >
              </dd>
              <dt>Projected</dt>
              <dd class="muted">
                {#if mirror?.projected_at}
                  {new Date(mirror.projected_at).toLocaleString()}
                {:else}
                  pending
                {/if}
              </dd>
              <dt>Version</dt>
              <dd><code>{mirror?.source_version ?? "—"}</code></dd>
              <dt>Issue</dt>
              <dd>
                {#if mirror?.provider_url}
                  <a href={mirror.provider_url} target="_blank" rel="noreferrer"
                    >{mirror.provider_id}</a
                  >
                {:else if mirror}
                  <code>{mirror.provider_id}</code>
                {:else}
                  <span class="muted">pending</span>
                {/if}
              </dd>
            </dl>
          </div>

          <div class="card stack">
            <h2>Dependencies</h2>
            <div>
              <strong>Blocked by</strong>
              {#if data.deps.blocked_by.length === 0}
                <span class="muted"> — none</span>
              {:else}
                <ul>
                  {#each data.deps.blocked_by as dep (dep)}
                    <li>
                      <a href="/scopes/{data.scopeId}/tasks/{dep}"
                        ><code>{dep}</code></a
                      >
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
            <div>
              <strong>Blocks</strong>
              {#if data.deps.blocks.length === 0}
                <span class="muted"> — none</span>
              {:else}
                <ul>
                  {#each data.deps.blocks as dep (dep)}
                    <li>
                      <a href="/scopes/{data.scopeId}/tasks/{dep}"
                        ><code>{dep}</code></a
                      >
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          </div>
        </div>

        {#if data.task.description}
          <div class="card" style="margin-top:1rem">
            <h2>Description</h2>
            <p style="margin:0; white-space:pre-wrap">{data.task.description}</p>
          </div>
        {/if}

        {#if data.task.acceptance_criteria.length > 0}
          <div class="card" style="margin-top:1rem">
            <h2>Acceptance</h2>
            <ul>
              {#each data.task.acceptance_criteria as a (a)}
                <li>{a}</li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if data.task.non_goals.length > 0}
          <div class="card" style="margin-top:1rem">
            <h2>Non-goals</h2>
            <ul>
              {#each data.task.non_goals as a (a)}
                <li>{a}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="audit">
        <AuditTimeline items={data.audit} />
      </Tabs.Content>
    </Tabs.Root>
  {/if}
</section>
