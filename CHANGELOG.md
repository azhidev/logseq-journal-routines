# Changelog

All notable changes to Journal & Routines are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- New daily template installations start Focus and Tasks with two empty editable blocks each. Existing templates and journals are not refilled or migrated.
- Daily selection now has a labeled optional group and explanatory section preview. Enabled graphs offer **Apply selected options**; advanced tools are grouped by purpose, and routine-only saves and manual template installation report what was applied.
- Graph-local settings, stored configuration, replacement approval and durable safety markers remain compatible and unchanged.

### Validation

- 208 targeted Node fixtures passed across daily-template, daily-today, setup view and registration tests. These include existing one-block templates, graph isolation, replacement approval, apply/save feedback and keyboard focus. No full-suite, build or live Desktop validation was run for this update.

## [0.5.0-alpha.1] — 2026-10-02

Development alpha, not a beta release. This entry describes the implemented alpha; it does **not** claim the release gate has passed. Actual Logseq Desktop validation (rendering, indexing, persistence, native template application) is still outstanding — see [NEXT_SESSION.md](NEXT_SESSION.md).

### Added

- Lightweight weekly/monthly routine system in Logseq's native right sidebar: ordinary editable definition pages and one ordinary page per initialized period.
- Gregorian mode standalone (Monday-start weeks, device-local civil day); optional Jalali mode via the Persian Calendar plugin (Saturday-start weeks).
- Per-graph setup with explicit Enable, definition-page selection/creation and Disable without deleting graph content.
- First-run onboarding: welcome screen, **Create my first routine system** and graph-local **Skip for now**.
- Current week/month native sidebar panes (weekly first), localized page titles and compact two-line captions with correct RTL/LTR date ranges.
- On-demand native history page listing weekly/monthly periods newest first across both calendars.
- Optional native daily journal template (Focus, Tasks, Priority A, Pending/WAITING, This week) with original-task queries and a guarded **Apply daily template to today** action.
- Guarded Persian starter tasks for fresh default definitions and empty current periods on first Enable.
- MIT license.

### Changed

- Streamlined combined setup: **Set up this graph** saves settings, enables routines, installs the selected daily template and attempts guarded today application; manual tools are under **More options**.
- Sidebar captions: label above a smaller, subdued date range; weekly range RTL, Gregorian monthly range LTR.
- New period/history pages are created property-free and metadata is written as verified text (see Fixed).

### Fixed

- Logseq 0.10.15 page creation no longer passes nonempty properties objects, which could leave an unserializable `cljs-bean/Bean` in the database and block graph persistence. This prevents new occurrences; existing affected graphs still require a separate safe recovery procedure.
- Interrupted or ambiguous initialization now pauses with actionable messages instead of duplicating or deleting content.

### Removed

- Obsolete experimental journal writer, scanners, template/setup preview and their tests; no backward-compatibility machinery is retained.

### Validation status

Earlier automated Node fixtures, Chromium smoke checks and pinned native DataScript fixtures passed. Those results do not validate the latest onboarding and safety changes, whose tests/build have not yet been executed. These are not live Desktop evidence; the remaining release gate is documented in [NEXT_SESSION.md](NEXT_SESSION.md).
