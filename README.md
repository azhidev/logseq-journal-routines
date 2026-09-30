# Journal & Routines

weekly and monthly routines in Logseq's native right sidebar.

**Status: development alpha (`0.5.0-alpha.1`), not production-ready.** The replacement runtime is implemented and built. Automated SDK fixtures and a Chromium setup-flow fixture pass; user screenshots confirmed the icon, toolbar, Enable and native weekly-first compact block panes in Logseq Desktop. Later screenshots show localized titles and Persian starter tasks in Desktop; the updated RTL date-order fix and native history still need live validation. Target: **Logseq Desktop 0.10.15, Markdown file graphs**. Database graphs, Org and mobile are not supported targets.

**Logseq 0.10.15 metadata fix implemented; Desktop verification and existing-graph recovery remain outstanding.** New period/history pages no longer pass metadata objects to `createPage`, which can leave an unserializable `cljs-bean/Bean` in the database. They create the page without properties, then parse metadata text through a verified first-root `updateBlock` operation. Automated fixtures pass; an isolated test using the installed host's actual serializer reproduces the Bean rejection and accepts equivalent native maps. That serializer test does not execute the complete Desktop write path. Keep the plugin disabled in affected graphs pending a separate safe recovery procedure: updating or disabling it does not repair existing in-memory Beans. Do not clear storage or force recovery; see [NEXT_SESSION.md](NEXT_SESSION.md).

## Local installation (disposable graphs only)

1. From this plugin directory (the one containing `package.json`), run `npm ci` if dependencies are not installed, then `npm run build`. The build creates `dist/index.js`; `index.html` loads that file. `dist/` is ignored by Git, so a fresh checkout must be built before loading it locally.
2. In Logseq Desktop, use **Plugins → Load unpacked plugin** and select **this plugin directory**, not the graph folder or `dist/`. The manifest points to the bundled `icon.png` at this same directory level.
3. If an older Journal & Routines copy is installed, verify which folder Logseq loaded and reload the intended copy rather than running both. Reload after rebuilding. The icon has been confirmed visible in the Logseq Desktop plugin list by the user.

Click the **Journal & Routines calendar/checklist button in the top toolbar** to open setup; alternatively search for **Journal & Routines: Setup and settings** in the command palette. Clicking the installed-plugin entry itself is not the setup launcher. Installing the plugin or opening setup does not enable writes to a graph; use the explicit **Enable** button for the disposable graph. Do not delete existing graph pages or clear plugin storage to troubleshoot installation.

## Implemented behavior

- Ordinary editable weekly/monthly definition pages, with separate snapshots for each initialized period.
- Gregorian mode without other plugins, Monday-start weeks; optional Jalali mode through Persian Calendar API v1, Saturday-start weeks. Both use the device's local civil day. Weeks do not reset at month boundaries.
- Explicit per-graph Enable, selected or newly created definition pages, auto-open preference, and Disable without deleting notes. If **both default definitions are newly created** on first Enable, two Persian TODOs are seeded in each definition and current period through a guarded, repeat-safe write. Existing/selected definitions are never auto-filled.
- Current week/month native pages open through a nonprinting grouping anchor, weekly first then monthly. New page names lead with Persian Calendar's week/month label in Jalali mode (or civil labels in Gregorian mode) and retain the Gregorian start date for uniqueness; the Jalali sidebar headings omit the year and identity suffix. The weekly heading shows the week number and first/last Jalali dates (e.g. `هفتهٔ ۲۸ — ۴ مهر – ۱۰ مهر`); the monthly heading shows the Persian month name and first/last Gregorian dates (e.g. `مهر — Sep 23 – Oct 22`). The caption uses RTL direction, while each Gregorian date is isolated left-to-right so the start date appears first when reading the range from right to left. Week endpoints are described by Persian Calendar; no duplicate conversion logic is used. The pane shows editable routine tasks without a visible `Tasks` heading; metadata stays in the page-properties header outside the first view. A sidebar-only style hides the verified grouping row (including an older `Tasks` label) and its extra indentation, leaving native child blocks editable. Snapshot content and period creation are unchanged; this presentation adjustment still needs Desktop confirmation. A completed older page is never renamed or rebuilt; older page-only plans can still open their verified page. If a planned summary block cannot be verified, the plugin pauses sidebar opening with a warning instead of opening the page and exposing its technical properties. Users can inspect that page manually; the plugin does not hide or delete its metadata.
- No plugin journal/template edits, background graph scans, missed-period backfill, future generation or automatic carry-forward.
- Snapshot preservation across repeat requests/reloads: definition changes affect later periods; completed tasks and deliberate task deletions are not reset.
- Calendar switching with confirmation and dependency validation; previous calendar pages remain intact and are reused when switching back.
- **Show routine history** opens an ordinary history page with two native queries, covering both calendars newest first. Query syntax was checked against host source; actual rendering, links and large-result behavior still need Desktop validation.

