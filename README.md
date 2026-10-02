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
- Current week/month native pages open through a nonprinting grouping anchor, weekly first then monthly. New page names lead with Persian Calendar's week/month label in Jalali mode (or civil labels in Gregorian mode) and retain the Gregorian start date for uniqueness; the Jalali sidebar headings omit the year and identity suffix. The weekly heading shows the week number and first/last Jalali dates (e.g. `هفتهٔ ۲۸ — ۴ مهر – ۱۰ مهر`); the monthly heading shows the Persian month name and first/last Gregorian dates (e.g. `مهر — Sep 23 – Oct 22`). Jalali sidebar captions now use two compact lines: the week/month label above a smaller, subdued date range. The weekly range is independently RTL; the entire Gregorian monthly range is independently LTR, keeping its start date on the left and end date on the right. This prevents the label and mixed-direction dates from being reordered together. Week endpoints are described by Persian Calendar; no duplicate conversion logic is used. The pane shows editable routine tasks without a visible `Tasks` heading; metadata stays in the page-properties header outside the first view. A sidebar-only style hides the verified grouping row (including an older `Tasks` label) and its extra indentation, leaving native child blocks editable. Snapshot content and period creation are unchanged; this presentation adjustment still needs Desktop confirmation. A completed older page is never renamed or rebuilt; older page-only plans can still open their verified page. If a planned summary block cannot be verified, the plugin pauses sidebar opening with a warning instead of opening the page and exposing its technical properties. Users can inspect that page manually; the plugin does not hide or delete its metadata.
- Optional, separately installed native daily journal template with Focus, Tasks, Priority A, Pending (`WAITING`), and This week. Native queries show original tasks, not copied daily instances. No automatic plugin journal writes, background task scans, missed-period backfill, future generation or automatic carry-forward. A separate guarded Apply daily template to today action is available for an existing empty/one-blank-block journal only.
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

Setup now shows the essentials first: calendar, automatic sidebar opening, a daily-template option, a short section preview and **Set up this graph**. That one explicit action saves your choices, enables current routines, installs the selected daily template and applies it to today when safely eligible. Uncheck the daily option for routines only. **More options** reveals definition-page selection, standalone actions and detailed safety guidance. **Save settings does not enable a disabled graph.** Enable grants writes only for the displayed graph; graph changes invalidate pending setup.

Default definitions are `Journal & Routines — Weekly definition` and `Journal & Routines — Monthly definition`. Save a new selection before opening it. On first Enable with **both defaults absent**, the plugin creates those pages and inserts two editable Persian TODOs per definition and per current period; future snapshots copy the definitions. If either definition already exists, even if empty, or custom definitions are selected, it respects their content and does not auto-seed. Add your own tasks before Enable if preferred. The explicit **Add two Persian examples per routine** button is still available for previously empty periods: it preflights both owned current periods and both selected definitions and inserts only if all four remain empty and unedited. If a write is ambiguous, it stops rather than silently duplicating tasks. Definition edits affect later periods only. Disable before changing definition-page selections.

Automatic sidebar requests happen on activation/startup and rollover. Newly opened native panes are requested month then week because Logseq prepends them, giving a weekly-first view. Closing a pane manually does not cause repeated reopening in the same session. **Show current routines** explicitly requests reopening. Unrelated panes are never cleared. A successful SDK request does not itself confirm visible sidebar rendering.

These are development controls, not a production installation recommendation. Use disposable graphs for the outstanding Desktop checks in [NEXT_SESSION.md](NEXT_SESSION.md).

## Optional daily journal template

1. Rebuild/reload this plugin on a disposable Markdown graph and open Setup.
2. Choose the calendar, leave **Include the daily journal template and apply it to today if empty** selected, and click **Set up this graph**. This combines saving settings, enabling routines, installing the native default and guarded today application. Opening Setup alone makes no graph writes. Uncheck daily inclusion if you only want routines.
3. If another default is selected, check **Replace an existing default journal template (its content is preserved)** before setup. Other default-template settings and the old template's content remain intact; without approval, replacement is refused.
4. The completion message distinguishes all-ready from unchanged today. Populated/missing/previously attempted journals are preserved, not forced or rebuilt. If today is missing, open it through native Logseq navigation and use **More options → Apply daily template to today**. Genuine interrupted-write/dependency/config problems remain actionable; the multi-step setup is not an atomic transaction.

The template page is `Journal & Routines — Daily template` and the native default is `Journal & Routines — Daily`. Logseq applies it to eligible empty today/future journals; existing populated journals and historical journals are not regenerated. Check the default after a Desktop reload: the host's config-write acknowledgement alone does not prove disk persistence. Standalone Enable, Install and Apply actions remain available under **More options**.

| Section | Content |
| --- | --- |
| Focus | Blank space for today's main outcome |
| Tasks | Blank space for tasks you add to this journal |
| Priority A | Graph-wide unfinished `[#A]` tasks, excluding `WAITING` |
| Pending | Graph-wide tasks marked `WAITING`; older unfinished TODOs are not automatically pending |
| This week | Unfinished tasks on the current weekly routine page—including manual additions—and tasks anywhere scheduled or due within that week's inclusive dates |

The headings use small suitable icons: 🎯 Focus, ☑️ Tasks, 🚩 Priority A, ⏳ Pending and 📅 This week. Confirmed-empty Priority A/Pending sections are hidden by plugin styling; they return when results exist. Query errors and extra notes you add below a section are not hidden. Queries use native list rendering without page grouping or ancestor breadcrumbs, avoiding the invisible weekly summary wrapper's extra indentation. Actual task nesting is retained. Unloading the plugin removes this presentation styling.

