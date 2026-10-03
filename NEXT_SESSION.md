# Next session — Desktop validation and release hardening

Updated: 2026-10-02
Status: **Lightweight runtime implemented; development alpha, not production-ready.**

## Start here

Read `AGENTS.md`, `SCOPE.md` and `README.md`. Product decisions remain settled. Do not restore the old journal writer or repeat product planning. The runtime now uses independent native period pages, optional Jalali, per-graph setup, localized-first page titles for new periods, editable summary-block sidebar requests without a visible `Tasks` heading, guarded Persian starters for fresh default definitions, an explicit action for older empty periods and an on-demand native history page.

`plugins/journal-routines/` is a separate repository. Inspect its uncommitted working tree and preserve unrelated work. The disposable `draft2` graph is not a Git repository: its native default-journal template and technical-property visibility config were updated on user request, but its already-created period pages and user journal data were not edited directly while Logseq was running. No commits or branches were created.

## Source map

| File | Responsibility |
| --- | --- |
| `src/index.js`, `src/register.js` | Production entrypoint, toolbar/palette commands, lazy setup UI and lifecycle cleanup |
| `src/routines-view.js` | Dependency-free setup, per-graph approval and inline calendar confirmation |
| `src/routines-runtime.js` | Graph-pinned serialized actions, explicit guarded examples, Persian Calendar presentation, settings, current periods, sidebar, day/resume lifecycle |
| `src/period-model.js` | Local civil date, Gregorian periods, calendar-qualified identities and ownership |
| `src/period-snapshot.js` | Header-aware copying, durable native summary root, interrupted creation verification and preservation |
| `src/routine-history.js` | On-demand native history page and queries |
| `src/daily-template.js` | Explicit native daily-template installer, original-task queries, verified graph-owned calendar/definition context and exact generated-presentation refresh |
| `src/daily-today.js` | Explicit native `:today` resolution, empty/one-blank-block preflight, durable application intent and native insertion verification |
| `src/daily-presentation.js` | Native marked-query styling: hide confirmed empty priority/pending, flatten query wrapper only |
| `src/activation-storage.js` | Reused IndexedDB metadata storage and exact-path graph identity |
| `src/calendar-client.js` | Reused validated Persian Calendar API transport |
| `scripts/validate_routines.cjs` | Chromium assembled-plugin fixture, not a live Logseq host |

## Confirmed host-source findings — do not regress

Official Logseq tag **0.10.15** was inspected:

- `src/main/frontend/handler/page.cljs` (`build-page-tx`, lines 101–123) creates a properties **pre-block** even with `createFirstBlock:false`.
- `src/main/frontend/handler/editor.cljs` (`properties-block`, lines 658–674) gives it its own UUID/ID and page/parent/left references. `getPageBlocksTree` includes it.
- `src/main/logseq/api.cljs` (`upsert_block_property`, lines 742–744) targets the supplied block; it does not redirect a page UUID to its header.
- Direct pre-block property updates need not immediately mirror into `getPage().properties` (`frontend/modules/outliner/core.cljs`, `Block.-save`). Read mutable checkpoints from the header itself. Keep immutable ownership/plan metadata verified against the page.
- SDK normalization can expose `preBlock`; raw/preBlock? aliases are also checked. The first content root follows the header ID, not the page ID.
- DataScript 1.5.3 supports the query's `get`, `str`, `contains?` and equality functions; host query transforms receive flattened page results. That source audit is **not** a Desktop query execution result.

Initial mocks incorrectly assumed empty trees after page creation with properties and page-UUID property writes. Those assumptions were corrected in runtime, snapshot, history and browser fixtures. Do not simplify tests back to them.

## Actual validation completed

```sh
npm test                 # 634 passed after streamlined Setup and guarded combined action
npm run test:browser     # 22 Chromium fixture checks passed, including combined/routine-only Setup
npm run build            # passed, dist/index.js about 322 KiB unminified
```

Current bundle is approximately 322 KiB, including SDK, unminified (gzip size not remeasured). Chromium executable in this workspace: `/usr/bin/google-chrome` (rediscover if the environment changes).

