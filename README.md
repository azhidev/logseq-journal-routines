# Journal & Routines

## 0.4.5 — restrict native journal lookup to pages

The runtime's native-date query previously matched every entity with `:block/journal-day` and a UUID, including ordinary journal blocks. This could falsely report `duplicate-journal` with only one actual journal page. The query now also requires `:block/name`, restricting candidates to pages. Two actual pages sharing a date still block, as do malformed responses. No journal names, dates, content or recovery records are rewritten.

The runtime fixture now models dated blocks instead of silently restricting all date queries to pages. A regression reproduced the exact false `duplicate-journal` pause with one page plus nested notes before the fix. The corrected query passes that scenario and preserves the notes; another regression still rejects a second actual page before further writes. The browser fixture also requires the page-only clause.

Validation for 0.4.5: **825 Node tests**, **7 production activation Chromium groups**, **13 legacy-preview Chromium groups**, build and diff checks passed; runtime diagnostics are clean. Browser tests use a mocked SDK, not live Desktop.

The earlier manual diagnostic query was misleading too: its second date-bearing entity was not restricted to a page, and its scalar rows did not display usefully in the default block/page table. A reported result count from that query is **not evidence of that many duplicate journals**. Do not delete, merge, rename or re-index journals based on it.

Reload and confirm **Build 0.4.5**, then **Refresh status**. If you previously clicked Disable, it remains disabled; review the confirmations and choose **Enable** only when ready to resume approved automation. Existing enabled intent can resume automatically after validation. Live confirmation on the user's graph remains pending.

## 0.4.4 — reconcile Desktop heading metadata

