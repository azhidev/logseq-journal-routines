# Journal & Routines

A lightweight Logseq plugin for weekly and monthly routines in the right sidebar, on new or existing Markdown file graphs.

## Implementation status

The product contract has been reset; the lightweight runtime is **not yet implemented**. Existing executable code still belongs to the previous experimental journal-writing design. Do not interpret this README as a claim that loading that code provides the behavior described below.

Previous experimental versions were not deployed and do not require backward compatibility. Their release-by-release instructions have been removed. The replacement should remove obsolete code and dependencies, not preserve parallel legacy modes. User graph data must remain untouched by that cleanup.

## Product contract

[SCOPE.md](SCOPE.md) is the authoritative specification: approved decisions, history access, performance constraints, non-goals and acceptance criteria. No product clarification remains. Contributors and coding agents must also read [AGENTS.md](AGENTS.md) and start implementation with [NEXT_SESSION.md](NEXT_SESSION.md).

The agreed direction is:

- Define weekly and monthly routines in ordinary editable Logseq pages.
- Create a separate task snapshot for each current week/month and display its native page in the right sidebar.
- Keep weeks independent of month boundaries; never reset a week merely because a new month starts.
- Always show the real-world current periods, not the date of the journal being browsed.
- Provide an on-demand history entry point for previous weeks/months, preserving their tasks and completion state.
- Apply definition changes to later periods only; do not refill deleted tasks or automatically carry unfinished tasks forward.
- Initialize only current periods: no missed-period backfill or future-period generation.
- Use Gregorian mode without dependencies; require Persian Calendar only for selected Jalali mode.
- Preserve previous calendar periods when switching calendars; do not convert, merge or delete them.
- Enable separately for each graph and respect other sidebar panes and manual pane closure.

Confirmed week starts: **Saturday for Jalali/Persian and Monday for Gregorian**. Weeks remain independent of month boundaries.

## Lightweight by design

No daily journal restructuring, template changes, full-graph scans, historical owner discovery, short-interval polling, custom task renderer or private duplicate task database. Automatic current-period work should depend on routine size, not the size of the graph's history. History is accessed on demand through native Logseq pages/queries, not background scanning.

Minimal creation-state handling and focused tests are still required to avoid duplicate snapshots and preserve edits across reload or interrupted writes. Lightweight does not mean unsafe.

## Next implementation steps

1. Follow the next-session handoff and finalize deterministic period identities and narrow task-copy rules without reopening approved product decisions.
2. Replace the experimental journal runtime, reusing only components that simplify this contract; remove obsolete paths, tests and dependencies.
3. Deliver the Gregorian routine/sidebar path, then Jalali support, simple calendar switching and history access.
4. Test data preservation, interrupted creation, calendar boundaries, graph isolation, sidebar behavior and idle work.
5. Verify behavior on actual Logseq Desktop before publishing installation instructions or claiming readiness.

Initial host target: Logseq Desktop 0.10.15, Markdown file graphs. Database graphs, Org and mobile are not implicitly supported. Automated results from the old implementation are not validation of the new design.
