#!/usr/bin/env -S tsx
// Regenerate checked-in schema artifacts under /schemas.
//
// Per ADR-003 and COL-0.3a acceptance, CI runs this script then asserts
// `git diff --exit-code schemas/` is empty. Wiring per COL-0.5 (envelopes/
// packets) — OpenAPI per service is wired up in COL-0.9.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { SCHEMAS, type SchemaSpec } from "@colony/schemas";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(here, "..", "schemas");

const dirFor = (kind: SchemaSpec["kind"]): string =>
  resolve(schemasDir, kind === "envelope" ? "envelopes" : "packets");

await mkdir(resolve(schemasDir, "openapi"), { recursive: true });
await mkdir(resolve(schemasDir, "envelopes"), { recursive: true });
await mkdir(resolve(schemasDir, "packets"), { recursive: true });

for (const spec of SCHEMAS) {
  const raw = z.toJSONSchema(spec.schema, {
    target: "draft-2020-12",
    reused: "inline",
  }) as Record<string, unknown>;

  // Zod records `meta({ id })` under the JSON property name `id`. JSON Schema's
  // canonical identifier key is `$id`, so promote it.
  const { id: _id, ...rest } = raw;
  const ordered: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${spec.name}.v${spec.version}`,
    version: spec.version,
    ...rest,
  };

  const fileName = `${spec.name}.v${spec.version}.json`;
  const outPath = resolve(dirFor(spec.kind), fileName);
  await writeFile(outPath, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  console.log(`wrote ${spec.kind}/${fileName}`);
}

console.log(`schemas:generate: wrote ${SCHEMAS.length} schemas.`);
