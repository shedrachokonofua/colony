/**
 * Temporal workflow-safe package.
 *
 * Keep this package deterministic: no database clients, provider clients,
 * wall-clock reads, process/env access, random values, network calls, or Pi
 * runtime integration. Side effects belong in activities outside this package.
 */
export const COLONY_WORKFLOWS_PACKAGE = "@colony/workflows" as const;