Automated coverage includes Gregorian/Nowruz boundary fixtures, nested task copies, stale page-property mirrors, metadata collisions, interrupted writes, user edits/deletions, graph changes during writes, calendar switching/back, dependency absence, native history generation, duplicate triggers, rollover, idle call counts and listener cleanup. Real Chromium IndexedDB persistence is exercised separately from fake task/graph APIs.

## Daily-template extension — 2026-10-01

User approved the optional native daily template: Focus, Tasks, unfinished priority A excluding WAITING, Pending = WAITING, and real-current-week routine/manual tasks. Installed through Setup's **Install daily journal template**, separate from Enable, after explicit approval if another default exists. No live graph was installed/changed by the coding agent.

- Native `App.getCurrentGraphConfigs/setCurrentGraphConfigs("default-templates")` preserve sibling entries; the setter's returned acknowledgement does not await the host disk-write promise. Verify after reload.
- Ordinary template page/root with `template-including-parent:: false`; blank Focus/Tasks child blocks and native original-block queries. No automatic plugin journal creation/insertion, copying, daily-ref insertion or history traversal. The explicit empty-today exception added on 2026-10-02 is described below. Native insertion applies to eligible empty today/future journals, not strictly only never-created pages; populated journals are untouched.
- This week uses verified weekly period metadata and native scheduled/deadline dates, including manual tasks on the weekly page. No weekly page means no weekly results. Context stores calendar plus parser-stable prefixed definition page UUIDs; it follows settings across calendars without rewriting journal query blocks. One verified root text save updates context fields together, preserving other root text and descendants. Failed optional synchronization warns in Setup but does not reject core settings; startup/day/Show current retry. Incomplete/deleted installation is never refilled.
- Disable/unload leaves the native default/template intact, while stopping new routine creation. Users can independently change/remove the native default.
- `scripts/validate_daily_queries.cjs <pinned-host-main.js>` passed **26 isolated native DataScript fixtures** using real UUID datoms/query/rule evaluation: Saturday/Monday and month/year/Nowruz bounds, switch/back, WAITING/DONE/priority-A filters, definition exclusions including boolean/numeric names, and duplicate match elimination. The hash-pinned script never launches the app or accesses graph/profile data. Not native Markdown parsing, clock resolution, renderer, config persistence or Desktop insertion evidence.

Desktop gate: on a fresh disposable graph, install with no default; verify five sections on the next eligible empty journal, editable original query tasks and breadcrumbs. Test existing-default refusal/explicit replacement while preserving its content and sibling config. Verify manual weekly-page tasks, scheduled/deadline inclusive boundaries, completed-task removal, selected definition exclusion, calendar switch/back, populated journals unchanged, edited template sections preserved, repeat installation, disabling, and config persistence across reload. Check open-query midnight/resume refresh and large-graph native query cost. Do not erase earlier test graphs, markers or journal data to simulate freshness.

## Daily-template Desktop follow-up — 2026-10-02

User screenshot confirms template sections and two native weekly results on Oct 2, while Oct 1 was expected. This does not establish a date-offset bug: installation only selects a default, and native Logseq applies it on mounted eligible today/future pages. Source audit confirms the automatic path's strict `page-empty?` skips a journal with even one existing blank block. The actual Oct 1 graph state was not inspected.

Implemented a separate **Apply daily template to today** action: graph-pinned native `:today` query, verified existing Markdown journal, no formatted page names or journal-page creation; only empty/one-blank-root targets without user properties/children, no current editing, durable attempt before writes, native `App.insertTemplate`, fresh-UUID/tree/content verification. Native getTemplate registration can lack children: source is separately loaded with getBlock(includeChildren:true). Blank insert acknowledgements can be UUID-only: actual identity comes from read-back. Uncertain application never blindly retries or erases data.

Template headings now have suitable icons. Native queries use title markers and disable grouping/breadcrumbs/table rendering. Scoped CSS hides confirmed empty Priority A/Pending only when their query is the sole child; errors/unrendered queries/extra notes remain visible. It flattens query wrappers without hiding task bullets or real task nesting. Explicit reinstall refreshes only exact recognized generated template heading/query text, preserving custom sections. Existing populated journal query blocks are not retrofitted.

