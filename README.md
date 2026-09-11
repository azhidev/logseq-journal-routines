# Journal & Routines — read-only setup preview

Version **0.2.0** adds a visible setup window to the Calendar dependency probe. It **opens when the plugin loads**, and can be reopened using the **JR** toolbar button or **Journal & Routines: Open setup preview (read-only)** command.

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

The setup window should open immediately after loading version 0.2.0. It has **Refresh preview** and **Close** controls; Escape also closes it. Reopen it with **JR** in the toolbar or the command palette action **Journal & Routines: Open setup preview (read-only)**. If you still see no window or JR button, verify that Load unpacked points to this folder and reload this plugin after `npm run build`.

The original diagnostic command remains available:

**Journal & Routines: Check Calendar dependency (read-only)**

A successful check shows today's Gregorian and Persian dates. Failures show which dependency call or validation failed. Details are logged in Desktop's developer console under `[journal-routines:calendar-probe]`.

The probe also checks at startup, on graph changes, and every **30 seconds** when no check is running. Background checks log completed state transitions, not repeated success notifications. The manual command always logs its completed result. No results are saved to the graph. Reports contain sample/today dates, API identity/version, timestamps, or errors—not notes or graph paths collected by the probe. Host error text can contain local details; redact it before sharing logs.

## What the setup preview inspects

- Calendar's freshly validated `describeToday()` result, including the Gregorian/Jalali dates and unchanged `weekly-YYYYMMDD` / `monthly-YYYY-MM` keys. This date check is not the full diagnostic probe or a guarantee of future availability.
- Named pages **Templates**, **Week Routine**, and **Month Routine**. Existing resources are marked as **user-owned review collisions**, not errors to auto-fix or overwrite. Routine counts exclude title wrappers and property-only/empty entries.
- The **daily-default** template through Logseq's global template lookup, so it need not live on the Templates page. Its tree is checked for the six expected sections: **Focus**, **Weekly tasks**, **Monthly tasks**, **Tasks**, **Notes**, and **End-of-day review**. Missing or repeated matching titles are reported for review.

The inspector uses supported read APIs only: `App.getCurrentGraph`, `App.getTemplate`, `Editor.getPage`, `Editor.getPageBlocksTree`, and `Editor.getBlock`. Reads are bounded and cancellable locally; malformed, incomplete, or oversized block trees are reported as unavailable rather than empty. Calendar absence does not prevent named-page inspection, but no period data is fabricated.

The window shows summaries, not note bodies or graph paths. It does not enumerate every template definition, inspect current/historical journals, find shared owners, read graph files, or detect whether legacy automation is running. It does not change the graph's journal template configuration. There is deliberately **no Apply or Enable button**.

Each open/refresh makes a new inspection. Graph changes immediately clear old results and recheck while the window is open; a closed window waits until reopened. Close, refresh, graph change, and unload invalidate pending inspections. The inspector also verifies graph paths around reads. No inspection is an atomic graph snapshot; a switch away and back between samples cannot be detected without host events. The visible result is a snapshot: page edits or dependency changes require **Refresh preview**; the separate background probe does not continuously update this window.

No previews are logged or persisted. SDK read failures in the preview are sanitized; detailed Calendar diagnostics remain available through the original command. Existing identity/property conventions remain the reference for future approved setup; this preview does not adopt or rewrite them.

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

`src/calendar-client.test.js` covers the versioned client contract, strict response/input validation, unavailable/incompatible providers, timeouts, late rejection/success, invalidation, recovery, and disposal. `src/runtime.test.js` covers graph changes, concurrent checks, polling, and cleanup. `src/register.test.js` exercises SDK registration and combined unload ownership. `src/setup-preview.test.js` covers bounded read-only inspection, user-owned collisions, section findings, malformed data, and graph races. `src/setup-controller.test.js` covers visible/hidden graph changes, cancellation, opening/closing, and cleanup. Tests use fixed wire-response fixtures rather than importing Calendar's implementation.

Run the visible window/entrypoint fixture using an installed Chrome or Chromium executable:

```sh
npm run test:browser -- /usr/bin/google-chrome
```

