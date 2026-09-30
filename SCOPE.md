# Journal & Routines — product contract

Updated: 2026-09-27
Status: **Product direction approved; no outstanding user clarification.**
Implementation status: lightweight development alpha implemented and fixture-tested; actual Desktop validation remains outstanding. See README and NEXT_SESSION for evidence and limits.

## Authority and purpose

This is the source of truth for Journal & Routines. It replaces the earlier comprehensive journal-management brief. Read it before planning or changing this plugin; do not restore superseded requirements from parent roadmaps or experimental release notes.

Build a lightweight plugin, installable on an existing graph, that shows the current week's and month's routine tasks in Logseq's right sidebar. Sidebar access is sufficient: integration into daily journal content is not required.

The user confirms previous experimental versions have not been deployed. There is **no backward-compatibility or migration requirement for those versions**. Remove obsolete implementation, tests, dependencies and documentation when replacing that path; do not retain compatibility machinery or expose old-version/recovery choices to users. This authorizes targeted removal of obsolete Journal code, not deletion of graph content or unrelated work.

## D1 — Ordinary period pages, independent of journals [approved]

- Two ordinary user-editable definition pages: weekly routines and monthly routines.
- One ordinary Logseq page per initialized weekly period and one per initialized monthly period.
- Period task snapshots live in those pages; the native sidebar displays an owned editable summary block when available. If a planned summary cannot be verified, it does not open the metadata-bearing page as a fallback; old page-only plans may still open their verified page.
- No automatic journal-template changes by this plugin, daily references, journal renaming, journal restructuring or historical owner discovery. A disposable test graph may separately use Logseq's native daily template for new days, without plugin journal writes or rewriting existing journals.
- No dependency on starter scripts/styles, Dashboards, Habits or Finance.

Finalize deterministic page names and ownership properties before implementing creation. Identity must include calendar, period kind and civil bounds; localized titles and week numbers are presentation, not identity. A same-name unrelated page is a collision, never permission to overwrite it.

## D2 — Calendar and independent weeks [approved]

Approved:
- Gregorian mode is the default and needs no Persian Calendar plugin.
- Jalali mode uses the compatible Persian Calendar API; no duplicate Jalali conversion implementation.
- A weekly period is seven days, independent of month/year boundaries. A new month must not split or reset an existing week.
- A monthly period is a calendar month, not a rolling 30-day window.

Confirmed week starts: **Saturday for Jalali/Persian, Monday for Gregorian**. The user explicitly corrected the earlier calendar-label typo; this decision is settled.

No configurable week-start framework is needed in the first release. Today uses the device's local civil date, not UTC; timezone changes never rewrite existing period content.

## D3 — Current sidebar plus accessible history [approved; concrete UX below is recommendation]

The automatic sidebar always shows the real-world current week and month, independent of the journal/page being browsed.

History access is in scope, not deferred. Recommended lightweight solution:
- A **Show routine history** command/button opens one ordinary native Logseq history page.
- Two native query sections list weekly and monthly period pages newest first, showing readable labels and date ranges. Include periods from both calendars, clearly labeled.
- Query only period pages identified by this plugin's metadata. Exclude definition pages and unrelated content. Use native/indexed queries rather than loading every page/block through the plugin SDK.
- Evaluate history only when opened; do not collect or refresh it in a background scheduler. Use native result limits/paging where available if needed; verify target-host query behavior before claiming it supported.
- Clicking a result opens the original period page. It does not create another snapshot or change the current-period selection.
- Preserve old tasks and completion state, including unfinished tasks; users can edit them normally.

Do not build a custom archive database, calendar picker, task renderer or historical journal scanner. The concrete history-page query syntax and final naming remain implementation details to verify.

## D4 — One snapshot per period; no automatic carry-forward [approved]

Copy the routine definition tree once when a period is initialized. New task instances start as TODO. Preserve useful non-task text and nesting, but assign new block identities and do not copy completion metadata. Document and test the supported property/reference-copy rules before implementing cloning; never rewrite referenced external blocks.

Definition edits affect later periods, not already initialized periods. Users can edit current-period tasks directly. Never reset completed tasks, refill deliberately deleted tasks or automatically rebuild a deleted period page. An explicit recreation action can be considered separately; it is not automatic recovery.

Unfinished tasks stay in their original period and remain accessible through history. No automatic carry-forward or overdue aggregation.

## D5 — Only the current/new period [approved]