Validation: 626 Node tests, 20 assembled Chromium smoke checks, 26 pinned native DataScript fixtures, build about 316 KiB. The new Chromium native-shaped DOM fixture passes empty/result/error/extra-note/indent/task-bullet assertions. These are not Desktop rendering/application evidence. No live graph writes were made by the coding agent.

Next Desktop test: reload plugin, explicitly reinstall to refresh untouched source presentation, finish editing, open today's journal through native navigation if missing, and click Apply daily template to today. Verify today—not viewed tomorrow—receives sections once, and populated today refuses unchanged. Check empty priority/pending hiding/return on results, errors visible, icons, weekly indentation and editability. Tomorrow's existing content remains untouched; do not clear markers or rewrite journals to force a re-test.

## Streamlined Setup follow-up — 2026-10-02

User reports the preceding daily-today/layout changes work, then requested improved installation/setup UI and fewer actions. The primary **Set up this graph** explicitly saves approved choices, enables routines, installs the selected daily template and attempts guarded today application. Daily inclusion is visibly selected/recommended but can be unchecked; replacing another native default still requires approval. Detailed guidance, definition fields and manual tools are collapsed under More options. Current graph/status pills, section preview, busy primary action and live completion/partial-completion feedback replace the previously crowded first view.

Combined setup stops on graph changes/Disable/unload/errors, without pretending the SDK sequence is atomic. Only coded preflight today refusals can become an unchanged-today result; post-intent application errors remain failures. A recorded earlier attempt is never retried/rebuilt. Missing today gets a native-navigation instruction. Individual manual actions remain strict and accessible.

Validation after this UI/workflow change: 634 Node tests, 22 Chromium smoke scenarios, 26 pinned native DataScript fixtures, clean diagnostics and build about 322 KiB. Browser fixtures cover combined setup with a missing native today page and daily opt-out; registration tests cover sequencing, opt-in, replacement refusal, partial errors and interruption. No live graph/config changes by the coding agent. The streamlined screen and combined workflow require a new Desktop check; user confirmation of the earlier layout is not validation of this newer workflow.

## First-run onboarding follow-up — 2026-10-02

The existing setup panel now automatically welcomes a graph with no saved routines settings. **Create my first routine system** reuses guarded combined setup; **Skip for now** / idle Escape persist only a graph-local preference. Toolbar/palette Setup can always reopen it. Successful core initialization marks completion, existing saved settings suppress the welcome, and completion offers **Open my routines**. No duplicate task or onboarding database, automatic graph writes on mount, or new dependencies.

New Node regression tests cover first-run persistence, graph isolation, stale skip refusal, saved alpha settings, skip/reopen, creation controls, initialization completion and preservation of existing definitions/edited periods. **Not executed in this session**: tools provided no terminal/browser execution, so `git status`, `npm test`, build and Chromium validation were unavailable. Earlier results above predate this change. No graph data was edited.

Onboarding hardening now separates graph-local initialization intent/evidence from the welcome preference. Records precede graph writes and remain pending across skip/Disable/reload. Automatic startup pauses incomplete setup; explicit retries verify the pinned current periods and deterministic starter prefix, rejecting ambiguous/deleted/edited resources or changed settings/periods. Verification no longer forces sidebar opening with auto-open off. Action-generation guards discard stale UI errors/navigation/toasts after Disable, and standalone Enable supplies the same completion handoff. Browser assertions now cover fresh welcome, persistent skip, existing saved settings, initialization, sidebar opt-out and explicit navigation. Additional Node regressions cover lost ACK, failed starter insert with all welcome preferences, reload, source/summary safety and completion ordering. These hardening tests/build/browser checks remain unrun here because no execution tool is available; clean editor diagnostics are not test execution. `SCOPE.md` was not changed.

Before beta: run the automated suites/build, inspect the Git diff, then test plugin enable with a fresh disposable graph, idle Skip/Escape, reload after skipping, toolbar reopen, successful creation/sidebar handoff, daily opt-out/refusal, enabled-error startup, rapid graph switching and unload during the welcome/status request. Verify that no pages are created until explicit approval and that a skipped graph stays quiet after reload.

## Final beta safety hardening — 2026-10-02

