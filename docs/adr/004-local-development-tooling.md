# ADR-004: Local development tooling

**Status:** Accepted
**Date:** 2026-04-24

## Context

Colony's production target is Aether-hosted Kubernetes (`design.md` §19). The local dev loop has to:

- Boot Temporal and Postgres fast and reliably, with the three required databases (`temporal`, `temporal_visibility`, `colony`).
- Run five Node apps (`apps/api`, `apps/worker`, `apps/webhook-dispatcher`, `apps/tool-gateway`, `apps/web`) with watch-mode reloads.
- Point at a real GitLab — the home-lab GitLab instance over the LAN — because GitLab CE is the only provider at MVP and is already running there (`design.md:1069`).
- Avoid maintaining a second Kubernetes cluster locally. Kubernetes validation happens on Aether in a `colony-dev` namespace (ADR-007).
- Keep toolchain versions reproducible across developers and CI.

## Decision

- **Toolchain:** `nix develop` via `flake.nix` provides Node.js 24, npm, Temporal CLI, Postgres client tools, kubectl, Helm, GitLab CLI, Prettier, Buildah/Podman, and any generators CI expects.
- **Infrastructure:** `docker-compose.yml` at the repo root boots Temporal (server + UI) and Postgres with the three databases initialized. Named volumes persist state between restarts.
- **App processes:** each app runs via `npm run dev` as a native Node (or Vite) watch process — not in a container, not in Kubernetes. API services use `tsx watch`, the SvelteKit web app uses `vite dev`, the worker uses `tsx watch` on the Temporal worker entrypoint.
- **Process orchestration:** a root `npm run dev` starts all app watchers concurrently (`npm-run-all2 --parallel`, no extra tooling required — npm workspaces handle per-package scripts).
- **Provider backend:** default `npm run dev` points the provider adapter at the home-lab GitLab over the LAN, using a dedicated Colony dev project and a separate bot token. The fake provider adapter (COL-1.1) is reserved for unit/contract tests, not interactive dev.

## Alternatives Considered

- **`kind` / `minikube` / `k3d` locally.** Would exercise k8s assumptions but diverges from Aether (no Talos, different CNI, different Gateway API implementation). The chart gets tested on Aether's `colony-dev` instead — one real cluster beats two mediocre ones. Image-build-per-change also destroys the inner-loop speed.
- **Tilt / Skaffold / Devbox against a local cluster.** Same problem as above — optimizes a k8s loop we don't need locally.
- **Docker Compose for apps too.** Would work but adds image-rebuild or volume-mount-hot-reload complexity that `tsx watch` avoids. Apps are TypeScript and run fine directly.
- **Process manager (pm2, foreman, overmind).** Solves orchestration but adds a dep. `npm -ws run dev` plus `npm-run-all2 --parallel` is sufficient.
- **Self-hosted GitLab in Compose.** GitLab CE is multi-GB RAM and slow to boot. The home-lab instance already exists and is reachable.
- **Fake provider as default dev backend.** Faster cold start, zero external dependency. Demoted to test-only because the home-lab GitLab is already reachable and fake/real drift is a real bug source.

## Rationale

Optimize the inner loop. Compose handles the infra services we don't edit; native Node processes handle the app code we do edit. Real GitLab over LAN removes a class of fake/real drift bugs. No local k8s removes a whole toolchain we would have to maintain in parallel to the Aether one.

## Consequences

- Every app ships a `dev` script in its `package.json`. The watcher choice is documented (`tsx watch` for services, `vite dev` for web).
- Root `package.json` has a `dev` script that runs all app dev servers in parallel.
- A `docker-compose.yml` committed at the repo root boots Temporal + Postgres + Temporal UI. A `db:init` script applies Postgres role and database creation.
- `.env.example` at the repo root documents required env vars (DB URL, Temporal address, GitLab URL, GitLab token, webhook secret, service ports). A real `.env` is gitignored.
- Developers need Docker/Podman available outside the Nix shell. The dev shell cannot supply Docker on its own; this is a documented prerequisite.
- Home-lab GitLab config — dedicated group, bot token, webhook URL pointing at the laptop's LAN address — is an operator setup step documented in `docs/dev-loop.md`.
- Kubernetes testing lives entirely on Aether `colony-dev` (ADR-007). No local cluster is maintained.

## Revisit When

- The app process count grows past what a flat `--parallel` can reasonably run (say, more than ten services).
- We need to exercise agent-sandbox controller behavior in a way that requires local Kubernetes (first candidate: writing new `SandboxTemplate` CRDs that would churn the Aether cluster).
- The home-lab GitLab becomes unreliable enough that local dev needs an alternative.
- Compose runtime (Docker Desktop / Podman / Colima) introduces enough platform drift that we need a better abstraction.
