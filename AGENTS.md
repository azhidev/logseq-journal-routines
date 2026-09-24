# Working on Journal & Routines

Read `SCOPE.md` first. It is the authoritative product contract for lightweight weekly/monthly routines in Logseq's right sidebar. It supersedes the old comprehensive journal-management requirements in parent documents.

- Read `NEXT_SESSION.md` for the implementation starting point, existing working-tree state and validation sequence. Product decisions are settled: Saturday for Jalali, Monday for Gregorian. Do not ask again; choose and document remaining engineering details within `SCOPE.md`.
- The native history-page UX is the recommended lightweight implementation, not a reason to reopen product scope.
- The user explicitly authorized removing unused experimental Journal code, tests, dependencies and version-specific documentation without backward compatibility. Do not maintain a parallel legacy runtime or add a migration framework for undeployed versions.
- Inspect the working tree before editing. Remove only obsolete Journal work within this scope; preserve unrelated changes and all user graph data. Software cleanup is not permission to erase notes, history or completed tasks.
- Keep current periods in independent native Logseq pages; do not restore daily template management, daily reference insertion or historical owner discovery.
- Lightweight is a product requirement: no ordinary full-graph scans, short-interval polling, background history scans, heavy task UI or private duplicate task database.
- Preserve repeat-safe period creation, graph isolation, calendar-switch history and user edits. Do not drop safety tests merely to reduce code size.
- Update `SCOPE.md` when decisions change and `README.md` when behavior is implemented. Do not present target behavior as already shipped or old test results as validation of the replacement.
- Keep user documentation focused on the supported product, not a sequence of experimental versions. Report automated fixtures separately from actual Desktop validation.
