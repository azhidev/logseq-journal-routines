# Journal & Routines

Lightweight weekly and monthly routines in Logseq's native right sidebar.

**Status: development alpha (`0.5.0-alpha.1`), not production-ready.** The replacement runtime is implemented; the latest onboarding and safety changes have not yet been validated by test/build execution. Actual Logseq Desktop validation is still outstanding. Target: **Logseq Desktop 0.10.15, Markdown file graphs**. Database graphs, Org and mobile are not supported targets.

> **Logseq 0.10.15 metadata fix — keep affected graphs disabled.** New period/history pages no longer pass metadata objects to `createPage`, which could leave an unserializable `cljs-bean/Bean` in the database and block graph persistence. Pages are now created property-free and metadata is written as verified text. This prevents new occurrences; it does not repair graphs already affected. Keep the plugin disabled in affected graphs pending a separate safe recovery procedure. Do not clear storage or force recovery; see [NEXT_SESSION.md](NEXT_SESSION.md).

## What is Journal & Routines?

Journal & Routines is a lightweight Logseq plugin that shows the current week's and month's routine tasks in the native right sidebar. You define recurring tasks once on two ordinary pages (weekly and monthly definitions); the plugin creates one ordinary, fully editable Logseq page per initialized period and opens the current ones in the sidebar. No journal rewriting, no background scanning, no private task database.

- Gregorian works standalone; Jalali (Persian calendar) is optional via the Persian Calendar plugin.
- History stays in native Logseq pages; an on-demand history page lists all periods.
- An optional native daily journal template can add Focus, Tasks, Priority A, Pending and This week sections to new daily journals.

## Features

- **Current week/month in the sidebar** — native editable period pages, weekly above monthly, opened automatically on activation/startup and rollover (toggleable).
- **Definition pages** — `Journal & Routines — Weekly definition` and `Journal & Routines — Monthly definition`; edits affect later periods only.
- **One snapshot per period** — tasks are copied once when a period is initialized; completed tasks and deliberate deletions are never reset or refilled.
- **Gregorian standalone** — Monday-start weeks, device-local civil day. **Optional Jalali** — Saturday-start weeks via the Persian Calendar plugin; calendar switching preserves and reuses previous periods.
- **History** — **Show routine history** opens a native page listing weekly/monthly periods newest first across both calendars; clicking a result opens the original page.
- **Optional daily journal template** — native Focus, Tasks, Priority A, Pending (`WAITING`) and This week sections with original-task queries; a guarded **Apply daily template to today** action for empty journals.
- **First-run onboarding** — welcome screen with **Create my first routine system**; **Skip for now** stays quiet for that graph.
- **Safety** — graph-scoped activation, repeat-safe period creation, verified writes, no automatic repair or recreation.

## Installation

Use disposable graphs only while the development-alpha Desktop validation gate remains outstanding.

1. From this plugin directory (the one containing `package.json`), run `npm ci` if dependencies are not installed, then `npm run build`. The build creates `dist/index.js`; `index.html` loads that file. `dist/` is Git-ignored, so a fresh checkout must be built before loading it locally.
2. In Logseq Desktop, use **Plugins → Load unpacked plugin** and select **this plugin directory** (not the graph folder or `dist/`). The manifest points to the bundled `icon.png` at this same directory level.
3. If an older Journal & Routines copy is installed, verify which folder Logseq loaded and reload the intended copy rather than running both. Reload after rebuilding.

On first enable in a graph without saved settings, a welcome screen opens automatically. **Create my first routine system** runs the guarded setup; **Skip for now** (or Escape while idle) dismisses it for that graph without creating pages or enabling routines. Installing the plugin or opening setup never enables graph writes by itself.

## Basic usage

1. **Set up a graph.** Click the **Journal & Routines** toolbar button (or run **Journal & Routines: Setup and settings**) and choose **Set up this graph** (or **Apply selected options** when already enabled). Pick the calendar (Gregorian is the default; Jalali requires Persian Calendar), keep or uncheck **Use the daily journal template**, and apply. This one action saves settings, enables routines, installs the selected daily template and applies it to today when safely eligible, with completion or partial-completion feedback. The daily option includes all five sections shown in the preview; unchecking it leaves any existing daily default unchanged. **More options** groups routine definitions, manual daily tools and routine controls; its **Save settings** action saves routine preferences only, not daily selections.
2. **Add routine tasks.** Edit the weekly/monthly definition pages. If both default definitions were newly created on first Enable, two Persian TODOs are seeded in each; existing or selected definitions are never auto-filled. New periods copy the definitions once — edit current-period tasks directly in the sidebar.
3. **Work in the sidebar.** The current week and month open as native editable pages, weekly first. Closing a pane manually stops automatic reopening for the session; **Show current routines** reopens it. Unrelated panes are never cleared.
4. **Review history.** Run **Show routine history** to browse all periods newest first; click a result to open the original page.
5. **Optional daily template.** With daily inclusion enabled, new eligible empty journals receive the five sections; populated journals are never touched. For an existing empty/one-blank-block today, use **More options → Apply daily template to today**. Completing an original task updates its views everywhere.

