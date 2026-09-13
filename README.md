# Journal & Routines — read-only setup preview

Package **0.2.1** includes the draft-plan preview and the **2026-09-14 explicit-open comparison reset fix**. It **opens when the plugin loads**, and can be reopened using the **JR** toolbar button or **Journal & Routines: Open setup preview (read-only)** command. Rebuild and reload; confirm **Preview build: 0.2.1** beneath the heading to identify the loaded UI.

This is still a preparation scaffold, not journal automation. The preview inspects existing resources without modifying them. Applying setup, creating journal sections or routine owners, migration, and scheduling graph writes are **not implemented or enabled**.

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

The setup window should open immediately after loading version 0.2.1. It has **Refresh preview** and **Close** controls; Escape also closes it. Reopen it with **JR** in the toolbar or the command palette action **Journal & Routines: Open setup preview (read-only)**. If you still see no window or JR button, verify that Load unpacked points to this folder and reload this plugin after `npm run build`.

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

The browser fixture bundles the real entry point with a strict read-only mocked SDK. It checks the initial window, both commands, JR toolbar, narrow/wide geometry, keyboard controls, unavailable-provider recovery, safe text rendering, graph races, and unload cleanup. Draft-plan coverage includes exact additions/targets, new/unchanged/changed fingerprints, blocked and unidentifiable plans, complete/fresh graphs, multiline content, privacy, and comparison resets. It does not validate actual Desktop main-UI placement or cross-plugin transport.

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
