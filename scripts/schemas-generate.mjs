#!/usr/bin/env node
// Regenerate checked-in schema artifacts under /schemas.
//
// Per ADR-003 and tasks.md COL-0.3a acceptance, CI runs this script then
// asserts `git diff --exit-code schemas/` is empty.
//
// Real generators land later:
//   - OpenAPI per service (apps/api, apps/webhook-dispatcher, apps/tool-gateway)
//     written to schemas/openapi/<service>.json — wired up in COL-0.9.
//   - Envelope/packet JSON Schemas from packages/schemas Zod definitions
//     written to schemas/envelopes/<name>.v<N>.json — wired up in COL-0.5.
//
// Until those land this script is a no-op so the CI staleness check exists
// from the day the pipeline ships, instead of being introduced (and forgotten)
// alongside the first generator.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(here, "..", "schemas");

await mkdir(resolve(schemasDir, "openapi"), { recursive: true });
await mkdir(resolve(schemasDir, "envelopes"), { recursive: true });

console.log(
  "schemas:generate: no generators registered yet (COL-0.5 / COL-0.9).",
);
