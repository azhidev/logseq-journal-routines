# Next session — implement lightweight routines

Prepared: 2026-09-24
Status: **Ready to implement. No outstanding product clarification.**

## Start here

Read `AGENTS.md`, then `SCOPE.md`. SCOPE is the single product contract; this file is an execution handoff, not another specification. The user requested preparation only in the preceding session. Start implementing in the next session rather than repeating design discussions or extending the previous journal writer.

Confirmed: **Saturday-start Jalali weeks; Monday-start Gregorian weeks; both independent of month boundaries.** Gregorian works alone, Jalali uses Persian Calendar. Current weekly/monthly snapshots live in independent native pages shown in the right sidebar. History must remain accessible. No journal/template changes, automatic carry-forward, missed-period backfill or backward compatibility with experimental versions.

## What has and has not changed

- Product decisions and lightweight constraints are recorded in `SCOPE.md`.
- README no longer presents a sequence of experimental releases. Parent implementation/roadmap entry points refer here and to SCOPE.
- The old ENGINE guide has been replaced with a redirect so it cannot masquerade as the new architecture.
- **Runtime code is still the old implementation. No lightweight runtime was implemented or built during preparation.** Existing `dist/` is not a build of the new design.
- No graph notes, tasks, starter scripts, plugin state or other plugins were changed during preparation.
- No commits, branches or dependency installations were made for this handoff.

## Repository and working-tree boundaries

`plugins/journal-routines/` is a separate Git repository, ignored by the parent starter repository. Its sibling `plugins/persian-calendar/` provides the Jalali API. Do not accidentally stage plugins into the parent or assume a starter clone includes them.

Inspect both working trees before edits. At the last preparation check, these Journal files already had uncommitted implementation changes, predating this documentation work:

- `package.json`, `package-lock.json`
- `scripts/validate_activation.cjs`
- `src/activation-runtime.js`, `src/activation-runtime.test.js`
- `src/journal-writer.js`, `src/journal-writer.test.js`

README is modified; AGENTS/SCOPE were new untracked files, and this handoff is also new. Parent `PLUGIN_ROADMAP.md` and `README.md` were already modified; `JOURNAL_ROUTINES_IMPLEMENTATION.md` is untracked. Recheck rather than assuming this inventory is still current. Do not reset the repositories.

The user explicitly authorizes deleting/replacing obsolete Journal implementation, tests, dependencies and docs, even without backward compatibility. That does not authorize discarding unrelated work or erasing graph content. Do not retain old recovery workflows merely because they exist; do not clear storage or touch personal graphs as a shortcut to cleanup.

## Focused source entry points

All paths below are relative to this plugin unless noted.

| Path | Purpose for the next session |
| --- | --- |
| `package.json`, `index.html` | Build, dependencies and plugin loading. Current entry bundle is `dist/index.js`. |
| `src/index.js`, `src/register.js` | Replace production wiring and old commands. Current entrypoint imports the activation runtime and journal inspector. |
| `src/calendar-client.js`, its tests | Inspect for reusable Persian Calendar transport/validation; Gregorian startup must not require it to be ready. |
| `../persian-calendar/README.md`, `../persian-calendar/src/` | Verify the provider's actual API and civil period semantics; do not duplicate Jalali conversion or alter the provider unnecessarily. |
| `src/routine-sidebar.js`, its tests | Evaluate native sidebar helpers; remove journal-owner coupling where needed. |
| `src/activation-*`, `src/setup-*`, `src/runtime.js` | Audit for replacement/removal. Do not port the old setup and activation framework wholesale. |
| `src/journal-*`, `src/graph-normalize.js` | Old model/engine/writer/discovery. Keep only narrowly useful code; journal projection, historical owner scans and daily references are not part of the replacement. |
| `scripts/validate_activation.cjs`, `scripts/validate_setup.cjs` | Old browser fixtures; replace relevant flows and remove preview-only coverage/scripts once obsolete. |

