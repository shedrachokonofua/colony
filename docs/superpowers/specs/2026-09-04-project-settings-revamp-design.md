# Project Settings Revamp

## Status

Approved for design revision in chat on 2026-09-04. This document replaces the recovered `project-settings-revamp.md` draft from the 2026-08-30 session.

## Goal

Replace the project Settings tab and separate project-files page with one coherent settings surface for the project brief, reference files, and project lifecycle actions. The surface must support real file editing, report server-authoritative storage limits, work identically in demo mode, and use a strict border hierarchy with no nested card stack.

## Current Problems

- Settings is a two-card responsive grid. The editable brief and read-only repository summary look like peer settings even though they have different behavior.
- Project files live on a separate route. The add form is below the list, editing is a blind whole-file replacement because list responses omit content and no GET-by-ID route exists, and there is no upload-from-disk flow.
- File rows and forms add full borders and radii inside already bordered cards. Structural and interactive borders have no hierarchy.
- The UI does not disclose the 256 KiB per-file or 2 MiB per-project limits enforced by colonyd.
- Summing a paginated file list cannot produce honest project storage usage.
- Archive and unarchive live in the project header instead of Settings.
- Demo file mutations do not match the server's validation, limits, or content-loading behavior.

## User-Facing Model

The Settings tab contains one surface with three sections in this order:

1. **Brief** — Markdown background included in every agent packet for the project.
2. **Files** — Text reference files materialized at `.colony/project/<filename>` in every agent workspace for the project, next to the brief.
3. **Project** — Read-only repository history plus archive or unarchive.

The explanatory sentence shown in the Files section is:

> Every file is placed at `.colony/project/<filename>` in each agent workspace for this project, next to the brief, so agents can read it as project background.

## Visual System

Settings is one `.project-settings-surface`, not a grid of cards.

- The surface has one `1px solid var(--line)` outer border, `var(--card)` background, and `var(--r-card)` radius.
- Brief, Files, and Project are vertically stacked. Adjacent sections are separated by exactly one `1px solid var(--line)` horizontal divider.
- Section headers, help text, repository metadata, empty states, save statuses, and file-list containers have no enclosing border.
- File rows use a bottom divider only. The final row has no divider.
- The open file editor is the only inset surface. It uses `var(--wash)`, one `1px solid var(--line)` border, and `var(--r-ctl)` radius.
- Inputs, textareas, selects, and buttons retain the existing control border and `var(--r-ctl)` radius.
- Chips alone use `var(--r-chip)`.
- `var(--line)` communicates structure. `var(--line-strong)` is reserved for interactive control boundaries and hover/focus emphasis.
- A danger-colored border appears only on an active destructive confirmation. Read-only or inactive content never receives a danger border.
- No edge may combine the surface border, a nested card border, and a section divider. No section becomes a separate card at mobile widths.
- Desktop and mobile use the same hierarchy. Mobile stacks editor fields and actions at full width without horizontal overflow.

## Server and Core Interfaces

### Store

Add a project-owned lookup to `Store`:

```ts
getProjectFile(projectName: string, id: string): ProjectFile | undefined
```

It returns a full row including `content` only when both the project name and file ID match. Unknown and foreign-project IDs return `undefined`.

Extend `pageProjectFiles()` to return aggregate bytes with its existing page and count:

```ts
{
  files: ProjectFileMeta[];
  total: number;
  total_bytes: number;
}
```

`total_bytes` is the sum across the whole project, not the current page. The store owns this aggregation; HTTP routes do not query `project_files` directly. Existing create, replace, and delete store behavior remains unchanged.

### HTTP

Add:

```text
GET /projects/:name/files/:id
```

Success returns the full file row including `content`. An unknown project returns the existing project 404. An unknown or foreign-project file ID returns the existing file 404. Reads are not audited.

Extend the existing list response without adding content to list rows:

```json
{
  "files": [],
  "total": 0,
  "total_bytes": 0,
  "limit": 25,
  "offset": 0,
  "limits": {
    "max_file_bytes": 262144,
    "max_project_bytes": 2097152
  }
}
```

The limits are owned by colonyd and returned on every successful list response. The console must not duplicate or parse them from error messages. The existing POST, PUT, and DELETE request and response shapes remain compatible.

The existing filename rules, reserved names, UTF-8 validation, immutable filename on update, duplicate-name conflict, per-file size limit, and aggregate project limit remain authoritative on the server.

## Routes and Pagination

The canonical settings URL is:

```text
#/project/<name>?tab=settings
```

The Files section deep link is:

```text
#/project/<name>?tab=settings&section=files
```

