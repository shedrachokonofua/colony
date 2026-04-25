<script lang="ts">
  import type { AuditRecord } from "@colony/domain";

  let { items }: { items: readonly AuditRecord[] } = $props();
</script>

{#if items.length === 0}
  <p class="muted">No audit records yet.</p>
{:else}
  <ol class="timeline">
    {#each items as record (record.id)}
      <li>
        <div>
          <span class="ts">{new Date(record.recorded_at).toLocaleString()}</span>
          &nbsp;&middot;&nbsp;
          <span class="actor">{record.actor}</span>
          &nbsp;&middot;&nbsp;
          <span class="action">{record.action}</span>
          {#if record.target_kind}
            &nbsp;&middot;&nbsp;
            <span class="muted"
              >{record.target_kind}{record.target_id
                ? " " + record.target_id
                : ""}</span
            >
          {/if}
        </div>
        {#if record.previous_state || record.new_state}
          <div class="muted">
            {record.previous_state ?? "∅"} → {record.new_state ?? "∅"}
          </div>
        {/if}
        {#if record.reason}
          <div class="muted">reason: {record.reason}</div>
        {/if}
        {#if record.evidence && Object.keys(record.evidence).length > 0}
          <pre>{JSON.stringify(record.evidence, null, 2)}</pre>
        {/if}
      </li>
    {/each}
  </ol>
{/if}
