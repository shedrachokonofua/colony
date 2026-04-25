<script lang="ts">
  import { page } from "$app/state";
  import type { Snippet } from "svelte";
  import type { LayoutServerData } from "./$types";
  import "./styles.css";

  let { data, children }: { data: LayoutServerData; children: Snippet } =
    $props();

  const navLinks = [
    { href: "/", label: "Home" },
    { href: "/scopes", label: "Scopes" },
  ];

  function isActive(href: string): boolean {
    if (href === "/") return page.url.pathname === "/";
    return page.url.pathname === href || page.url.pathname.startsWith(href + "/");
  }
</script>

<div class="app">
  <header>
    <div class="brand">Colony</div>
    <nav>
      {#each navLinks as link (link.href)}
        <a href={link.href} class:active={isActive(link.href)}>{link.label}</a>
      {/each}
    </nav>
    <div class="actor">
      <span class="label">Actor</span>
      <code>{data.actor}</code>
    </div>
  </header>

  <main>
    {@render children()}
  </main>
</div>
