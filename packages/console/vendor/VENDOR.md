# Vendored UI dependencies

`lit@3.3.3` and its runtime packages, copied from root
`node_modules` by `bun run vendor:ui` (scripts/vendor-ui.ts) so the
no-build console can import lit from `/ui/vendor/` with no bundler, no
CDN and no import map: every specifier inside the trees is rewritten to
a vendored relative path.

| Package | Version |
| ------- | ------- |
| lit | 3.3.3 |
| @lit-labs/ssr-dom-shim | 1.6.0 |
| @lit/reactive-element | 2.1.2 |
| lit-element | 4.2.2 |

Do not hand-edit; regenerate after changing lit versions in the root
package.json:

```
bun run vendor:ui
```

The legacy pre-bundled `vendor/lit-html.js` that `app.js` imports is not
part of these trees; switching the console onto them is a later task in
this scope.