After per-graph activation, create only the current period if it has not been initialized. Reuse it on subsequent days/reloads. At rollover initialize the new current period once.

- Do not backfill missed weeks/months or pre-create future periods. On first Enable only, when **both default definition pages did not exist**, create them and safely seed two Persian TODOs in each and in the two current snapshots. Existing/selected definition pages, including intentionally empty ones, are never auto-seeded. An explicit per-graph action may add the same examples to verified empty current periods and definitions; interrupted/edited outcomes pause rather than refill. Failed reads are not proof that a page is missing or empty.

## D6 — Small setup, isolated by graph [approved]

- Setup consists of calendar choice, definition-page selection/creation, a concise explanation of generated resources and one explicit Enable action for that graph. Fresh default definition pages are seeded on first Enable as in D5; any existing or selected definition pages are left as-is. No graph writes occur merely by opening setup. Sample tasks on already-existing empty periods require a separate explicit action.

Use stable graph identity, not display name. Installation does not authorize writes to every graph. Keep definitions, snapshots and completion state in the graph; private plugin storage is not the only copy of user task data.

No template-management wizard, old-version selector, migration walkthrough or general graph inspection is part of setup. A disposable graph's native Logseq daily template is separate from plugin setup.

## D7 — Optional dependency; simple calendar switching [approved]

In selected Jalali mode, missing/incompatible Persian Calendar pauses creation with one actionable message. Existing tasks/history remain accessible. Never silently fall back to Gregorian or auto-install a dependency.

Changing calendar requires one clear confirmation: existing data stays as-is and the selected calendar determines the current periods from then on. No historical conversion, renaming, merging or deletion. Look up/reuse an existing period for the newly selected calendar before creating it; switching back must not duplicate or reset previous work. Cancel leaves the previous selection unchanged. Validate Jalali availability before completing a switch to it.

Keep this a setting plus confirmation, not a migration framework. Preserve all previous calendar periods in history.

## D8 — Native sidebar; respect user control [approved]

Use native editable Logseq period pages and owned summary blocks in the sidebar, not a custom task UI. Auto-open on activation/startup and period rollover, with an auto-open toggle and a **Show current routines** command.

Reuse panes, preserve unrelated panes and do not repeatedly reopen a pane manually closed during the session. Disable stops new automatic work and releases owned listeners/timers/UI without deleting graph content or clearing the sidebar wholesale.

## D9 — Minimal safety for the new model [engineering requirement]

Serialize plugin writes and coalesce triggers. Recheck the current graph before subsequent operations and discard stale queued work. Narrow writes to identified routine resources; preserve user edits.

Period creation must be repeat-safe across reload and interrupted initialization. Use the smallest durable creation state needed to reconcile those resources. Do not port the old general journal writer/checkpoint engine solely for compatibility. Ambiguous outcomes pause the affected operation with a useful message rather than blindly copying again or deleting user content.

SDK writes are not atomic graph transactions. Concurrent initialization from multiple devices/profiles is not guaranteed in the first release; document that limitation and detect conflicts where possible. Do not promise cross-device exactly-once writes.

## D10 — Lightweight execution contract [user priority]

- No full-graph inventory or historical-journal traversal in ordinary operation.
- Read exact current period pages and selected definition pages only when needed. Automatic current-period work must not grow with total graph/history size.
- History lookup is on demand and limited to the plugin's period metadata.
- Use lifecycle events, a timer for the next local day boundary and a visibility/resume check. No short-interval polling or global DB-change rescan.
- No network service, telemetry, background synchronization or heavy UI framework for this feature.
- No private database copy of task content. Persist only necessary settings/minimal creation metadata; document its backup implications.
- No repeated graph reads/writes while idle. Verify SDK call counts and listener cleanup.
- Measure release bundle size/startup work before making numeric performance claims.
- Remove obsolete code and tests of discarded behavior rather than bundling or maintaining parallel experimental runtimes. Retain/add focused tests for supported behavior and data safety.

## D11 — Clean replacement, not backward compatibility [approved]

Target Logseq Desktop 0.10.15, Markdown file graphs first. Database graphs, Org and mobile are not implicitly supported.

No deployed prior Journal versions need support, according to the user. Do not retain old APIs, legacy markers, experimental version UI, compatibility adapters, old release instructions or migration/recovery workflows merely to support those versions. Reuse existing Calendar/sidebar utilities only if they serve the new contract with less complexity.

