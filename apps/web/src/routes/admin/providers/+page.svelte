<script lang="ts">
  import type { PageData } from "./$types";

  let { data, form }: { data: PageData; form?: Record<string, unknown> | null } = $props();

  function statusLabel(status: string | undefined): string {
    if (!status) return "never";
    return status;
  }

  // When the start action just returned, surface the authorize URL + session id
  // for the matching provider so the operator can finish the flow without
  // leaving the page. The paste form is a fallback; Pi normally persists after
  // the localhost callback succeeds.
  function pendingFor(providerKey: string): {
    sessionId: string;
    authorizeUrl: string;
    instructions: string | null;
    expiresAt: string;
  } | null {
    if (!form) return null;
    if (form.action !== "start") return null;
    if (form.provider_key !== providerKey) return null;
    if (!form.session_id || !form.authorize_url || !form.expires_at) return null;
    return {
      sessionId: String(form.session_id),
      authorizeUrl: String(form.authorize_url),
      instructions: form.instructions ? String(form.instructions) : null,
      expiresAt: String(form.expires_at),
    };
  }

  function noticeFor(providerKey: string): string | null {
    if (!form) return null;
    if (form.provider_key !== providerKey) return null;
    if (typeof form.notice !== "string") return null;
    return form.notice;
  }

  function errorFor(providerKey: string): string | null {
    if (!form) return null;
    if (form.provider_key && form.provider_key !== providerKey) return null;
    if (typeof form.error !== "string") return null;
    return form.error;
  }
</script>

