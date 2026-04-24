# ADR-005: TypeScript monorepo conventions

**Status:** Accepted
**Date:** 2026-04-24

## Context

Colony is one TypeScript monorepo (`design.md` §6, §19). It holds five runtime apps and eleven shared packages (`tasks.md` COL-0.1). The monorepo must support:

- A short inner loop (edit → run → see in the UI within seconds).
- A strict separation between Temporal **workflow-safe** code and everything else, because workflows must be deterministic (no clocks, no randomness, no I/O; `tasks.md:50`).
- Shared schemas consumed by every service.
- Typecheck, lint, format, test at the root in one command.
- Clean CI images — services build to distinct containers without dragging unrelated packages.

## Decision

- **Package manager:** npm with workspaces (`"workspaces": ["apps/*", "packages/*"]`).
- **Node version:** 24 LTS (current active), pinned by Nix and enforced by `"engines": { "node": ">=24" }`.
- **Module system:** ESM only (`"type": "module"` everywhere). `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"verbatimModuleSyntax": true`, `"isolatedModules": true`.
- **TypeScript:** a shared `tsconfig.base.json` sets strict/noImplicitAny/verbatimModuleSyntax/etc. Each package extends it.
- **Package naming:** `@colony/<package-name>`, with the filesystem path matching the package name tail (`packages/schemas` → `@colony/schemas`).
- **Shared packages live in `packages/`; runtime entrypoints live in `apps/`.** Apps depend on packages; packages do not depend on apps.
- **Workflow isolation:** `packages/workflows` exports only workflow-safe code. It must not import any package that touches DB, provider clients, the tool gateway, Pi SDKs, `process.env`, `Math.random`, or wall-clock time. A checked-in ESLint rule enforces the boundary; a package-level `package.json` field lists the forbidden deps for lint/test to read.
- **Entrypoints:** every package exports from `src/index.ts` via `"exports": { ".": "./src/index.ts" }`. Apps build to `dist/` for containerization.
- **Scripts:** every package defines `dev`, `build`, `test`, `lint`, `typecheck`. The root aggregates via `npm -ws run <script>` and workflow-specific commands via `npm-run-all2`.
- **Testing:** Vitest at root (`vitest run`). Per-package test files live alongside source (`foo.test.ts`).
- **Lint/format:** ESLint with `typescript-eslint`, Prettier for formatting. Both configured at the root; packages do not redefine.

## Alternatives Considered

- **pnpm / yarn.** pnpm is ergonomically better for large monorepos (disk usage, strict dep resolution). npm wins on zero-config CI, out-of-the-box Node support, and one-less-tool-in-the-shell. We accept pnpm's advantages if the repo grows past ~30 workspaces.
- **Turborepo / Nx.** Useful for large monorepos where build graphs and caching matter. Colony is small enough that `npm -ws run build` is fine. Revisit if CI runtime becomes a bottleneck.
- **`tsc --build` project references.** Stricter boundary enforcement, but slower dev loop and awkward with ESM resolution. We rely on `tsx` for dev and `tsc --noEmit` for typecheck only; per-package build tooling is simpler.
- **Bundling everything into one app.** Rejected — the apps have different scaling/process characteristics and different sandbox profiles.
- **Package version coupling via `*` vs. explicit versions.** We use `*` for inner deps because the repo ships as one unit; no independent versioning.

## Rationale

- npm + workspaces is the lowest-friction default for a 5-app, 11-package repo.
- ESM + `NodeNext` avoids the CJS/ESM dual-package hazard entirely.
- Strict workflow isolation is a correctness requirement, not a style choice — workflow determinism is how Temporal replays survive a worker restart (`design.md` §9). An ESLint rule + a package-local disallow list catches violations before they ship.
- Shared Zod schemas in `packages/schemas` let HTTP handlers, agents, and DB adapters validate against the same source.

## Consequences

- Every new package adds one `package.json` (with `dev`, `build`, `test`, `lint`, `typecheck`), one `tsconfig.json` extending base, and one `src/index.ts`. No Lerna/Changesets/build-graph overhead.
- `packages/workflows` has an eslint override enforcing the isolation. A test loads all files in `packages/workflows/src` and asserts none of them imports a forbidden package.
- CI image builds use per-app Dockerfiles that `COPY` only the app dir and its dep graph. This requires either `npm -w <app> ci --include-workspace-root` style builds or a build script that prunes the install set. Detail belongs in ADR-006.
- Refactors that touch Zod schemas must regenerate `/schemas/` artifacts and pass the CI staleness check (ADR-003).

## Revisit When

- Workspace count exceeds ~25 and CI install/typecheck times balloon → evaluate pnpm + Turborepo.
- A package develops its own release cadence that no longer fits the monorepo's one-version-of-everything model.
- The workflow isolation rule is repeatedly violated despite lint — at which point we move `packages/workflows` into its own repo.