The distinction is essential: **obsolete software can be removed; user data must be preserved**. Do not delete notes, period history or unrelated starter/plugin features. Legacy journal data need not be imported, understood or converted by the new plugin. Do not automatically delete starter scripts; a warning about genuinely overlapping automation is sufficient, not a universal installation chore.

Inspect the working tree before removing code. The user authorized obsolete Journal cleanup, not discarding unrelated uncommitted changes.

## D12 — Non-goals

No plugin-managed daily templates or journal restructuring, habit/finance integration, combined dashboard, general recurrence language, reminders, automatic task carry-forward, full-graph migration, suite service framework or backward compatibility with experimental Journal versions. The plugin name does not expand its scope.

## Delivery order

1. Follow `NEXT_SESSION.md`; settle deterministic page/metadata names and narrow cloning/creation rules as implementation details. Keep this contract updated without reopening approved decisions.
2. Inspect the current implementation; identify reusable components and remove obsolete Journal paths/tests/dependencies as their replacement is implemented. Do not preserve a parallel legacy product.
3. Deliver Gregorian activation, definition pages, safe current period snapshots and native sidebar panes, without journal writes.
4. Add Jalali via Persian Calendar, straightforward calendar switching and the on-demand history entry point.
5. Test reload/interruption, rollover, graph isolation, dependency loss, source edits/deletions, calendar switching and history preservation. Check idle/rollover SDK calls and bundle cost.
6. Verify actual Desktop behavior on a clean and disposable existing graph. Update README to describe the shipped behavior and limitations, not a list of experimental releases.

## Acceptance criteria

- Existing graphs need no starter/template changes to show current routines.
- Gregorian works alone; Jalali explains and checks its optional dependency.
- Week/month boundaries follow D2, including weeks spanning months and Nowruz/leap boundaries.
- Current period pages are editable in the right sidebar; reload/disable preserves all task data.
- Repeated initialization never duplicates/resets completed periods. Interrupted initialization safely reconciles or pauses.
- Definition edits affect future snapshots only; deleted tasks stay deleted and unfinished tasks stay in history.
- Only current periods are initialized; no missed/future period generation.
- History offers a clear on-demand route to original weekly/monthly pages from either calendar.
- Calendar switching preserves/reuses prior periods and never silently converts their data.
- User journals/templates/settings and unrelated sidebar panes remain untouched.
- Graph switches cannot reuse another graph's activation or queued work.
- Idle operation performs no repeated scanning/writing; automatic work does not traverse history.
- No obsolete experimental-version compatibility machinery remains in the delivered runtime or user guide.
- Fixture tests and live Desktop results are reported separately.

## Implemented engineering choices — 2026-09-26