File pages after the first add `filesPage=N`. Page one omits `filesPage`:

```text
#/project/<name>?tab=settings&section=files&filesPage=2
```

`filesPage` is independent from the existing `page` parameter used by the Scopes tab. Switching tabs preserves only pagination meaningful to the target tab; a file-page change must never change scope pagination.

The legacy route remains accepted:

```text
#/project/<name>/files?page=N
```

It is replaced in browser history with the canonical Settings Files URL, translating legacy `page=N` to `filesPage=N`. It must not leave a redirect entry that traps Back navigation. After the Settings view renders, `section=files` scrolls the Files heading into view once and moves focus to that heading for keyboard and screen-reader context.

Router helpers own parsing and serialization for `tab`, `section`, and `filesPage`. Views do not hand-build these query strings.

## Console Module Design

This scope targets the modular, buildless Lit console under `packages/console`. Use vendored Lit only and add no dependency.

- `views/project-page.js` retains the project header, tabs, Scopes, and Running surfaces. It delegates the complete Settings tab to `<project-settings>` and no longer renders archive controls in the header. The header retains New scope. The archived status banner remains above the tabs because it describes the whole project.
- `views/project-settings.js` owns the three-section composition, file rows and pagination, inline delete confirmation, section focus target, and section-local presentation of server state.
- `elements/project-file-editor.js` owns the new/edit draft, local-file reading, media-type inference, UTF-8 byte calculation, client preflight messages, and dirty-state preservation. It never performs network calls.
- The shell owns remote data and mutations: context, paged file metadata, loaded file content, file limits, mutation status, and server errors. Views continue the existing property-down/event-up convention.
- `project-context-card.js` is removed after its brief behavior is migrated. Its caret-preservation invariant remains: polling or property refresh must not replace a focused draft.
- `views/project-files.js`, its route-only shell state, and its replace/upload event paths are removed after legacy routing redirects to Settings.
- `project-page.js` must remain under the console module-size guard; Settings behavior must not be folded into that file.

The file editor emits semantic create or update details. Update never emits a filename because filenames are immutable. The shell loads content with GET-by-ID only after a row is selected; paginated list responses remain content-free.

## Brief Section

- Show the existing Markdown brief editor with Save and Cancel.
- Explain: “Agents read this as project background in every packet.”
- Show a live UTF-8 byte count using `TextEncoder`, not JavaScript string length.
- Preserve Markdown exactly as entered; add no preview or formatting transformation.
- Saving and saved states use an `aria-live="polite"` status.
- A failed save preserves the draft and renders the error inside Brief.
- Cancel restores the last server value.
- Background refresh never overwrites a focused or dirty draft.

## Files Section

### Summary and list

The heading line reports server-authoritative values:

```text
N files · X KiB of 2 MiB
```

`N` comes from list `total`; `X` comes from list `total_bytes`; the maximum comes from `limits.max_project_bytes`. Byte formatting is presentation only and never feeds validation.

The empty state includes the file-purpose sentence and an **Add a file** action. A populated row shows filename in monospace, media type, byte size, and relative update time. Selecting a row fetches its full content and opens the editor below the list. While content loads, the selected row remains visible and exposes a local loading state.

Deletion uses the existing inline confirmation pattern. Only the selected row enters confirmation. A failed delete keeps the row and confirmation visible and renders its error in Files.

The existing pager remains when `total` exceeds one page. Creating or deleting a file refreshes both the page and aggregate usage. Deleting the final item on a non-first page navigates to the preceding valid page.

### Editor

The editor has `new` and `edit` modes:

- New mode enables filename. Edit mode disables it and explains that filenames cannot be changed.
- `.md` and `.markdown` infer `text/markdown`; every other accepted filename infers `text/plain`. The operator may override the inferred media type.
- Content uses a growing monospace textarea.
- **Upload from disk** uses a client-side file input and `FileReader`; it creates no upload endpoint. It fills filename, inferred media type, and content in new mode. The input accepts `.txt`, `.md`, `.markdown`, `text/plain`, and `text/markdown`.
- A live UTF-8 byte count compares content with `limits.max_file_bytes`.
- The projected project total is `total_bytes - originalFileBytes + draftBytes` in edit mode and `total_bytes + draftBytes` in new mode.
- Save is disabled when the filename is empty, the per-file limit is exceeded, or the projected project limit is exceeded. The visible reason identifies the violated limit.
- Client preflight improves feedback but does not replace server validation.
- POST creates a new file. PUT updates only `media_type` and `content`.
- A failed create or update preserves every draft field and renders the server message inside the editor.
- Cancel closes the editor and discards its draft. Selecting another file with a dirty draft requires inline discard confirmation.