A reproduced setup compatibility bug caused `recovery-conflict` after inserting a template heading: Desktop 0.10.15's Markdown parser adds numeric `heading: 2` to a `##` block's properties, while setup expected an empty property map. Host evidence: [`with-heading-property` and `construct-block`](https://github.com/logseq/logseq/blob/0.10.15/deps/graph-parser/src/logseq/graph_parser/block.cljs#L555-L583). Setup now accepts exactly `{ heading: 2 }` for its six section presets (as well as the existing no-metadata representation). Exact text, UUID, position, absence of children, other properties and the prior-state hash must still match.

Validation for 0.4.4: **823 Node tests**, **7 production activation Chromium groups**, **13 legacy-preview Chromium groups**, build and diff checks passed; setup-service diagnostics are clean. Fixtures now include host-derived heading metadata. New regressions cover all six pending headings, read-only inspection, no duplicate insertion, and rejection of altered metadata/content/identities or unrelated sampled edits. These are automated fixture results, not live Desktop verification.

This does not strip heading metadata from existing snapshots, change checkpoint formats, reset recovery state, or authorize writes automatically. A 0.4.3 checkpoint paused at a successfully inserted heading can be reconciled after reload if no other sampled state changed. Inspection remains read-only; the user must review and approve the remaining setup operations before resuming. Other recovery conflicts still block.

Reload, confirm **Build 0.4.4**, and choose **Refresh status** before approving anything. If the blocker clears, review the remaining additions and backup/legacy confirmations before **Set up & Enable**. If `recovery-conflict` remains, preserve the checkpoint and content for further diagnosis; do not delete or recreate the heading or clear plugin storage. The user's exact live checkpoint has not been inspected, so this is a verified compatibility fix, not a claim that every recovery conflict is resolved.

## 0.4.3 — Desktop page-identity compatibility

The reported `tree-read-failed` exposed an SDK/host argument mismatch. Desktop 0.10.15's `get_page_blocks_tree` passes its argument directly to a lookup accepting a page-name or UUID string; it does not unwrap `{ uuid }`, despite SDK 0.0.17 declaring that form. Discovery, source revalidation and writer tree reads now pass raw UUID strings. The writer's target-page and UUID-collision `getPage` lookups use strings too. UUID-based identity and all existing validation/recovery checks remain intact; failed reads are never treated as empty.

Host evidence: tagged [tree API](https://github.com/logseq/logseq/blob/0.10.15/src/main/logseq/api.cljs#L769-L775), [page lookup](https://github.com/logseq/logseq/blob/0.10.15/src/main/frontend/db/model.cljs#L1040-L1044), and [`get_page`](https://github.com/logseq/logseq/blob/0.10.15/src/main/logseq/api.cljs#L542-L548). Node and browser SDK fixtures now reject object identities for these reads rather than masking the mismatch.

Validation for 0.4.3: **808 Node tests**, **7 production activation Chromium groups**, **13 legacy-preview Chromium groups**, build and diff checks passed. The strict adapter fixture reproduced `tree-read-failed` before the fix and passed afterward. Browser checks use a mocked SDK, not live Desktop.

Reload the plugin, confirm **Build 0.4.3**, then use **Refresh status**. Existing enabled intent is preserved, so enabled automation can resume after validation. Do not delete pages or clear activation/recovery storage. Live Desktop verification of this fix remains pending; continue using a disposable graph for writer validation.

## 0.4.2 — identify the failing read

Runtime and discovery read failures now identify the fixed SDK operation and distinguish rejection, timeout and unsupported response shape. Examples: `owner-query-failed`, `owner-period-shape`, `configuration-shape`, `journal-row-shape`, `tree-read-timeout`. Duplicate native journal identities are reported as `duplicate-journal`, not a generic read failure. Unexpected internal exceptions are identified separately rather than suggesting damaged graph data or more indexing waits.

Only hardcoded operation names and diagnostic codes are shown—never raw SDK errors, page names, paths, UUID values or note contents. Unsupported responses still block; this update does not reinterpret missing data as empty or weaken write checks. The user's live failure remains unidentified until its operation-specific result is observed. Do not delete graph resources in response to these messages.

Validation for 0.4.2: **808 Node tests**, **7 production activation Chromium groups**, build and diff checks passed; runtime diagnostics are clean. Live Desktop compatibility remains unverified.

## 0.4.1 — discovery retry fix

The one-minute automatic scan cooldown no longer replaces the last actual discovery failure with “Graph evidence changed.” Known adapter failures now have distinct sanitized messages/codes (including `invalid-page`, `duplicate-period-owner` and `scan-limit`); unknown responses remain generic and cannot leak graph contents. A cooldown alone is not evidence that graph content changed.

**Refresh status** can explicitly retry discovery immediately, including a failed pre-setup scan while automation is inactive. That pre-setup refresh is read-only and never reuses approval. An explicit Enable attempt also performs fresh discovery instead of getting stuck behind its previous failed attempt. Background callbacks remain throttled and all write authorization/precondition checks remain intact. No graph content was repaired or deleted by this patch; a live graph's underlying scan failure still needs its exact result.

Validation for 0.4.1: **799 Node tests**, **7 production activation Chromium groups**, build and diff checks passed. Runtime diagnostics are clean. These are mocked-SDK checks, not a live Desktop repair verification.

## 0.4.0 — setup, Enable and automatic journals

**This build can write graph content after explicit setup approval. It is no longer a read-only preview.** Target: Logseq Desktop **0.10.15**, Markdown file graphs. Persian Calendar is the only plugin dependency; starter scripts/styles, Habits, Finance and Dashboards are not required.

**Experimental Desktop writer:** automated integration tests pass, but this complete write-enabled build has not been verified inside live Logseq Desktop. Start with a disposable graph. Do not interpret fixture results or a successful Calendar check as proof that personal-graph writes are safe.

### Start here

1. Build/reload this plugin and load Persian Calendar. For an unpacked install, select this folder (with `package.json` and `index.html`), not `dist/`.
2. Click **JR**, or run **Journal & Routines: Status, setup and Enable / Disable**. Confirm **Build 0.4.5**. Loading no longer opens a preview modal or authorizes writes.
3. Review the additions. Make a graph backup; confirm there is no overlapping legacy journal automation and that you are using a disposable graph or have completed the relevant live safety checks. These are explicit user declarations, not automatically verified facts.
4. Choose **Set up & Enable**. Missing routine pages receive the starter tasks; missing daily-default receives the six headings and Persian review prompts. Existing pages—including empty routine pages—are preserved, never reseeded. Missing unambiguous template sections can be appended without replacing existing content.
5. When the journal template setting is unset, setup uses the verified `App.setCurrentGraphConfigs` API to select `daily-default`, preserving other default-template entries and unrelated settings. A configured custom template or ambiguous definition blocks rather than being silently replaced. If the setter is unavailable, the UI provides the exact manual configuration step.
6. Logseq remains responsible for creating native journal pages and applying its template. If today's page does not yet exist, open today's journal normally; Journal resumes when the host creates it. It does not guess names or fabricate journal-day metadata.

Once enabled, startup, navigation, relevant database changes, day rollover and wake/resume schedule automatic work. Today initializes period tasks; future journals get structure only. Earlier journals are read when needed to reuse a current-period owner but are **not modified automatically**. A template installed after today's page already existed does not retroactively inject every preset review prompt into that page.

Weekly/monthly owner panes open independently, reusing the host's deduplication and preserving unrelated panes. The auto-open checkbox can be disabled. **Disable** stops new automatic work and persists off without removing generated content. A Calendar failure pauses writes while retaining enabled intent; fresh validation permits recovery without daily reapproval. Setup/status stays accessible through JR rather than reopening on each startup.

### Preservation, execution and recovery

- Existing notes, task completions, Gregorian page identities, loaded owners and block UUIDs are preserved. A loaded owner is not refilled after its tasks are deliberately deleted. Routine edits affect a later new period rather than resetting existing snapshots.
- `activation-runtime.js` connects the existing engine/reader to `setup-service.js`, `journal-writer.js`, durable `activation-storage.js` and independent `routine-sidebar.js`. `activation-view.js` is the new SDK main UI. Legacy preview components remain available for regression tests, not production startup.
- Activation keys hash the exact graph path, not the display name or random scan ID. Records use plugin-local IndexedDB with strict transaction durability. Loss/eviction of that browser storage loses activation/recovery metadata; it is not part of an ordinary graph-folder backup. Never clear storage to force a retry of uncertain writes.
- Graph-scoped Web Locks serialize cooperating same-origin plugin windows. Missing Web Locks or durable storage blocks writes. They do not lock out other profiles, legacy scripts or user edits.
- Every journal mutation gets fresh graph/date/activation/Calendar and source/owner checks plus narrow operation preconditions. Host-added matching `id::` lines are normalized for comparisons; persisted identities are retained during updates. Conflicting identities block rather than being stripped.
- Setup has durable preset-operation recovery. The writer records UUIDs, hashes and progress, not private note snapshots. **Confirmed partial journal work can resume only while its original plan is still in memory. After restart, an unfinished writer checkpoint without that plan pauses for explicit recovery review. Fully automatic crash recovery is not implemented.** Uncertain remote writes are never blindly replayed or destructively rolled back.
- Full owner discovery remains bounded (3,660 pages / 10,000 blocks / 30 seconds) and is throttled to once per minute, except required post-setup rediscovery. Valid target/source evidence is cached for up to 15 minutes and rechecked using targeted reads/indexed claims. Changed evidence pauses until rediscovery; a second target may wait for the retry interval. Oversized/unsupported graphs block, not truncate silently.
- SDK reads/writes are not atomic transactions. Already-issued calls cannot be cancelled, delayed indexing can obscure concurrent changes, and conservative page-wide preconditions can pause on unrelated edits. This is not a claim of race immunity.

### Legacy coexistence

Do not enable Journal alongside the starter's journal scheduler. `custom.js` also owns unrelated Habits, Finance, bidi and dashboard behavior: **do not simply delete or disable the entire script**. This build neither reliably detects a running legacy script nor automatically splits it. On a legacy graph, disable only the overlapping journal writes/historical migration and resolve overlapping sidebar ownership before confirming setup. No legacy scripts were edited for this release. A clean graph requires none of these conditional legacy steps.

### Validation and remaining live gate

Run from this folder (Node 24 was used):

```sh
npm ci
npm test
npm run build
npm run test:browser -- /usr/bin/google-chrome
npm run test:browser:preview -- /usr/bin/google-chrome
```

Use an installed Chromium executable path. The production browser fixture uses a bounded real-time DevTools session, actual IndexedDB and Web Locks, and a mocked SDK. The preview fixture explicitly bundles legacy preview components, not the production entrypoint.

Validated on **2026-09-19**: **792 Node tests**, **7 production activation Chromium groups**, **13 legacy-preview Chromium groups**, and build. Production coverage includes actual DOM approval → resource writes → journal writes, host-style identity properties, configuration preservation, no-op replay, persisted enabled/disabled state, Calendar pause/recovery, graph isolation, independent panes and shared unload cleanup. Node integration tests additionally cover rollover, future journals, source edits, interrupted writes and uncertainty. **None of these is live Desktop verification.**

Next live check: on a disposable Desktop 0.10.15 graph with only Calendar and Journal, run the complete setup/Enable path; verify page/task identities, next-day owner references, reload, Calendar loss/recovery, graph switch and Disable. Remaining product limits include custom-template choice handling, conservative large-graph support, explicit legacy separation, and restart recovery without the private original plan. Do not call the plugin fully production-ready until these limits and the live gate are addressed.

## Historical implementation notes — 0.3.0 and earlier

The sections below preserve prior work/evidence. References to “read-only”, startup preview, missing executors, old versions and next steps describe those older builds; the 0.4.0 instructions above are authoritative for the current entrypoint.

## Inspect today's journal engine — new in 0.3.0

Run **Journal & Routines: Inspect today's journal engine (read-only)** from the command palette. This is separate from **Refresh preview**, which still inspects only setup resources.

The command:

1. Checks Calendar and selects today's native Gregorian journal day.
2. Enumerates the graph's SDK page inventory and reads every inventoried page tree, including non-journals, old/future journals, and routine pages. UUID-tuple children are resolved with bounded `getBlock` reads.
3. Checks page/block identities and managed-property consistency, finds all claims for the requested periods, and blocks duplicate or misplaced owners rather than accepting the first match.
4. Runs the real journal engine on the normalized snapshot, then rechecks the page inventory, graph context and today's date before reporting.
5. Shows only page/journal/block counts, proposed insert/update/move/remove counts, and whether each routine owner is existing, new, or absent. **No proposed changes are applied.** Private snapshot/projection data, note bodies, paths and UUIDs are not logged or returned by the command.

The pipeline starts only when this command is invoked—no full-graph scan runs at startup or on a polling timer. It holds graph-change and DB-change listeners through collection and engine planning, then releases them. Edits, graph changes, superseding requests, external cancellation and unload discard pending results; stale/cancelled commands show no late toast. Use an idle disposable Markdown file graph for live verification.

**Bounds:** 3 seconds per SDK invocation, 30 seconds total, up to 3,660 total pages, 10,000 source blocks, 40 tree levels, 4,000,000 content code units and 20,000 SDK calls including graph checks. Exceeding a limit blocks the scan; data is never silently truncated. Large/unsupported graphs may therefore be blocked in this first bounded collector. SDK reads return whole responses, so local bounds cannot prevent the host from initially allocating/transmitting a large response.

Missing routines require an explicit null page lookup consistent with the inventory; failed reads are never treated as empty. Org format, ambiguous aliases, metadata-only/conflicting managed properties and incomplete journal identities are unsupported rather than guessed. The scan covers SDK-visible block trees, not unindexed files. Event subscriptions and repeated metadata reads are **not an atomic snapshot**; missing/delayed events can leave concurrent content edits undetected. Success is diagnostic evidence, not setup approval or permission to write.

Validation for 0.3.0: **601 Node tests**, **13 Chromium mocked-SDK fixture groups**, and build passed. New adapter/normalizer/inspector diagnostics were clean. The browser fixture exercises the bundled command with a strict mocked SDK, including full scans, collision rejection, private-summary-only output, DB-edit cancellation and pending unload. **Actual Desktop response shapes, event delivery and real-graph behavior have not yet been verified for this command.**

## Initial journal/routine engine extraction — 2026-09-14

`src/journal-model.js` extracts the starter's text/tree conventions with direct pure-function parity tests. `src/journal-engine.js` implements Calendar-backed journal projections, stable section/owner identities, routine copying, reference reconciliation, and fail-closed collision handling. Repeated projected execution, task completions, Saturday/Nowruz/month rollover, source edits, malformed data and asynchronous graph-context invalidation are covered by in-memory tests.

See **[ENGINE.md](ENGINE.md)** for the internal engine/adapter APIs, snapshot/result contract, precise safety differences from the starter, and remaining integration work. The initial extraction was offline at 0.2.1; the 0.3.0 command above now supplies SDK-collected graph data. No demo routines or graph-writing controls were added.

Validation: **518 Node tests passed** (93 new engine/model tests), **12 Chromium mocked-SDK fixture groups passed**, build succeeded, and new engine/model source diagnostics were clean. The browser fixture still tests the existing preview—not a live graph-writing engine. No live Desktop engine execution was performed.

**Next implementation work:** build on the collector for setup-specific template/configuration collision checks and legacy-automation detection, then approved per-graph setup/backup and a serialized/revalidated write adapter with partial-failure recovery. Startup/navigation/midnight scheduling and live parity follow. Keep the dependency gate before enabling writes; do not restart extraction or spend another milestone on preview polish.

## Safety boundary

- No graph-content writes, file writes, template changes, journal renaming, or historical migration.
- No calendar fallback, provider source imports, automatic dependency installation, or provider enablement.
- No host DOM access, sidebar changes, persisted preferences, or network requests. The setup window renders only inside the plugin's SDK-managed main UI; a supported SDK toolbar item opens it. Installing build dependencies uses npm's registry.
- Existing starter `custom.js`/`custom.css` and the Calendar presentation remain untouched. This probe adds no competing journal scheduler.
- An `available` report is a dated diagnostic observation, **never authorization for writes**. Provider availability can change immediately after any response; API v1 has no atomic availability lease or provider-instance token.

Use a **disposable file graph** for live checks. Do not infer database-graph support from this scaffold.

## Build and load

Requires a current Node.js release (validated with Node 24) and npm:

```sh
npm ci
npm test
npm run build
```

In Logseq Desktop Developer mode, choose **Plugins → Load unpacked** and select this folder, containing `package.json` and `index.html`, not `src/` or `dist/`. Load **Persian Calendar & Experience** separately from its own folder. Either load order should work; the probe retries when Calendar becomes available. Reload this probe after rebuilding.

The setup window should open immediately after loading version 0.3.0. It has **Refresh preview** and **Close** controls; Escape also closes it. Reopen it with **JR** in the toolbar or the command palette action **Journal & Routines: Open setup preview (read-only)**. If you still see no window or JR button, verify that Load unpacked points to this folder and reload this plugin after `npm run build`.

The original diagnostic command remains available:

**Journal & Routines: Check Calendar dependency (read-only)**

A successful check shows today's Gregorian and Persian dates. Failures show which dependency call or validation failed. Details are logged in Desktop's developer console under `[journal-routines:calendar-probe]`.

The probe also checks at startup, on graph changes, and every **30 seconds** when no check is running. Background checks log completed state transitions, not repeated success notifications. The manual command always logs its completed result. No results are saved to the graph. Reports contain sample/today dates, API identity/version, timestamps, or errors—not notes or graph paths collected by the probe. Host error text can contain local details; redact it before sharing logs.

## What the setup preview inspects

- Calendar's freshly validated `describeToday()` result, including the Gregorian/Jalali dates and unchanged `weekly-YYYYMMDD` / `monthly-YYYY-MM` keys. This date check is not the full diagnostic probe or a guarantee of future availability.
- Named pages **Templates**, **Week Routine**, and **Month Routine**. Existing resources are marked as **user-owned review collisions**, not errors to auto-fix or overwrite. Routine counts exclude title wrappers and property-only/empty entries.
- The **daily-default** template through Logseq's global template lookup, so it need not live on the Templates page. Its tree is checked for the six expected sections: **Focus**, **Weekly tasks**, **Monthly tasks**, **Tasks**, **Notes**, and **End-of-day review**. Missing or repeated matching titles are reported for review.

The inspector uses supported read APIs only: `App.getCurrentGraph`, `App.getTemplate`, `Editor.getPage`, `Editor.getPageBlocksTree`, and `Editor.getBlock`. Reads are bounded and cancellable locally; malformed, incomplete, or oversized block trees are reported as unavailable rather than empty. Calendar absence does not prevent named-page inspection, but no period data is fabricated.

The window shows inspection summaries and proposed new content/target identifiers, not existing note bodies or graph paths. It does not enumerate every template definition, inspect current/historical journals, find shared owners, read graph files, or detect whether legacy automation is running. It does not change the graph's journal template configuration. There is deliberately **no Apply or Enable button**.

Each open/refresh makes a new inspection. Graph changes immediately clear old results and recheck while the window is open; a closed window waits until reopened. Close, refresh, graph change, and unload invalidate pending inspections. The inspector also verifies graph paths around reads. No inspection is an atomic graph snapshot; a switch away and back between samples cannot be detected without host events. The visible result is a snapshot: page edits or dependency changes require **Refresh preview**; the separate background probe does not continuously update this window.

No previews are logged or persisted. SDK read failures in the preview are sanitized; detailed Calendar diagnostics remain available through the original command. Existing identity/property conventions remain the reference for future approved setup; this preview does not adopt or rewrite them.

## Draft setup plan (schema v1)

The preview now displays the inspector's **draft or blocked plan**, its sampled-source SHA-256 fingerprint (or an explicit unavailable message), proposed additions with exact content, target and placement, preservation rules, blockers, and requirements before any future apply. **A draft is never execution-ready or approval.** There is no executor, Apply button, stored activation, or backup/migration implementation.

Within the limited inspected scope, the planner can propose:

- Empty **Week Routine** / **Month Routine** pages when missing, without sample or active tasks.
- A missing **daily-default** template containing six empty headings. **Templates** is proposed only if needed as its destination; existing page contents are not replaced.
- Missing headings appended as last direct children of an existing, unambiguous template. Its definition must match `daily-default` and explicitly exclude the parent (`template-including-parent:: false`). Existing text, properties, UUIDs, section order, routine tasks/completions, and Tasks/Notes content are preserved.

Calendar unavailability, ambiguous template definitions/root inclusion, duplicate or nested matching headings, unreadable/incomplete evidence, and fingerprinting failures block proposals. A complete inspected setup produces a draft with zero additions, **not a declaration that the whole graph is ready**. Fingerprinting requires native Web Crypto SHA-256; if unavailable, the plan is blocked while inspection findings remain visible.

**Refresh preview** compares consecutive completed fingerprints within the current comparison session: new, unchanged, changed/superseded, or unavailable. Every explicit **JR/palette open** starts a new session, even if the view was already open or our Close handler did not run. Close, graph-change events, inspection errors, and unload also clear comparison history; an unidentifiable report breaks comparability. Pending/stale results cannot replace the current draft. No plan or comparison is logged or persisted.

The fingerprint covers sampled graph identity, named page metadata, routine trees, the global template lookup/tree, and the proposed plan. It is **not** a whole-graph snapshot, security token, lock, or authorization. Existing Templates page contents outside the fetched template and the rest of the graph are not read. An unchanged fingerprint cannot prove absence of concurrent edits or an unobserved switch away and back.

Before future execution, work remains on graph-wide template/section uniqueness and collision checks, journal/template configuration, period owners, legacy automation, dependency lifecycle validation, backup, fresh revalidation, and explicit per-graph approval. Journals, configuration, owners, and schedulers remain untouched.

## Dependency contract

SDK and build versions are pinned in `package.json` and `package-lock.json`: `@logseq/libs` **0.0.17**, `esbuild` **0.28.2**. The provider target is `persian-calendar`, not its npm package name.

Each full probe:

1. Calls `persian-calendar.models.getApiInfo` through `App.invokeExternalPlugin`.
2. Requires `id === "persian-calendar"`, `version === 1`, and the `describe-date`, `describe-today`, and `from-journal-day` capabilities.
3. Calls `describeDate("2025-03-21")`, `describeToday()`, and `fromJournalDay(20250321)`, freshly checking API info before **each** date call.
4. Checks API info again at the end. A full successful sequence makes eight SDK invocations.

Every invocation has a **3-second timeout**. Missing methods/providers, SDK rejections, unsupported API versions, malformed responses, and timeouts fail closed. A later check retries from discovery; successful availability is never cached for reuse.

Descriptions require Gregorian/Persian components, ISO dates, journal day, nonempty Persian label, week number, inclusive week/month bounds, and consistent legacy period keys. Validation checks Gregorian civil dates, Saturday–Friday bounds, month-span shape, component/key consistency, and that requested dates match responses. It does not reproduce Persian conversion, independently certify ICU results, or turn structural validation into provider trust. `fromJournalDay` must return the exact input's Gregorian ISO string.

Graph changes and manual rechecks invalidate pending local calls and clear previous results. Unload cancels local pending work, clears timers, releases the graph listener, and suppresses late reports/notifications. Logseq owns the registered command's plugin lifecycle. Remote SDK calls cannot be aborted by this client; late results are ignored. Provider loss is observed by the next call/check, not through an assumed provider-lifecycle event. A very brief disable/reload between checks may go unobserved.

## Tests and evidence

```sh
npm test
npm run build
```

`src/calendar-client.test.js` covers the versioned client contract, strict response/input validation, unavailable/incompatible providers, timeouts, late rejection/success, invalidation, recovery, and disposal. `src/runtime.test.js` covers graph changes, concurrent checks, polling, and cleanup. `src/register.test.js` exercises SDK registration and combined unload ownership. `src/setup-preview.test.js` covers bounded read-only inspection, user-owned collisions, section findings, malformed data, and graph races. `src/setup-controller.test.js` covers visible/hidden graph changes, cancellation, opening/closing, and cleanup. `src/setup-plan.test.js` covers append-only proposals, complete/fresh graphs, ambiguous definitions, source fingerprints, privacy, and fail-closed evidence handling. Controller tests also cover fingerprint comparisons, reset/recovery, and stale-success/rejection suppression. Tests use fixed wire-response fixtures rather than importing Calendar's implementation.

Run the visible window/entrypoint fixture using an installed Chrome or Chromium executable:

```sh
npm run test:browser -- /usr/bin/google-chrome
```

The browser fixture bundles the real entry point with a strict read-only mocked SDK. It checks the initial window, all three commands, on-demand graph-to-engine inspection, JR toolbar, narrow/wide geometry, keyboard controls, unavailable-provider recovery, safe text rendering, graph races, and unload cleanup. Draft-plan coverage includes exact additions/targets, new/unchanged/changed fingerprints, blocked and unidentifiable plans, complete/fresh graphs, multiline content, privacy, and comparison resets. It does not validate actual Desktop main-UI placement or cross-plugin transport.

Validated on **2026-09-12** from this plugin folder: `npm test` (**423 passing Node tests**), `npm run test:browser -- /usr/bin/google-chrome` (**12 passing fixture groups**), and `npm run build` (bundle rebuilt). This validates the current draft-plan source, not its placement or SDK behavior in live Desktop.

**Mock tests and a successful bundle are not live Logseq Desktop transport or lifecycle evidence.** User-supplied Desktop screenshots on 2026-09-11 subsequently confirmed that the setup window renders and the Calendar v1 date check succeeds, displaying Gregorian `2026-09-11`, Jalali `1405-06-20`, `weekly-20260905`, and `monthly-1405-06`. This is evidence for the preview's `getApiInfo` / `describeToday` path, not all four models or provider lifecycle behavior. The screenshots also show existing-template section findings; their accuracy against source content has not been independently checked. A subsequent screenshot after the provider-disable test instructions shows the preview reporting Calendar unavailable while retaining template-section findings. This confirms the unavailable-result UI, not the exact failure cause, timeout, or recovery. Desktop version, exact loaded builds, load order, re-enable/reload recovery, and command cleanup remain unverified.

The user subsequently supplied a successful preview again, then this full diagnostic notification:

> Calendar API v1 responded to all probe calls. Today: 2026-09-11 / 1405-06-20. Read-only observation; journal writes remain disabled.

This confirms the normal Desktop path completed all four models (`getApiInfo`, `describeDate`, `describeToday`, `fromJournalDay`) with client validation. The reported preview sequence is available → unavailable → available; recovery specifically **without reloading Journal** was not explicitly confirmed. Remaining lifecycle cases below are separate from this completed normal-path test.

### Draft-plan Desktop evidence — user report, 2026-09-12

After explicitly reloading Journal, the user pasted the rendered **Proposed setup plan · v1** window: Calendar v1 date check succeeded for `2026-09-12` / `1405-06-21`, with `weekly-20260912` and `monthly-1405-06`. The plan showed draft status, a SHA-256 fingerprint, the new-inspection message, and six additions: empty Week Routine and Month Routine pages plus Focus, Weekly tasks, Monthly tasks, and End-of-day review headings appended to the existing template. Tasks/Notes preservation, targets/placement, requirements, inspection limits, and only Refresh/Close controls were visible in the pasted output.

This confirms user-reported rendering and normal-path planning after reload, not independent verification of graph contents, unchanged files, fingerprint refresh comparison, full lifecycle behavior, or exact build/Desktop metadata. No graph name, target UUID, or fingerprint was copied into these notes. Remaining interactions and failure cases stay pending; this is not setup approval.

### Unchanged refresh — user report, 2026-09-13

In response to the refresh check, the user supplied a preview showing **Same sampled sources and plan as the previous inspection**, six proposed additions, and a successful Calendar v1 date check (`2026-09-13` / `1405-06-22`, `weekly-20260912`, `monthly-1405-06`). The user explicitly confirmed both Journal and Calendar were enabled. This supports the live unchanged-comparison path; the report is for a different graph from the preceding paste, so the two pasted fingerprints are not an unchanged-source pair and this does not establish graph-switch cleanup. Close → JR reopen reset, changed-source comparison, and dependency lifecycle checks remain unconfirmed. No graph name, block UUID, or fingerprint was retained.

### Explicit-open reset fix — 0.2.1, 2026-09-14

The user repeatedly pasted the unchanged-comparison state in response to Close → JR test instructions, without explicitly confirming the exact click sequence. This is an unresolved Desktop observation, not a passed close/reopen check. Inspection of source and bundle showed Close already reset history, while explicit JR/palette open reused it. Two new controller regressions reproduced `unchanged` instead of `new` for open actions without Close.

Version 0.2.1 resets comparison history on every explicit open; Refresh alone carries the prior fingerprint forward. This also makes repeated open invocations start fresh, without requiring a preceding Close callback. It does not establish whether host dismissal, repeated open dispatch, a different loaded copy, or a Refresh click caused the reported Desktop result; no new host visibility integration is claimed.

Validation: **425 Node tests**, **12 Chromium mocked-SDK groups**, and build passed; controller/view diagnostics were clean. Browser coverage exercises both explicit open routes without Close, subsequent unchanged Refresh, and the visible build label. The loaded Desktop fix remains unverified. Reload Journal, confirm **Preview build: 0.2.1**, and check that opening starts with **New inspection** while Refresh of unchanged sources reports **Same sampled sources**. No graph writes, dependency changes, staging or commits were introduced.

### Live Desktop checklist — partial screenshots and command evidence

Record the Logseq version, OS, both plugin build/source revisions, case, observation, and redacted console output. Do not mark a case passed from a Node test. Use disposable graphs and plugin copies for failure injection; do not edit the working Calendar plugin or personal graph to test incompatibility.

| Case | Action | Expected observation | Evidence |
| --- | --- | --- | --- |
| Visible setup | Load version 0.2.0; close/reopen with JR, palette, and Escape; refresh and switch graphs | Setup opens automatically; findings match the current graph; no note content changed; no stale result after switch/close | Partial: window and rendered findings visible in user screenshots; interaction, startup timing, source accuracy, and graph-change checks pending |
| Draft plan UI | Reload the latest built bundle; inspect Tasks/Notes-only, complete, and fresh disposable graphs; refresh unchanged and after a source edit; test blockers and close/graph-switch reset | Proposed additions, fingerprint/comparison, preservation rules and blockers match inspected sources; only Refresh/Close; no writes | Partial: user pasted draft plan after Journal reload on 2026-09-12, with six expected additions, fingerprint, preservation rules and read-only controls. Unchanged-comparison state confirmed in user output on 2026-09-13 with both plugins enabled. Changed-source comparison, source accuracy, fresh/complete graphs, blockers and reset interactions remain pending; covered by mocked-SDK fixtures |
| Real-graph engine inspection (0.3.0) | Run Inspect today's journal engine in an idle disposable Markdown file graph | Bounded scan and safe summary, or actionable blocked result; no writes; graph/edit/unload events discard pending results | Automated Node and bundled Chromium mocked-SDK coverage passed; live Desktop check pending |
| Preview date transport | Open setup preview with Calendar available | API v1 date check succeeds and displays dates/period keys | User screenshots and later pasted successful preview, 2026-09-11; exact builds/Desktop version not recorded |
| Full probe, normal path | Run Check Calendar dependency with Calendar available | All four API models and client validations complete | User supplied the full success notification, 2026-09-11 |
| Consumer first / provider absent | Load only this probe, run its diagnostic command | Unavailable warning within the call timeout; setup can still inspect named resources; no graph changes | Pending |
| Provider loaded later | Load Calendar without reloading the probe, run command | API v1, fixed sample `2025-03-21` / `1404-01-01`, journal ISO `2025-03-21`, correct local today | Pending |
| Provider first | Reload both with Calendar loaded first | All four models work across plugin sandboxes | Pending |
| Disable and re-enable provider | Disable Calendar, run command; re-enable and repeat | Unavailable, then fresh success; no stale success reused | Partial: preview available → unavailable → available and later full-probe success reported; exact disable/re-enable sequence and absence of a Journal reload not explicitly confirmed |
| Reload provider | Reload Calendar during repeated probe commands | Either complete validated observations or safe failures, then recovery | Pending |
| Unsupported/malformed provider | In an isolated test provider build with the same ID, change version, then separately return a malformed result; never load both copies together | Incompatibility/validation warning; no fallback | Pending |
| Rejected/hung model | In the isolated test provider, reject a model call, then leave one unresolved | Actionable rejection/3-second invocation timeout; later checks still recover | Pending |
| Graph changes | Switch between two disposable file graphs, including during a pending check | Old check cannot publish a result for the new context; fresh check runs; no graph writes | Pending |
| Probe disable/reload | Disable while a call is pending; wait more than 30 seconds, then reload | No late report/toast or polling while disabled; one command/listener/poll loop after reload | Pending |
| Restart | Fully restart Desktop with both enabled, repeat command | Fresh cross-plugin success; no graph content changes caused by probe | Pending |

Also finish the separate Calendar UI gate: confirm the latest numeric Jalali week range, native alignment, expanded/collapsed scrolling, graph switching, disable/reload cleanup, and opt-in bidi preference persistence. This scaffold does not change or validate those presentation features.

**Do not begin Journal graph-writing behavior until live dependency checks pass.** The read-only preview is preparation, not completed setup or migration. Subsequent work should define journal section/owner APIs and turn the limited draft plan into a thoroughly checked per-graph opt-in setup workflow, with backup and approved migration—not an automatic scan/rewrite of historical journals.

## Repository boundary

This local folder lives under the starter's ignored `plugins/` directory and is **not included in a starter clone or parent Git diff**. On 2026-09-12 the folder was inspected as its own Git repository on `main`, with HEAD `f9a7868` and no configured remote; existing staged and untracked implementation work was preserved. No repository initialization, staging, commits, remote changes, or publication were performed for the draft-plan UI validation update. Release/license decisions still need explicit authorization. The parent workspace's `PLUGIN_ROADMAP.md` records the suite's remaining gates.
