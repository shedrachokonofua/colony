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

  <form method="POST" action="?/create" class="card stack">
    <div>
      <h2 style="margin:0">New scope</h2>
      <p class="muted" style="margin:0.25rem 0 0">
        Create a draft scope against a registered provider project.
      </p>
    </div>
    <div class="grid-2">
      <label>
        <span>Scope ID</span>
        <input name="id" placeholder="col-myproj" required pattern={"col-[a-z0-9]{4,}"} />
      </label>
      <label>
        <span>Provider project</span>
        <select name="provider_project_id">
          <option value="">No provider target</option>
          {#each data.providerProjects as project (project.id)}
            <option value={project.id}>{project.provider}: {project.path}</option>
          {/each}
        </select>
      </label>
    </div>
    <label>
      <span>Title</span>
      <input name="title" required />
    </label>
    <label>
      <span>Description</span>
      <textarea name="description" rows="4"></textarea>
    </label>
    <label class="inline">
      <input type="checkbox" name="mirror_scope" checked />
      <span>Mirror scope to the provider project</span>
    </label>
    <div>
      <button type="submit">Create scope</button>
    </div>
  </form>

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
