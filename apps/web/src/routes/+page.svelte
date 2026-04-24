<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<main>
  <h1>Colony — Operator</h1>
  <p>API base: <code>{data.apiBase}</code></p>

  {#if data.error}
    <p style="color: crimson">Could not reach API: {data.error}</p>
  {:else if data.body}
    <p>
      Service: <strong>{data.body.service}</strong>
      &nbsp;|&nbsp; HTTP <strong>{data.status}</strong>
    </p>
    <p>
      DB ok: <strong>{data.body.db.ok}</strong>
      {#if data.body.db.version}
        <br /><code>{data.body.db.version}</code>
      {/if}
      {#if data.body.db.error}
        <br /><span style="color: crimson">{data.body.db.error}</span>
      {/if}
    </p>
  {/if}
</main>

<style>
  main {
    font-family: system-ui, sans-serif;
    max-width: 640px;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
