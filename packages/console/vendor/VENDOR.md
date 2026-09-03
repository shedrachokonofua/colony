# Vendored UI dependencies

`lit@3.3.3` and its runtime packages, copied from root
`node_modules` by `bun run vendor:ui` (scripts/vendor-ui.ts) so the
no-build console can import lit from `/ui/vendor/` with no bundler and
no CDN: the page's import map maps bare specifiers to these trees and
every specifier inside them is rewritten to a vendored relative path.

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

The legacy pre-bundled `vendor/lit-html.js` was removed from the tree
once the console switched to these packages (see the import map in
`packages/console/index.html`); keep it deleted after regenerating.
