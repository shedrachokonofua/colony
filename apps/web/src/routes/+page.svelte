<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<section class="stack">
  <div>
    <h1>Colony Operator</h1>
    <p class="muted">API base: <code>{data.apiBase}</code></p>
  </div>

  {#if data.error}
    <div class="error">Could not reach API: {data.error}</div>
  {:else if data.body}
    <div class="card stack">
      <h2>Health</h2>
      <dl class="kv">
        <dt>Service</dt>
        <dd><strong>{data.body.service}</strong></dd>
        <dt>HTTP</dt>
        <dd>{data.status}</dd>
        <dt>DB</dt>
        <dd>
          {#if data.body.db.ok}
            <span class="badge state-active">ok</span>
          {:else}
            <span class="badge state-failed">unreachable</span>
          {/if}
          {#if data.body.db.version}
            <code>{data.body.db.version}</code>
          {/if}
          {#if data.body.db.error}
            <span class="error">{data.body.db.error}</span>
          {/if}
        </dd>
      </dl>
    </div>
  {/if}

  <p><a href="/scopes">Browse scopes →</a></p>
</section>