Command palette: **Setup and settings**, **Show current routines**, **Show routine history**, **Open weekly definition** / **Open monthly definition**, **Disable for this graph**.

### Daily template sections

| Section | Content |
| --- | --- |
| Focus | Two empty editable blocks for today's main outcome (new installations) |
| Tasks | Two empty editable blocks for tasks you add to this journal (new installations) |
| Priority A | Graph-wide unfinished `[#A]` tasks, excluding `WAITING` |
| Pending | Graph-wide tasks marked `WAITING` |
| This week | Unfinished tasks on the current weekly routine page — including manual additions — and tasks scheduled or due within that week's inclusive dates |

This week follows **real-world today** (Saturday–Friday Jalali, Monday–Sunday Gregorian) using the current owned weekly page's bounds; if that page is absent, the section has no results. Confirmed-empty Priority A/Pending sections are hidden by plugin styling and return when results exist. You can edit the five sections on the template page for later journals; existing journal content is not regenerated.

The two-block default changes new template installations only. Existing graphs keep their installed template, settings and safety markers without migration; reinstalling does not add blanks to existing sections. To change future native insertions on an existing graph, edit the template page yourself. Existing journals remain untouched.

If a future journal received the template but today did not, native Logseq may have skipped today because it already contains a blank block. Use **More options → Apply daily template to today** (or reinstall via **More options → Install daily journal template**); the plugin never shifts dates or edits populated journals.

**Disable does not remove the native default or template.** To stop native daily insertion, change/remove `:default-templates :journals` in this graph's Logseq configuration; existing journals and template content remain yours.

## Requirements

- **Logseq Desktop 0.10.15** with **Markdown file graphs**. Database graphs, Org files and mobile are not supported targets.
- **Gregorian mode**: no other plugins required.
- **Jalali mode**: the Persian Calendar plugin (compatible API v1). A missing or incompatible dependency pauses creation with an actionable message; existing tasks and history remain accessible.
- **Building from source**: Node.js and npm (see Installation).

## Known limitations

- **Not production-ready yet.** Actual Logseq Desktop validation (rendering, indexing, persistence, native template application) is outstanding; see [NEXT_SESSION.md](NEXT_SESSION.md). Automated fixtures are not Desktop evidence.
- **No cross-device exactly-once guarantee.** SDK operations are not atomic transactions; simultaneous initialization from multiple devices/profiles is not supported, and already-dispatched writes cannot be cancelled by a graph switch.
- **Local markers are per graph path.** Activation/deletion evidence lives in plugin storage keyed by the exact graph path; moving a graph or losing plugin storage can lose it. Graph backups alone do not preserve these markers.
- **Affected graphs need recovery.** Graphs that already contain the 0.10.15 metadata Bean are not repaired by this version; keep the plugin disabled there pending a separate safe recovery procedure.
- **No automatic repair or recreation.** Ambiguous or interrupted initialization pauses for inspection; deleted pages stay deleted. There is no destructive automatic repair.
- **Snapshot copying is bounded.** Definitions are limited to 2,000 content blocks and 40 nesting levels; custom block properties and scheduling metadata are not copied; references stay references to their original targets.
- **History and query rendering** (native query links, large-result behavior, midnight/resume refresh) still require Desktop validation.

## Safety and storage

- Period identity and ownership metadata (`jr-*`) identify generated pages; an unrelated same-name page is a collision, never permission to overwrite it. Initialization checkpoints live in the page's actual properties pre-block and are verified before advancing.
- Graph files hold task content and creation-plan metadata. Plugin storage (IndexedDB) holds only activation/preferences and small per-resource creation markers — **not a duplicate task database**. Keep plugin storage as well as graph data backed up if you rely on deletion suppression.
- Calendar switching preserves and reuses previous periods; it never converts, renames or deletes data. Jalali dependency loss pauses new current-period work only; existing pages and history remain accessible.
- Disabling the plugin stops new automatic work and releases listeners without deleting graph content or clearing the sidebar.

## Development

Built release packaging and the future version-tag workflow are documented in
[RELEASE.md](RELEASE.md). Release infrastructure is available; no public release
or Marketplace submission is implied, and Desktop/update QA remains outstanding.

- Product contract: [SCOPE.md](SCOPE.md)
- Architecture and host boundary: [ENGINE.md](ENGINE.md)
- Validation gate and known incidents: [NEXT_SESSION.md](NEXT_SESSION.md)
- Contributor instructions: [AGENTS.md](AGENTS.md)

Run the automated checks from this directory:

```sh
npm test
npm run test:browser
npm run build
```

Earlier automated Node fixtures, Chromium smoke checks and pinned native DataScript fixtures passed; those results do not validate the latest onboarding and safety changes, whose tests/build have not yet been executed. Automated fixtures are not live Desktop validation. See [NEXT_SESSION.md](NEXT_SESSION.md) for the remaining release gate.

## License

MIT — see [LICENSE](LICENSE).