## Development-alpha controls

The toolbar button opens the same setup window as the command palette. The command palette also exposes:

- **Journal & Routines: Setup and settings**
- **Show current routines**
- **Show routine history**
- **Open weekly definition** / **Open monthly definition**
- **Disable for this graph**

Setup lets you choose the calendar, two distinct definition pages and automatic sidebar opening. **Save settings does not enable a disabled graph.** Enable grants writes only for the displayed graph; graph changes invalidate pending setup.

Default definitions are `Journal & Routines — Weekly definition` and `Journal & Routines — Monthly definition`. Save a new selection before opening it. On first Enable with **both defaults absent**, the plugin creates those pages and inserts two editable Persian TODOs per definition and per current period; future snapshots copy the definitions. If either definition already exists, even if empty, or custom definitions are selected, it respects their content and does not auto-seed. Add your own tasks before Enable if preferred. The explicit **Add two Persian examples per routine** button is still available for previously empty periods: it preflights both owned current periods and both selected definitions and inserts only if all four remain empty and unedited. If a write is ambiguous, it stops rather than silently duplicating tasks. Definition edits affect later periods only. Disable before changing definition-page selections.

Automatic sidebar requests happen on activation/startup and rollover. Newly opened native panes are requested month then week because Logseq prepends them, giving a weekly-first view. Closing a pane manually does not cause repeated reopening in the same session. **Show current routines** explicitly requests reopening. Unrelated panes are never cleared. A successful SDK request does not itself confirm visible sidebar rendering.

These are development controls, not a production installation recommendation. Use disposable graphs for the outstanding Desktop checks in [NEXT_SESSION.md](NEXT_SESSION.md).

## Snapshot copy rules

- Preserve block nesting, prose, fenced code, page links and literal block references. Referenced external blocks are not rewritten or converted into independent copies.
- Allocate fresh block UUIDs; reset recognized task markers to `TODO`.
- Do not copy page-property headers. Strip block property lines, LOGBOOK drawers and SCHEDULED/DEADLINE/CLOSED lines **outside fenced code**, including source identity/completion metadata.
- Custom block properties are deliberately not cloned. A property-only content block or malformed tree pauses initialization rather than silently losing structure.
- Definitions are limited to 2,000 content blocks and 40 levels of nesting. This is a bounded snapshot copier, not a general template engine or recurrence system.

## Safety and storage

Period identity and ownership metadata contain calendar, kind and inclusive Gregorian civil bounds. New page names instead lead with the readable label and end with the civil start date, for example:

`هفتهٔ ۲۸ · ۱۴۰۵ — 2026-09-26`

`Week · Sep 21–Sep 27 — 2026-09-21`

Native Logseq sidebar pane titles come from page names, not the content of the opened block; the SDK offers no independent title override. Earlier exact names such as `Journal & Routines — gregorian weekly — 2026-09-21 to 2026-09-27` are reused without renaming or duplicating existing periods.