<section class="providers">
  <h1>Provider OAuth Connections</h1>
  <p class="hint">
    Connect Colony's agent runtime to subscription-backed providers (ChatGPT
    Plus / Codex, Claude Pro). API-key providers are configured in
    <code>config/colony.yaml</code> and don't appear here.
  </p>

  {#if data.denied}
    <div class="banner denied">
      You don't have <code>provider.oauth.connect</code>. Ask an admin to
      grant the capability before connecting providers.
    </div>
  {/if}
  {#if data.error}
    <div class="banner error">{data.error}</div>
  {/if}

  {#if !data.denied && data.providers.length === 0}
    <div class="banner empty">
      No OAuth-capable providers configured. Add a
      <code>kind: oauth</code> provider entry to <code>config/colony.yaml</code>.
    </div>
  {/if}

  <div class="list">
    {#each data.providers as provider (provider.key)}
      {@const pending = pendingFor(provider.key)}
      {@const notice = noticeFor(provider.key)}
      {@const error = errorFor(provider.key)}
      <article class="provider">
        <header>
          <h2>{provider.key}</h2>
          <span class="api">{provider.api}</span>
          {#if provider.subscription}
            <span class="subscription">{provider.subscription}</span>
          {/if}
        </header>

        <dl class="meta">
          <dt>Models</dt>
          <dd>
            {#if provider.models.length === 0}
              <em>none</em>
            {:else}
              {provider.models.map((m) => m.name).join(", ")}
            {/if}
          </dd>
          <dt>Status</dt>
          <dd
            class="status status-{provider.connection?.status ?? 'never'}"
          >
            {statusLabel(provider.connection?.status)}
          </dd>
          {#if provider.connection}
            <dt>Granted by</dt>
            <dd><code>{provider.connection.granted_by}</code></dd>
            <dt>Granted at</dt>
            <dd>{provider.connection.granted_at}</dd>
            {#if provider.connection.refreshed_at}
              <dt>Refreshed</dt>
              <dd>{provider.connection.refreshed_at}</dd>
            {/if}
            {#if provider.connection.expires_at}
              <dt>Expires</dt>
              <dd>{provider.connection.expires_at}</dd>
            {/if}
            {#if provider.connection.revoked_at}
              <dt>Revoked at</dt>
              <dd>{provider.connection.revoked_at}</dd>
            {/if}
          {/if}
        </dl>

        {#if notice}
          <div class="banner notice">{notice}</div>
        {/if}
        {#if error}
          <div class="banner error">{error}</div>
        {/if}

        <div class="actions">
          {#if !pending}
            <form method="POST" action="?/start">
              <input type="hidden" name="provider_key" value={provider.key} />
              <button type="submit" class="primary">
                {provider.connection?.status === "active" ? "Reconnect" : "Connect"}
              </button>
            </form>
            {#if provider.connection?.status === "active" || provider.connection?.status === "expired"}
              <form method="POST" action="?/revoke">
                <input
                  type="hidden"
                  name="provider_key"
                  value={provider.key}
                />
                <button type="submit" class="danger">Disconnect</button>
              </form>
            {/if}
          {/if}
        </div>

        {#if pending}
          <div class="pending">
            <p>
              Open the authorize URL in a new browser tab. After you consent
              and see <code>Authentication successful</code>, return here and
              refresh; the connection should show active. If it does not change
              before <code>{pending.expiresAt}</code>, paste the callback URL
              or just the <code>code</code> parameter below.
            </p>
            {#if pending.instructions}
              <p class="hint">{pending.instructions}</p>
            {/if}
            <p>
              <a href={pending.authorizeUrl} target="_blank" rel="noopener">
                Open authorize URL
              </a>
            </p>
            <form method="POST" action="?/submit" class="submit-form">
              <input
                type="hidden"
                name="provider_key"
                value={provider.key}
              />
              <input
                type="hidden"
                name="session_id"
                value={pending.sessionId}
              />
              <label>
                Pasted code or full callback URL
                <textarea name="code" required rows="3"></textarea>
              </label>
              <div class="row">
                <button type="submit" class="primary">Submit code</button>
              </div>
            </form>
            <form method="POST" action="?/cancel" class="cancel-form">
              <input
                type="hidden"
                name="provider_key"
                value={provider.key}
              />
              <input
                type="hidden"
                name="session_id"
                value={pending.sessionId}
              />
              <button type="submit" class="link">Cancel session</button>
            </form>
          </div>
        {/if}
      </article>
    {/each}
  </div>
</section>

<style>
  .providers {
    display: grid;
    gap: 1.5rem;
    max-width: 64rem;
    padding: 1.5rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
  }
  .hint {
    color: #666;
    font-size: 0.875rem;
    margin: 0;
  }
  .banner {
    padding: 0.75rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }
  .banner.denied,
  .banner.error {
    background: #fee2e2;
    color: #991b1b;
  }
  .banner.notice {
    background: #dcfce7;
    color: #166534;
  }
  .banner.empty {
    background: #f3f4f6;
    color: #374151;
  }
  .list {
    display: grid;
    gap: 1rem;
  }
  .provider {
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    padding: 1rem;
    display: grid;
    gap: 0.75rem;
  }
  .provider header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .provider header h2 {
    margin: 0;
    font-size: 1.125rem;
  }
  .api,
  .subscription {
    font-size: 0.75rem;
    color: #6b7280;
    background: #f3f4f6;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
  }
  dl.meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  dl.meta dt {
    color: #6b7280;
    font-size: 0.875rem;
  }
  dl.meta dd {
    margin: 0;
    font-size: 0.875rem;
  }
  .status-never {
    color: #6b7280;
  }
  .status-active {
    color: #166534;
    font-weight: 600;
  }
  .status-expired {
    color: #92400e;
  }
  .status-revoked {
    color: #991b1b;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button.primary {
    background: #1d4ed8;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  button.primary:hover {
    background: #1e40af;
  }
  button.danger {
    background: white;
    color: #991b1b;
    border: 1px solid #fca5a5;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  button.danger:hover {
    background: #fef2f2;
  }
  button.link {
    background: none;
    border: none;
    color: #6b7280;
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
    font-size: 0.875rem;
  }
  .pending {
    border-top: 1px dashed #d1d5db;
    padding-top: 0.75rem;
    display: grid;
    gap: 0.75rem;
  }
  .submit-form label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: #374151;
  }
  .submit-form textarea {
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    resize: vertical;
  }
  .submit-form .row {
    display: flex;
    gap: 0.5rem;
  }
  code {
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
  }
</style>