The query sections use native task blocks; completing an original task updates its views rather than creating another task instance. Current definition-page tasks and template-page tasks are excluded. To include manual work in This week, add it to the current weekly period page or use a native **SCHEDULED/DEADLINE** date within the week. A task merely written in a journal this week, without such a date, is not automatically a weekly task.

Week selection follows **real-world today**, even when reading an older journal: Saturday–Friday for Jalali, Monday–Sunday for Gregorian. Queries use the current owned weekly page's bounds, not unsupported native `:start-of-week` inputs. If that page is absent, This week has no results; it does not recreate a deleted period or guess the dates. Native query refresh at midnight/resume still requires Desktop validation.

**If tomorrow received the template but today did not:** native Logseq may have skipped today because it already contains a blank block. The installer does not shift dates or choose tomorrow. After reloading this build, use **More options → Install daily journal template** again to refresh only untouched generated template headings/query presentation, then choose **Apply daily template to today** in More options. The primary **Set up this graph** also combines these steps when daily inclusion is selected. Finish editing in Logseq first. The action resolves the host's actual `:today` journal—not the page currently being browsed—and accepts only an existing empty journal or one ordinary blank root block. It refuses populated journals, extra blank blocks, headers and user properties. If today is missing, open it through native Logseq navigation first. An uncertain/previous application is not automatically retried; inspect the journal rather than clearing markers. The plugin never creates a dated journal page or edits tomorrow's content.

You can edit the five sections on the template page for later journals; existing journal content is not regenerated. Keep the template root's registration/context properties intact. Calendar/definition settings update only those context lines, preserving your section edits. If a root is being edited or installation is incomplete, Setup reports a separate daily-template warning; routines settings can still save, and subsequent startup/day/Show current checks retry safe context synchronization. Interrupted/deleted installations are never automatically rebuilt.

**Disable does not remove the native default or template.** Native insertion/query behavior remains available while the plugin is off, but it no longer initializes new weekly periods. To stop native daily insertion, change/remove `:default-templates :journals` in this graph's Logseq configuration; existing journals and template content remain yours.

A user Desktop screenshot confirms the native five-section template and weekly task results on a future journal. The updated empty-section hiding, icons, compact weekly results and explicit apply-to-today path are built and fixture-tested, not yet verified in Desktop; config persistence remains a validation gate. No live graph was changed during this implementation.

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

Automated results after the sidebar-caption and optional daily-template implementation:

- **634 Node tests passed**, including localized title and default starter fixtures, sidebar caption assertions, header-aware SDK checks, calendar boundaries, interrupted snapshot/sample writes, preserved edits/deletions, graph isolation, lifecycle/idle checks, setup UI and real Chromium IndexedDB persistence.
- **22 Chromium smoke checks passed** with the real runtime/view and a fake SDK/storage, including toolbar setup opening, native summary-block requests, guarded daily-template installation/replacement/idempotency/context switching, and refusal to overwrite existing routines. These do **not** run Logseq's toolbar, sidebar or query renderer.
- Current build passed: `dist/index.js` approximately **322 KiB**, unminified and including the SDK (gzip size not remeasured).
- `node scripts/validate_host_metadata.cjs /path/to/Logseq/main.js` passed against the audited, SHA-256-pinned installed 0.10.15 bundle. Native Bean-in-Datom serialization fails as expected; equivalent native persistent-map serialization succeeds. This is isolated serializer coverage, not parser, full-database, Desktop or disk-persistence validation. Unknown bundle hashes are rejected before evaluation.
- `node scripts/validate_daily_queries.cjs /path/to/Logseq/main.js` passed **26 native DataScript fixture checks** against the same hash-pinned 0.10.15 bundle. It evaluates generated daily queries and custom rules with synthetic UUID/task/period datoms, not live graph data. No native Markdown parsing, actual `:today` clock refresh, Desktop rendering or persistence is exercised.
- No new dependencies. Superseded journal-writing/scanning/setup-preview modules and their obsolete tests were removed. No existing journal or period pages were edited directly; the disposable graph's template and config were changed as described below.

The fixtures assert no repeated work while idle and no full-graph SDK enumeration. User screenshots confirmed the manifest icon, toolbar, enabled Jalali period pages and weekly-first compact block panes in Desktop. The two-line caption layout, example insertion, query/history performance, reload behavior and indexing timing remain unverified in Desktop. After the sidebar, daily-template presentation and safe today-application changes, `npm test`, `npm run build` and all 22 `npm run test:browser` fixture checks passed; these are not live Desktop rendering checks. The new isolated native DataScript script passes 26 checks using synthetic datoms from the pinned 0.10.15 engine, covering weekly boundaries, calendar switching, UUID definition exclusions, statuses and deduplication. It does not run native Markdown parsing or the Desktop renderer. A separate Chromium native-shaped DOM fixture checks empty/nonempty/error/unrendered sections, extra notes, query wrapper spacing and preserved task bullets; this is synthetic renderer markup, not live Desktop validation.

For the disposable `draft2` graph only, Logseq's native `Daily Journal` template in `pages/Templates.md` and `logseq/config.edn` adds Focus, Tasks, Notes and a short review to **new** journals. That is graph configuration, not plugin automation; existing journal days are not rewritten. Technical `jr-*` fields are hidden by that graph's `:block-hidden-properties` setting but remain in Markdown. If an old page pane is already open when the new summary pane is requested, close the obsolete pane manually; the plugin never clears unrelated sidebar panes. Do not infer production readiness from test counts.

Product contract: [SCOPE.md](SCOPE.md). Contributor instructions: [AGENTS.md](AGENTS.md). Architecture: [ENGINE.md](ENGINE.md). Next validation gate: [NEXT_SESSION.md](NEXT_SESSION.md).
