#!/usr/bin/env -S tsx
// Emits a checked-in OpenAPI 3.1 document for the Colony API (COL-0.9).
// CI runs `npm run openapi:check` so the contract cannot drift invisibly.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../apps/api/src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "schemas", "openapi");
const outFile = resolve(outDir, "colony-api.json");

const app = buildApp();
const res = await app.request("http://x/openapi.json");
if (!res.ok) {
  throw new Error(`GET /openapi.json -> ${res.status}`);
}
const doc = await res.json();
await mkdir(outDir, { recursive: true });
await writeFile(outFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`Wrote ${outFile}`);