The browser fixture bundles the real entry point with a mocked SDK. It checks the initial window, both commands, JR toolbar, narrow/wide geometry, keyboard controls, unavailable-provider recovery, safe text rendering, graph races, and unload cleanup. It does not validate actual Desktop main-UI placement or cross-plugin transport.

**Mock tests and a successful bundle are not live Logseq Desktop transport or lifecycle evidence.** User-supplied Desktop screenshots on 2026-09-11 subsequently confirmed that the setup window renders and the Calendar v1 date check succeeds, displaying Gregorian `2026-09-11`, Jalali `1405-06-20`, `weekly-20260905`, and `monthly-1405-06`. This is evidence for the preview's `getApiInfo` / `describeToday` path, not all four models or provider lifecycle behavior. The screenshots also show existing-template section findings; their accuracy against source content has not been independently checked. Desktop version, exact loaded builds, load order, reload/disable behavior, and command cleanup remain unverified.

### Live Desktop checklist — partial screenshot evidence

Record the Logseq version, OS, both plugin build/source revisions, case, observation, and redacted console output. Do not mark a case passed from a Node test. Use disposable graphs and plugin copies for failure injection; do not edit the working Calendar plugin or personal graph to test incompatibility.

| Case | Action | Expected observation | Evidence |
| --- | --- | --- | --- |
| Visible setup | Load version 0.2.0; close/reopen with JR, palette, and Escape; refresh and switch graphs | Setup opens automatically; findings match the current graph; no note content changed; no stale result after switch/close | Partial: window and rendered findings visible in user screenshots; interaction, startup timing, source accuracy, and graph-change checks pending |
| Preview date transport | Open setup preview with Calendar available | API v1 date check succeeds and displays dates/period keys | User screenshots, 2026-09-11; exact builds/Desktop version not recorded |
| Consumer first / provider absent | Load only this probe, run its diagnostic command | Unavailable warning within the call timeout; setup can still inspect named resources; no graph changes | Pending |
| Provider loaded later | Load Calendar without reloading the probe, run command | API v1, fixed sample `2025-03-21` / `1404-01-01`, journal ISO `2025-03-21`, correct local today | Pending |
| Provider first | Reload both with Calendar loaded first | All four models work across plugin sandboxes | Pending |
| Disable and re-enable provider | Disable Calendar, run command; re-enable and repeat | Unavailable, then fresh success; no stale success reused | Pending |
| Reload provider | Reload Calendar during repeated probe commands | Either complete validated observations or safe failures, then recovery | Pending |
| Unsupported/malformed provider | In an isolated test provider build with the same ID, change version, then separately return a malformed result; never load both copies together | Incompatibility/validation warning; no fallback | Pending |
| Rejected/hung model | In the isolated test provider, reject a model call, then leave one unresolved | Actionable rejection/3-second invocation timeout; later checks still recover | Pending |
| Graph changes | Switch between two disposable file graphs, including during a pending check | Old check cannot publish a result for the new context; fresh check runs; no graph writes | Pending |
| Probe disable/reload | Disable while a call is pending; wait more than 30 seconds, then reload | No late report/toast or polling while disabled; one command/listener/poll loop after reload | Pending |
| Restart | Fully restart Desktop with both enabled, repeat command | Fresh cross-plugin success; no graph content changes caused by probe | Pending |

Also finish the separate Calendar UI gate: confirm the latest numeric Jalali week range, native alignment, expanded/collapsed scrolling, graph switching, disable/reload cleanup, and opt-in bidi preference persistence. This scaffold does not change or validate those presentation features.

**Do not begin Journal graph-writing behavior until live dependency checks pass.** The read-only preview is preparation, not completed setup or migration. Subsequent work should define journal section/owner APIs and a versioned per-graph opt-in setup plan, thorough collision analysis, backup, and approved migration—not an automatic scan/rewrite of historical journals.

## Repository boundary

This local folder lives under the starter's ignored `plugins/` directory and is **not included in a starter clone or parent Git diff**. No Git repository, license, branch, remote, or release has been created for this scaffold. Initialize and publish it only with explicit authorization. The parent workspace's `PLUGIN_ROADMAP.md` records the suite's remaining gates.