Immutable `jr-*` ownership metadata identifies generated pages; an unrelated same-name page is a collision, never permission to overwrite it. Initialization checkpoints live in the page's actual properties **pre-block**, not on a pretend content-bearing page entity. Writes and their locations are verified before advancing the checkpoint. Ambiguous interruptions pause without rollback or blind reinsertion.

Graph files hold task content and creation-plan metadata. Origin-local IndexedDB holds activation/preferences and small per-resource creation markers, **not a duplicate task database**. Graph identity is a hash of the exact graph path, not its display name. Moving a graph changes its local identity. Conversely, emptying/recreating a folder at the same path retains its activation and creation records. A missing recorded page is not proof of deletion: an interrupted creation or graph persistence failure can also cause it. **Enabled — attention required** means activation is saved but an operation reported an error; it does not mean current routines were successfully initialized. No automatic recreation is attempted. Browser/profile deletion, plugin-storage clearing or another device may lose deletion markers; graph backups alone do not preserve them. Keep plugin storage as well as graph data backed up if relying on deletion suppression. Never clear storage just to bypass a paused initialization.

SDK operations are not atomic transactions. Already-dispatched writes cannot be cancelled by a graph switch. Simultaneous initialization from different devices/profiles is not guaranteed. Initialization may require inspection after an ambiguous failure; there is no destructive automatic repair or recreation action.

Jalali dependency loss pauses new current-period work with an actionable message. Existing native pages and history remain accessible. History creation can itself pause after an interrupted write; completed history content is not regenerated when edited or deleted.

## Validation

Run from this plugin directory:

```sh
npm test
npm run test:browser
npm run build
```

Automated results after the nonprinting-anchor and Jalali sidebar-caption changes:

- **490 Node tests passed**, including localized title and default starter fixtures, sidebar caption assertions, header-aware SDK checks, calendar boundaries, interrupted snapshot/sample writes, preserved edits/deletions, graph isolation, lifecycle/idle checks, setup UI and real Chromium IndexedDB persistence.
- **18 Chromium smoke checks passed** with the real runtime/view and a fake SDK/storage, including toolbar setup opening, native summary-block requests and refusal to overwrite existing routines. These do **not** run Logseq's toolbar, sidebar or query renderer.
- Current build passed: `dist/index.js` approximately **274 KB**, unminified and including the SDK (gzip size not remeasured).
- `node scripts/validate_host_metadata.cjs /path/to/Logseq/main.js` passed against the audited, SHA-256-pinned installed 0.10.15 bundle. Native Bean-in-Datom serialization fails as expected; equivalent native persistent-map serialization succeeds. This is isolated serializer coverage, not parser, full-database, Desktop or disk-persistence validation. Unknown bundle hashes are rejected before evaluation.
- No new dependencies. Superseded journal-writing/scanning/setup-preview modules and their obsolete tests were removed. No existing journal or period pages were edited directly; the disposable graph's template and config were changed as described below.

The fixtures assert no repeated work while idle and no full-graph SDK enumeration. User screenshots confirmed the manifest icon, toolbar, enabled Jalali period pages and weekly-first compact block panes in Desktop. The updated RTL caption ordering, example insertion, query/history performance, reload behavior and indexing timing remain unverified in Desktop.

For the disposable `draft2` graph only, Logseq's native `Daily Journal` template in `pages/Templates.md` and `logseq/config.edn` adds Focus, Tasks, Notes and a short review to **new** journals. That is graph configuration, not plugin automation; existing journal days are not rewritten. Technical `jr-*` fields are hidden by that graph's `:block-hidden-properties` setting but remain in Markdown. If an old page pane is already open when the new summary pane is requested, close the obsolete pane manually; the plugin never clears unrelated sidebar panes. Do not infer production readiness from test counts.

Product contract: [SCOPE.md](SCOPE.md). Contributor instructions: [AGENTS.md](AGENTS.md). Architecture: [ENGINE.md](ENGINE.md). Next validation gate: [NEXT_SESSION.md](NEXT_SESSION.md).