- Missing definitions now use `page-metadata.js` with empty metadata: acknowledged identity and fresh page/root state are verified, native title headers are preserved, and no bootstrap or ownership properties are added. Existing definitions and durable initialization intent/refusal behavior remain unchanged.
- Daily context synchronization ignores fenced metadata examples and requires one unfenced line per context key, matching the verified SDK value before a single text save. Other text, CRLF and descendants remain intact; ambiguous text refuses without writing. This is conservative fence recognition, not a complete Markdown parser.
- Added focused regressions in `page-metadata.test.js`, `routines-runtime.test.js` and `daily-template.test.js`. Tests/build/browser validation and Git status/diff were **not executed** because no terminal tool was available. Earlier pass counts do not validate these changes. No live graph data or config was changed.
- Remaining limits: non-atomic SDK operations and already-dispatched writes, no cross-profile exactly-once guarantee or automatic repair, and actual Desktop parsing/indexing/persistence validation. This prevents unsafe future writes; it does not repair existing Bean-affected graphs.

## Remaining release gate — actual Logseq Desktop

User screenshots of disposable graphs confirmed the manifest icon/toolbar, enabled Jalali page creation, and (in `draft4`) native compact summary-block panes ordered weekly above monthly, with period labels **inside** those panes and technical page names as native headers. Later screenshots show the localized page-title/starter-task build and editable compact panes in Desktop, but also exposed mixed-direction ordering in the Jalali captions. The latest user screenshot still exposed mixed-direction ordering with the single-line caption. Captions now place the label above a smaller, subdued range, with independently RTL weekly and LTR monthly date ranges. `npm test`, `npm run build` and 18 browser fixture checks passed after this presentation-only change; actual Desktop rendering remains to be checked. A later screenshot of the next day shows a metadata-bearing full monthly page pane and a separate `jr-snapshot-state` pane. The runtime's fallback from an unverified planned summary to the full page has now been removed, but this fix and the cause of the separate pane still require live Desktop verification. Never auto-close unrelated sidebar panes or delete graph metadata. Manual example insertion and the `draft2` daily template also remain unverified in Desktop. Logseq is running as a Flatpak, but no `logseq` command was found on PATH here. Do not edit its open period Markdown files behind the host or use personal notes for failure injection.

1. Reload the rebuilt plugin from its project root on a **fresh disposable** Markdown graph. Choose Jalali, then Enable with both default definition pages absent. The SDK should create two editable Persian TODOs in each definition and each current period, with a nonprinting grouping anchor rather than a visible `Tasks` heading. Do not reset/delete old periods or storage to simulate a fresh graph. Existing/selected definition pages remain untouched, and older named period pages stay under their original names.
2. Verify weekly above monthly and localized **native pane headers** beginning `هفتهٔ ۲۸ · ۱۴۰۵` / `مهر ۱۴۰۵`, with the civil start as a unique suffix. The pane should show the two Persian TODOs without a `Tasks` heading, repeated period label or prominent `jr-*` properties. Test on the following day/reload as well: an unverified summary must pause with a warning rather than opening a full period page; record whether the independent `jr-snapshot-state` pane was manually opened or created by a host action. Check whether Logseq renders an empty grouping bullet and report that separately. Reload and confirm no duplication or refill. For older verified empty periods only, Setup's **Add two Persian examples per routine** remains the explicit action and must refuse edited pages. On `draft2`, separately check `:block-hidden-properties` and verify the native `Daily Journal` template applies Focus, Tasks, Notes and review only to **new** days; old days remain untouched.
3. On another disposable graph, seed nested definitions (including property headers, fenced text, DONE tasks and links) **before** Enable. Confirm TODO clones, fresh UUIDs and correct hierarchy under the new summary block. Complete/edit/delete tasks, reload, then check no duplication or refill. Also test Gregorian alone without Persian Calendar, startup/rollover pane reuse, unrelated panes and manual closure; browsing an old journal must keep real-world current periods.
4. Validate the native history queries: both sections render readable linked pages, newest first across calendars. Clicking opens original pages without creating snapshots. Check empty results, many periods and native query refresh cost; no plugin background scan is intended.
5. Load the real Persian Calendar provider. Check API availability, Jalali months/Saturday weeks, calendar confirmation cancel/switch/back and provider disable/re-enable. Old pages/tasks must stay intact.
6. Switch graphs rapidly, disable/unload during pending work, resume after sleep and test date/timezone changes. SDK calls already dispatched are not cancellable; document any actual host races rather than promising atomicity.
7. Verify interrupted creation on disposable data only. Ambiguous outcomes must pause without deleting content or blindly recopying. Deliberately deleted period/history pages must stay deleted while their local creation markers remain.
8. Measure live startup and large-history performance, fix observed host incompatibilities, rerun automated checks, then consider production packaging/documentation. Do not publish readiness claims before this gate.