Binary files remain unsupported. If `FileReader` fails, the editor preserves its prior draft and displays the read error. The server remains responsible for rejecting invalid content.

## Project Section

- Show `Repositories seen in scopes: a, b` as plain read-only text. Omit the line when no repository has appeared in a scope. Do not give this metadata card chrome or imply it is editable.
- Archive uses the existing inline confirmation before the mutation.
- Unarchive remains immediate, matching current behavior.
- Archive or unarchive errors render inside Project.
- Successful archive preserves the project page and exposes the existing archived status banner. Successful unarchive removes it.

## Error and State Ownership

Errors stay with the section and operation that produced them:

- context read/save errors: Brief
- file list/get/create/update/delete errors: Files
- archive/unarchive errors: Project

A section error never replaces the complete Settings surface. File-content load failure preserves the list and selected filename. Save failure preserves the draft. Navigation to another project clears all settings-local selection, confirmation, draft, status, and errors. Polling may refresh non-dirty server data but never an active draft.

## Demo Mode

Demo mode exposes an in-memory project-file adapter with the same observable interface as colonyd:

- paginated metadata list without content
- whole-project `total` and `total_bytes`
- server-shaped limits
- GET-by-ID with content
- create, update, and delete
- immutable filename during update
- duplicate filename conflict
- missing and foreign-project file behavior
- filename rules, media types, per-file bytes, and aggregate project bytes

Fixtures contain real content. Demo IDs and timestamps are deterministic within a test. Demo errors use the same user-visible messages as the server paths exercised by the console. Brief and archive behavior remain driveable offline.

## Accessibility and Responsive Behavior

- Each section uses a real heading. The Settings surface is labelled by its heading structure rather than decorative card labels.
- Save results and errors are announced. Loading state is exposed without moving focus unexpectedly.
- Inline destructive and dirty-draft confirmations are keyboard reachable; Cancel returns focus to the initiating control.
- Disabled Save exposes its reason as visible text and through `aria-describedby`.
- Filename, media type, content, upload, and action controls have programmatic labels.
- At the mobile Playwright viewport, sections and editor fields are one column, actions wrap, long filenames truncate or wrap safely, and the page has no horizontal overflow.

## Non-Goals

- Project rename, description, repository connection management, or per-project scope defaults.
- Markdown preview, syntax highlighting, CodeMirror, or another editor dependency.
- File rename.
- Binary files or media types beyond `text/plain` and `text/markdown`.
- Changes to agent packet semantics or `.colony/project` materialization.
- Automated pixel-perfect screenshot baselines.

## Verification

Automated coverage must prove:

1. Core store tests cover project-owned GET-by-ID, foreign and unknown IDs, content-free paginated lists, honest whole-project `total_bytes`, and unchanged create/update/delete behavior.
2. colonyd HTTP tests cover GET-by-ID success and 404s, list limits and aggregate totals across multiple pages, content omission from list rows, and unchanged mutation validation.
3. Console unit tests cover route parsing/serialization, legacy redirect translation, independent scope/file pagination, media inference, UTF-8 byte counts including multibyte text, projected totals, editor draft preservation, and section-local event details.
4. Demo tests cover list/get/create/update/delete, content, duplicate filenames, missing IDs, both byte limits, and deterministic refresh behavior.
5. `e2e/project-settings.spec.ts` runs in desktop and mobile projects and covers brief save/cancel, empty-state copy, create, upload-from-disk, open/edit/save, over-limit disabled Save with its reason, failed-save draft preservation, delete confirmation, aggregate budget refresh, independent pagination, legacy redirect, section focus, archive, and unarchive.
6. Existing project context and project-list behavior remains green.
7. The console module-size guard remains green and no production console module exceeds its existing threshold.

Because the reported defect is visual, completion also requires browser-driving the actual demo Settings tab at desktop and mobile sizes. Capture and inspect both rendered surfaces for one outer boundary, single section dividers, no bordered read-only blocks, no doubled edges, consistent radii, visible focus, full-width mobile editing, and no horizontal overflow. Screenshots are review evidence, not committed golden files.

Run the focused checks while implementing, then finish with:

```bash
bun test packages/core/test/store.test.ts apps/colonyd/test/ui-http.test.ts
bun test packages/console
bun x playwright test e2e/project-settings.spec.ts e2e/project-context.spec.ts e2e/console-projects.spec.ts
bun run typecheck
bun run lint
bun run test:unit
```