These are inspection candidates, not a claim that their current APIs suit the new design. Read focused code and SDK contracts before edits. Do not spend the next session fixing an old writer bug that disappears with the approved replacement.

## Execution order

1. **Inspect and choose the small model.** Determine exact period page names/metadata and definition-copy rules. Record choices in SCOPE as engineering details; no renewed product questionnaire. Identity must distinguish calendar/kind/civil bounds and avoid overwriting an unrelated same-name page. Design minimal repeat-safe creation and preservation of deliberate deletions before writes.
2. **Implement the Gregorian vertical slice.** Graph-scoped Enable, empty or selected definition pages, one current week/month snapshot, native sidebar panes, Show current routines, auto-open preference and Disable. No Persian Calendar readiness dependency, template editing or journal scanner.
3. **Add Jalali and history.** Use the real Calendar API; pause new creation clearly if unavailable. Calendar switching is one confirmation, preserving/reusing existing periods. Implement the recommended native history page with weekly/monthly lists, newest first, queried only when opened; verify target-host query behavior instead of inventing it.
4. **Remove superseded paths.** Remove unused runtime branches, commands, setup/preview/writer code, tests of discarded behavior and dependencies. Update package scripts/metadata and regenerate the lockfile only as needed. Do not ship a parallel legacy mode. Keep unrelated plugins and starter features unchanged.
5. **Validate and document actual behavior.** Exercise the checklist below, build the new bundle, record measured bundle cost/SDK-call behavior and update README with accurate usage. Retire/update this handoff once it no longer describes the checkout.

These are implementation steps, not separate preview-only deliveries. Seek a usable end-to-end plugin; do not stop after another inspector or setup mock. If one live-host check is blocked, finish independent work and state the specific unverified behavior.

## Validation checklist

Use isolated fixtures and disposable graphs, never personal notes for failure injection.

- Gregorian works without Calendar; Jalali uses Saturday weeks and actual Jalali months. Gregorian weeks start Monday. Include month-crossing weeks, leap boundaries and Nowruz.
- Repeated activation, duplicate triggers and reload create no duplicate snapshots or reset completions.
- Interrupted creation reconciles or pauses without destructive rollback. Failed reads are not treated as absence.
- Editing definitions affects future periods only; nested content survives, task identities are fresh, deleted tasks stay deleted and unfinished tasks stay in their old periods.
- Reopening after missed weeks creates only the current periods. Calendar switching and switching back preserve/reuse both calendars' history.
- The sidebar always targets current periods; historical links open original pages without creating new snapshots. Preserve unrelated panes and respect manual closure.
- Graph switch/Disable/unload stop stale queued work and release listeners/timers. No activation leaks between graphs.
- Idle work does not repeatedly query/write; rollover uses targeted resources. Increasing unrelated graph history must not cause a full-graph scan. History is on demand.
- No daily journal/template/global configuration edits are needed; obsolete experimental compatibility paths are absent from the production bundle.

Current package scripts, verified during preparation (recheck after cleanup):

```sh
npm test
npm run build
```

The current browser scripts are `test:browser` and `test:browser:preview`; they target old behavior and are not proof of the replacement. Inspect/update them and discover the available Chromium executable before running browser checks. Do not invent a browser path or preserve the preview script just to keep an old test count.

Report commands actually run, relevant failures, current test results and actual Desktop checks separately. Prior experimental test totals are not evidence for the new product. Do not claim real Desktop validation from a mocked SDK.

## Ready-to-use next-session prompt

> Implement the lightweight Journal & Routines plugin. Read `plugins/journal-routines/AGENTS.md`, `SCOPE.md`, and `NEXT_SESSION.md` first. Product decisions are settled: Saturday for Jalali and Monday for Gregorian; independent period pages in the native sidebar; current periods plus on-demand history; Gregorian standalone and Persian Calendar only for Jalali. Replace/remove obsolete experimental Journal code without backward compatibility, preserving user graph data and unrelated work. Start the implementation and validate the complete path, not another planning/preview milestone. Keep the plugin lightweight and report actual validation and remaining live-host limits.