## Active incident — incorrect restored panes / closing failure (2026-09-28)

The user reports the metadata pane persists after the summary-fallback fix and that closing Logseq may fail. Do not claim the previous patch resolved the Desktop incident.

Read-only inspection confirmed Logseq Flatpak 0.10.15 is running and its external-plugin preferences point at this project. The active test graph's two period Markdown files retain the planned summary UUIDs and nested TODOs. No graph files, application preferences, caches or processes were modified.

The host main log at 14:05:16 contains `Error: no ipc handler for` followed by a BrowserWindow dump. In official 0.10.15 `electron/handler.cljs`, the default IPC handler logs the window argument, not the unsupported request, so this does NOT identify the closing failure or implicate this plugin. Renderer console evidence is still needed.

Source audit (not a live reproduction): `logseq/api.cljs` `open_in_right_sidebar` resolves UUID requests through `frontend/handler/editor.cljs` to numeric database IDs. `frontend/handler/ui.cljs` persists/restores sidebar tuples under `ls-right-sidebar-state` without UUID verification. Reindex rebuilds the DataScript database, so previously saved IDs can potentially resolve to different entities. Ordinary reload of the same serialized database is not evidence of ID reassignment. `frontend/state.cljs` also deduplicates added sidebar entries by numeric ID without graph identity; rendering itself is graph-filtered. Property names are native page links, another possible route to the separate `jr-snapshot-state` pane.

Next evidence: clarify whether the entire window refuses to close or panes return after relaunch; capture main-renderer `localStorage.getItem("ls-right-sidebar-state")`, `window.logseq.api.get_state_from_store("sidebar/blocks")`, and console errors around one normal close attempt. Compare pane IDs with the exact expected summary UUIDs before/after the failure. Do not clear storage, reindex, kill Logseq, or auto-close unrelated panes to mask this incident.

### Follow-up evidence: persistence failure, not merely presentation

The user confirmed that the entire Logseq window refuses to close using ×. During graph reopening, Desktop shows `Internal status sync failed.` The main-renderer saved-sidebar key is `null`; live `sidebar/blocks` includes d5 IDs 36/39 as `block` and entries from several other graphs. This does not demonstrate localStorage restoration. The d5 monthly planned summary UUID on disk is `6aba6002-c44a-4d5c-afea-2ef48975b5f8`; weekly is `6aba6001-b115-4850-b746-d1f65b5d566c`.

Official 0.10.15 source/bundle trace: the toast is `:graph/persist-error` (`resources/dicts/en.edn`, `frontend/ui.cljs`), displayed after `frontend/handler/repo.cljs` `persist-db!` fails during graph switching. That wrapper logs the original exception to the renderer console. Desktop `frontend/db/persist.cljs` dispatches `saveGraph` without awaiting its promise, then returns legacy IndexedDB cache deletion; the toast alone therefore does not prove a disk-write error. Serialization, callbacks or IndexedDB deletion can fail too.

The close path in `electron/listener.cljs` sends `persistent-dbs-saved` on success and `persistent-dbs-error` on failure. `electron/electron/handler.cljs` handles only the success message in this release; `electron/electron/window.cljs` waits for the persistence-success channel before destroying the window. A persistence failure can therefore explain the unhandled-IPC log and stuck closing together. The original persistence exception remains unknown; do not attribute it to this plugin without that evidence.

Next: get the original expanded renderer-console exception/stack with Preserve log enabled, and resolve d5 numeric pane IDs 36/39 versus the two planned UUIDs while d5 is active. Do not replace further plugin code or reset caches based solely on the toast.

### d7 activation report