- Period identity is `journal-routines:<calendar>:<kind>:<start>:<end>`, where bounds are inclusive Gregorian civil ISO dates. New page names begin with the provider-supplied week or month label and end with ` — <start>` for a stable civil-bound qualifier (e.g. `هفتهٔ ۲۸ · ۱۴۰۵ — 2026-09-26`). Earlier exact names `Journal & Routines — <calendar> <kind> — <start> to <end>` remain readable without renaming or duplicate creation. Immutable ownership properties are `jr-period-id`, `jr-calendar`, `jr-kind`, `jr-start`, `jr-end`. Raw/camelCase SDK aliases must agree.
- Default definition pages are `Journal & Routines — Weekly definition` and `Journal & Routines — Monthly definition`; users can select distinct ordinary Markdown pages while disabled. Setup is a lazy native-DOM panel opened from a small toolbar launcher or the command palette, with explicit graph-scoped Enable and an inline calendar-change confirmation. Installing or clicking the launcher never enables graph writes.
- Snapshots preserve nesting, prose, fenced code and literal references. Recognized task markers become TODO. Page-property headers are excluded. Block property lines, LOGBOOK drawers and SCHEDULED/DEADLINE/CLOSED lines outside fences are stripped, including custom properties. Property-only content blocks pause rather than disappear silently. Definitions are bounded to 2,000 content blocks and depth 40.
- New creation plans retain a nonprinting summary anchor with definition task roots nested beneath it; the localized/civil period label leads the native page title, and there is no visible `Tasks` heading in new period content. The native sidebar opens this block, so the technical page-properties header remains on the original page but outside the first view. Sidebar-only styling hides the verified generated wrapper row and its indentation, including existing `Tasks` labels, without deleting or moving any blocks or changing period creation. In Jalali mode, sidebar captions omit years: weekly shows the week number and Jalali start/end days (via Persian Calendar), while monthly shows the Persian month name and Gregorian start/end dates. Both captions separate their label from the range with an em dash and the two endpoints with an en dash; the caption is RTL and each Gregorian date is isolated left-to-right separately, preserving start-to-end reading order. Stored names and ownership remain unchanged. Existing completed periods are never restructured; when a planned summary cannot be verified, automatic sidebar opening pauses with an actionable message rather than exposing the page's technical properties. Only a manual graph-scoped sample action may add a summary to verified empty older periods. The durable creation plan contains a definition fingerprint and fresh block UUIDs, not a second copy of task text. Logseq 0.10.15 creates a separate properties pre-block even with `createFirstBlock:false`; mutable `jr-snapshot-state` checkpoints are read/written on that verified header, never through the page UUID or an assumed up-to-date page-property mirror. The first content root follows the header. Uncertain writes pause; verified interrupted writes may resume without duplication.
- New period/history metadata is created through native text parsing, not the nonempty `createPage` properties argument that leaves an unserializable Bean in Logseq 0.10.15. After acknowledged property-free page creation, only a verified first-root bootstrap or untouched native title header may be updated; title content is preserved, page/header properties and location are rechecked before population. Existing or interrupted ambiguous pages are not adopted, rewritten or repaired automatically. Prevention does not repair previously affected in-memory graphs.
- Per-graph preferences and per-resource creation markers live in local IndexedDB. Markers precede possible creation to prevent automatic recreation after ambiguous writes/deletion. Graph identity hashes the exact path. Moving a graph or losing plugin storage can lose activation/deletion evidence; graph backups alone do not preserve these local markers. Concurrent initialization across profiles/devices is not guaranteed.
- `Journal & Routines — History` contains weekly/monthly native advanced queries over owned period metadata, newest first across calendars. It is created only on explicit request, and completed query content is never repopulated after edits/deletion. Source-audited query syntax still requires real Desktop rendering/link/performance checks.
- Queued work captures graph/generation on request; writes are serialized and guarded. Automatic work uses the next local-day boundary and visibility/resume events, not polling. Session-local sidebar tracking avoids reopening manually closed panes; Show current routines explicitly requests reopening.
- The old journal writer, scanners, template/setup preview and their obsolete tests have been removed. Existing Calendar transport and metadata storage were retained where useful. No migration or graph-data deletion was introduced.

## Decision record

2026-09-23: User approved independent period pages, independent weeks, current sidebar context, per-period snapshots without carry-forward, current-period-only creation, simple optional-calendar handling with data preservation, and recommended setup/sidebar behavior. User additionally required convenient history access and explicitly rejected preserving unused experimental versions or backward compatibility. Lightweight operation remains a core priority. The proposed native history page is an implementation recommendation, not a separately user-specified UI.

2026-09-24: User explicitly confirmed Saturday for Jalali/Persian and Monday for Gregorian and requested preparation for implementation in a new session. No product clarification remains. This session prepares documentation and the handoff only; runtime replacement belongs to the next session.

2026-09-26: After confirming the plugin icon appears in Logseq's installed-plugin list, the user approved a toolbar button that opens the existing setup window. Clicking an installed-plugin entry is not treated as a launcher; opening setup remains read-only until explicit per-graph Enable.

2026-09-27: The user tested the enabled Jalali runtime in a disposable graph and asked for compact weekly-first/monthly-second native sidebar views with Jalali week/month labels, two Persian sample tasks per period, hidden technical metadata in the first view, and automatic daily Focus/Tasks/etc. sections. The first implementation used summary-block labels and an explicit guarded example action. A follow-up Desktop screenshot confirmed weekly-first compact block panes but showed technical page-name headers and no sample tasks. The user requested labels in the **native pane titles** and one or two sample TODOs per period, explicitly excluding cleanup of disposable graphs. Native Logseq has no separate pane-title option, so new page names lead with labels and fresh default definitions are seeded on first Enable; old pages are not renamed, and the explicit guarded action remains for existing empty periods. A final clarification requires only removal of the visible `Tasks` heading, not a change to period instancing or task-copy behavior. The new summary anchor uses one zero-width character so native block panes still show multiple editable child tasks without exposing page properties. Existing periods are not rewritten; actual Desktop spacing/bullet rendering still needs validation. No automatic edits to journals, previously edited periods, or existing daily notes.
