# schemas/

Generated, **checked-in** schema artifacts. Do not hand-edit. Regenerate with:

```sh
npm run schemas:generate
```

CI fails if the regenerated output differs from what's committed (ADR-003, ADR-006, COL-0.3a).

Layout:

| Path                         | Source                                                       | Owner task |
| ---------------------------- | ------------------------------------------------------------ | ---------- |
| `openapi/<service>.json`     | `apps/<service>` route definitions via `@hono/zod-openapi`   | COL-0.9    |
| `envelopes/<name>.v<N>.json` | `packages/schemas` Zod definitions via `z.toJSONSchema(...)` | COL-0.5    |

Until COL-0.5 / COL-0.9 land, the generator is intentionally a no-op (`scripts/schemas-generate.mjs`) so the staleness check exists from the start of the CI pipeline.