The user reports a fresh d7 shows Enabled and `Deleted period ... is preserved as deleted`. Read-only inspection found only `pages/contents.md`; host log already mentions this exact d7 path at 13:01 (deleting its search index), before opening the current folder at 22:05. Thus the path is not previously unknown to the host, even if its folder is now empty. Plugin path-scoped creation markers survive folder reuse. The warning establishes a prior creation record plus an absent lookup, not proven deletion or successful prior creation.

The runtime warning now describes an unavailable previously attempted period; setup shows `Enabled — attention required` when activation is saved but an error exists. Regression coverage verifies an emptied/reused path retains safety markers without recreating pages. No graph data or markers were reset. These changes improve accurate reporting; the underlying host persistence failure and sidebar incident remain unresolved pending the original renderer exception.

### Root-cause evidence — unsupported Bean in graph serialization

The user supplied the original renderer exception: `Error: Cannot write $cljs_bean$core$Bean$$`, from Transit `marshal`/`emitObjects`/`emitMap`. This identifies graph serialization, before disk persistence, as the failing operation. Do not continue diagnosing this as merely a sidebar/CSS issue.

Official 0.10.15 source and installed bundle audit established a write path in this plugin that produces this value: `logseq.api.create_page` converts its JS properties argument with `bean/->clj`; `frontend/handler/page.cljs` `build-page-tx` assigns that Bean directly to page `:block/properties` and (in the ordinary header branch) to the pre-block. DataScript treats properties as a scalar value; outer transaction cleanup does not recursively materialize the Bean. The plugin's string-only property values and JSON-string plan do not prevent this container-type defect. Both `period-snapshot.js` and `routine-history.js` call this nonempty-properties creation API.

Header `upsertBlockProperty` calls normalize the header map but save a partial block without `:db/id`; `outliner/core.cljs` page-property mirroring depends on that ID, so the page Bean can remain. This matches the previously observed stale page-property mirrors and explains why successful mocked checkpoint tests did not detect the persistence defect. The exact failing live entity has not been inspected; additional sources of Beans are not ruled out.

Prevention IMPLEMENTED in `page-metadata.js`, used by period and history creation: create an acknowledged fresh page with null properties; verify any native title header or an exact newly inserted first-root bootstrap block; write complete metadata as text via `updateBlock`, which reparses into native persistent maps and mirrors page properties; verify pre-block, page ownership, identities and initial checkpoint before snapshot writes. Existing native title metadata is preserved. Durable attempt markers still precede writes; interrupted ambiguous bootstrap pauses, never adopts/rebuilds existing pages. Source audit corrected two fixture assumptions: an insert acknowledgement need not contain numeric `id`, and native title metadata need not be mirrored on the page until the full-block save. Do not replace this with `JSON.parse(JSON.stringify(properties))`, which still becomes a Bean at the same host boundary. The alternative root host fix is recursive JS-to-CLJS materialization in `create_page`.

Existing in-memory Beans are not repaired by merely changing future creation or disabling the plugin. Recovery needs a separately authorized, verified, content-preserving procedure; an unchanged `updateBlock` may be skipped by the host. Do not clear caches, force quit, reindex, erase markers, or rewrite graph files behind Logseq. Both period/history creation paths are now covered. `scripts/validate_host_metadata.cjs` was executed against the audited installed bundle (SHA-256 `6e1363dd5a4f61cc23905c4df65268a132e1c02692651cb01f5d5a561a08dbf5`): real Bean-in-DataScript-Datom serialization reproduces the reported exception, and an equal native persistent map serializes successfully. The script runs extracted dependency sections in an isolated VM, uses only Node built-ins, rejects other hashes, and never accesses graph/profile state or launches Logseq. This is serializer-only evidence, NOT a full database/parser/updateBlock/Desktop persistence test. The user disabled the plugin; keep it disabled on affected graphs until safe recovery and real Desktop verification. No graph files, settings, markers or host processes were modified.

## Known alpha limits

No cross-device exactly-once guarantee or automatic repair/recreation. Graph path changes and erased plugin storage lose local activation/deletion evidence. Definition custom properties/scheduling metadata are not copied. References stay references to their original targets. History query rendering and host indexing latency remain unverified. Unsupported data/uncertain writes pause rather than risk overwriting edits.
