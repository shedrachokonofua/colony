<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<section class="stack">
  <div>
    <h1>Scopes</h1>
    <p class="muted">{data.scopes.length} scope(s)</p>
  </div>

  {#if data.error}
    <div class="error">{data.error}</div>
  {/if}

  {#if data.scopes.length === 0 && !data.error}
    <div class="card muted">No scopes yet.</div>
  {:else}
    <div class="card" style="padding:0">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>State</th>
            <th>Version</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {#each data.scopes as scope (scope.id)}
            <tr>
              <td><code>{scope.id}</code></td>
              <td><a href="/scopes/{scope.id}">{scope.title}</a></td>
              <td><span class="badge state-{scope.state}">{scope.state}</span></td>
              <td>{scope.state_version}</td>
              <td class="muted">{new Date(scope.updated_at).toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
