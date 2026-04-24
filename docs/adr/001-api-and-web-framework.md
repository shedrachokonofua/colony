# ADR-001: API and Web framework selection

**Status:** Accepted
**Date:** 2026-04-24

## Context

Colony's control plane is a TypeScript monorepo (`design.md` §6, §19). It needs:

- An HTTP API served by `apps/api`, `apps/webhook-dispatcher`, and `apps/tool-gateway`.
- OpenAPI-generated contracts so agents, the Web UI, and external operators consume stable typed endpoints (`design.md:1053`).
- An operator Web UI (`apps/web`) separate from the API, per the "Task Graph API Deployment (same binary as Web UI/API in MVP, separate route prefix)" note in `design.md:1011` — the binary split is the **API side** only; the **frontend** is a distinct app.
- Zod as the single schema library end-to-end, driving both envelope validation and HTTP bodies (ADR-003).

The reference implementation we want to mirror is `~/projects/seven30/foundry`, which pairs Hono + `@hono/zod-openapi` + `@scalar/hono-api-reference` with a SvelteKit host.

## Decision

- **API framework:** Hono on `@hono/node-server` for `apps/api`, `apps/webhook-dispatcher`, and `apps/tool-gateway`. OpenAPI generated via `@hono/zod-openapi`. Docs UI via `@scalar/hono-api-reference`.
- **Web framework:** SvelteKit (Svelte 5) with `@sveltejs/adapter-node` for `apps/web`. The web app is a pure frontend; it calls `apps/api` over HTTP and does not host backend routes.

## Alternatives Considered

- **Express / Fastify for the API.** Mature, well-known. Rejected because `@hono/zod-openapi` is the most direct path from Zod schemas to an OpenAPI document in the Node ecosystem, and Hono's middleware and context model are simpler than Express for the small number of cross-cutting concerns we need (auth, capability check, audit, OTel). Fastify + `fastify-zod` is the closest rival but doubles the tooling surface vs. Foundry's stack.
- **NestJS.** Provides structure but imposes decorator/module conventions that add ceremony without buying us anything for a service that's mostly "validate envelope → call service layer → return JSON."
- **Merge API into SvelteKit** (foundry's shape). Foundry does this because it's one app. Colony has three separate HTTP services (`apps/api`, `apps/webhook-dispatcher`, `apps/tool-gateway`) plus the frontend, so merging would force us to either run SvelteKit for services that don't need a frontend or introduce an inconsistent split.
- **React/Next.js for `apps/web`.** Would work. SvelteKit picked for smaller bundle, first-class form actions, simpler server/client boundary, and parity with Foundry.
- **Solid/Qwik/Astro for `apps/web`.** Too novel for a project where the UI is table-heavy, form-heavy, and not performance-critical.

## Rationale

Hono + `@hono/zod-openapi` is the shortest path from a Zod schema to a typed client, OpenAPI doc, and runtime validation. The Scalar docs UI is one import. Foundry has already validated this stack in production for a similar problem shape (typed API + OpenAPI docs + Zod). SvelteKit is the Web UI default at seven30 and cuts onboarding cost.

Keeping the API standalone from SvelteKit preserves the `design.md` topology: three small HTTP services, one frontend, all runnable as independent processes in `npm run dev`.

## Consequences

- Every HTTP handler authors with `@hono/zod-openapi`'s `createRoute` + `OpenAPIHono`. The schema package exports Zod objects that are reused at the wire, in agent envelope validation, and in DB JSON column checks.
- The Web UI is separate from the API binary, so CORS / auth / dev proxying must be handled (local dev: Vite proxy or permissive CORS; prod: both behind the same Aether Gateway API with HTTPRoute rules).
- One OpenAPI document is served per API service at `/openapi.json`, with Scalar at `/docs`. Clients (Web UI, agents, operator tools) generate typed clients from those.
- Svelte 5's runes API is still evolving but stable enough for 4.x-style component code; we take the churn in exchange for the ecosystem momentum.

## Revisit When

- Hono or `@hono/zod-openapi` stalls for six-plus months with no releases while Zod or OpenAPI versions move.
- We need streaming / gRPC / bidirectional channels that force a runtime Hono cannot model cleanly.
- SvelteKit's adapter-node stops receiving security updates or a platform limitation blocks an Aether deployment (e.g. Vite SSR + our observability stack incompatibility).
