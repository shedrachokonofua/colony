# schemas/

Generated, **checked-in** schema artifacts. Do not hand-edit. Regenerate with:

```sh
npm run schemas:generate
npm run openapi:generate
```

CI fails if the regenerated output differs from what's committed (`schemas:check`, `openapi:check`; ADR-003, ADR-006, COL-0.3a).

Layout:

| Path                         | Source                                                       | Owner task |
| ---------------------------- | ------------------------------------------------------------ | ---------- |
| `openapi/colony-api.json`    | `apps/api` (`scripts/openapi-generate.ts`, `buildApp`)       | COL-0.9    |
| `envelopes/<name>.v<N>.json` | `packages/schemas` Zod definitions via `z.toJSONSchema(...)` | COL-0.5    |
