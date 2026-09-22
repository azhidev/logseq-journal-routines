# Journal/routine engine, graph adapter and activation

## 0.4.0 integration — 2026-09-19

The pure engine/adapter contracts below remain internal. The production entrypoint now connects them to `activation-runtime.js`, approved additive `setup-service.js`, narrow `journal-writer.js`, IndexedDB `activation-storage.js`, `activation-view.js` and independent `routine-sidebar.js`. This is a write-enabled experimental build, not a preview-only plugin. See [README.md](README.md) for installation, setup/Enable, limitations and live verification requirements.

Activation persists separately per exact-path hash. Calendar loss pauses execution without forgetting enabled intent. The runtime uses per-graph Web Locks, fresh indexed claim/source checks, bounded full discovery with targeted evidence caching, and current/future-only scheduling. A missing native journal still waits for Logseq; a historical target is never automatically rewritten. Normalization now excludes only a matching redundant host `id::` property, rejects conflicting IDs and preserves persisted identities when updating managed blocks.

The writer compiles private before/after trees into individual guarded SDK mutations, never executes `changes` directly, and publishes loaded-owner markers last. It persists metadata-only checkpoints before writes. Same-session recovery reuses the original private plan. **An unfinished checkpoint after restart without that plan blocks; it is not silently discarded or automatically reconstructed.** SDK operations and graph checks remain non-atomic.

The verified 0.10.15 `App.setCurrentGraphConfigs` setter is used by activation—not the resource-only setup service—to select daily-default only when unset, merging the reviewed default-templates map. Existing custom configuration blocks automatic replacement. Config write uncertainty is latched for the session. Backup and legacy/live-safety declarations are user confirmations, not runtime detection.

Validation: 792 Node tests, 7 production activation Chromium groups, 13 legacy-preview groups and build passed. Live Desktop write behavior remains unverified. The rest of this document records the extracted 0.3.0 contracts; statements that no writer/scheduler is registered describe that earlier entrypoint.

Implemented 2026-09-14 in `src/journal-model.js` and `src/journal-engine.js`.

This is the extraction of the starter's **journal structure, routine snapshots, period owners, and task references**. The engine operates on a normalized in-memory snapshot and returns a projected journal. Since **0.3.0**, `journal-adapter.js` supplies that snapshot through supported Logseq SDK reads, and `journal-inspector.js` exposes an **on-demand read-only command** through the entrypoint. No engine writes, public feature service, scheduler, or setup executor is registered. Loading alone still performs only the existing setup preview/probe; the broader graph scan requires the explicit command.

## Implemented behavior

- Gregorian journal identity remains unchanged. Date labels, Jalali dates, week numbers, bounds and legacy period keys come from the existing validated Calendar client; no Persian calendar conversion is duplicated.
- A current/future journal gains a marked Jalali heading and missing Focus, Weekly tasks, Monthly tasks, Tasks, Notes and End-of-day review roots. Existing headings keep their UUIDs and children. Weekly/monthly titles retain the starter's numbered format.
- Focus/Tasks receive an empty input child if needed. The two exact legacy placeholder prompts are removed only when they have no children; attached notes are preserved with a warning.
- Managed roots are ordered like the starter. An existing Habits root participates in ordering only; habit records, finance and sidebar business logic are not adopted. Unknown roots retain their slots relative to the managed-root permutation; adding the date heading naturally shifts existing positions.
- **Only today's journal** initializes routine owners. A future journal receives structure, not advance routine snapshots. Historical target journals are skipped, and a missing native journal returns `waiting` rather than creating/renaming a page.
- Weekly/monthly defaults are copied recursively once into an owner. Top-level routine-page title wrappers are flattened. Source UUIDs and textual `id`/`created-at`/`updated-at` properties are not copied; task states, custom content and nested tasks are retained. Missing/empty defaults leave the owner unmarked so later planning can retry.
- Existing `routine-loaded:: weekly-YYYYMMDD` / `monthly-YYYY-MM` owners are reused, even if their tasks have been completed, changed, or intentionally deleted. Later default edits do not refill a loaded owner.
- Other journals reference each owner task with `((UUID))` plus `routine-reference:: UUID`, recursively. Matching reference-block UUIDs survive owner task reorder/reparent. Local notes remain intact; only canonical generated references and childless exact legacy owner embeds can be replaced/removed. Customized reference trees block the transition instead of risking note loss.
- A projected journal, supplied back as the next snapshot, produces no changes when the source state is unchanged. Saturday, Nowruz and Jalali-month boundaries are exercised with fixed Calendar wire fixtures.

## Read-only adapter API — 0.3.0

```js
import { createJournalAdapter } from "./src/journal-adapter.js";

const adapter = createJournalAdapter({ sdk });
const result = await adapter.inspect(); // today, as freshly reported by Calendar
// Optional internal targeting/cancellation: inspect({ journalDay: 20250321, signal })
// result.summary is safe scalar data; snapshot and plan are private graph data.
adapter.invalidate();
adapter.destroy();
```

Construction is lazy. Each `inspect()` installs `App.onCurrentGraphChanged` and `DB.onChanged` listeners before any reads and retains them through engine planning/final checks. New requests supersede previous ones. Graph changes, edits, cancellation, limits and unload stop local waits and suppress stale results. All subscribed hooks receive cleanup attempts, and timers/Calendar clients are disposed in `finally`; remote SDK work cannot be canceled by the adapter.

Collection uses `App.getCurrentGraph`, `Editor.getAllPages`, `Editor.getPage`, `Editor.getPageBlocksTree`, and `Editor.getBlock(uuid, { includeChildren: true })` for unresolved tuples, plus the existing Calendar model transport. It uses no host DOM, filesystem, writes, queries, or new dependency. Page trees are read by raw UUID string: Desktop 0.10.15 does not unwrap the `{ uuid }` form permitted by the SDK declarations. The writer's UUID-based `getPage` lookup also uses a string. The SDK's undocumented `getAllPages(repo)` mapping is not assumed.

- All SDK-inventoried pages are scanned before owner selection, not just today's or in-period journals. Non-journal claims for the requested weekly/monthly keys block before the engine; duplicate claims across any pages also block. Historical/future/misplaced journal owners reach the engine's own collision checks.
- `graph-normalize.js` accepts explicit SDK/legacy aliases and blocks conflicts. Page ID/UUID/name and boolean `journal?` are required; journals require a real Gregorian `journalDay`. No date is inferred from a page name. Non-journal dates must be absent, not guessed from a zero/null sentinel.
- Blocks retain exact content and UUIDs. Expanded children are captured synchronously before another await; exact UUID tuples are boundedly expanded. Available block `page.id` metadata is checked against the tree's page, and all block/page UUIDs and entity IDs are checked for collisions. A missing block page-ID field is not an independent proof of membership; the tree read's page identity remains part of the observation.
- Managed content-line properties are reconciled with available hyphen/camel metadata aliases. Metadata-only state, conflicting aliases/values and unsupported representations block. Reference metadata supports matching bare/bracketed strings or singleton string arrays as a defensive policy, not a verified cross-version host guarantee. Extra SDK fields are not passed to the engine. Org format is rejected because the engine's Markdown property semantics cannot safely scan it.
- Routine pages are identified by named lookup against inventory, with optional metadata enrichment allowed. Explicit null is required for absence. Their already-read trees are reused; failed reads never become empty defaults.
- Only journal trees and routine definitions enter the engine snapshot. Other scanned pages still participate in duplicate/claim detection and generated-UUID collision checks. The snapshot's `graphId` is a fresh opaque scan-context UUID, not a persisted graph key or exposed path.
- Final page inventory and graph identity are checked again after the engine; today's date is rechecked to reject a midnight-spanning result. The full pipeline shares a deadline and read budget.

Default maximums: **3,660 inventoried pages**, **10,000 source blocks across all pages**, **40 tree levels**, **4,000,000 content code units**, **20,000 SDK calls** (including graph checks), **3 seconds per invocation**, **30 seconds total**. Named constructor options are `maxPages`, `maxBlocks`, `maxDepth`, `maxTextLength`, `maxCalls`, `timeoutMs`, `totalTimeoutMs`; tests can lower them. Exceeding a budget means blocked, not a truncated complete scan. The engine additionally validates its generated projection against its own bounds. SDK whole-response APIs have no pagination guarantee; local validation does not prevent host-side allocation/transmission of oversized responses.

Adapter results contain `version`, `status` (`planned`, `blocked`, `waiting`, `skipped`), a fixed `reason`, and `summary` with `pagesScanned`, `journalsScanned`, `blocksScanned`, per-kind change counts and weekly/monthly owner state (`existing`, `new`, `none`). A newly claimed pre-existing section is still a **new owner** unless its loaded claim was already observed. Nonblocked results also carry private `snapshot` and `plan` for internal consumers. Blocked results expose no partial projection and zero proposed-change counts.

`ownerScanComplete: true` means the bounded SDK inventory was fully traversed with no observed interruption and requested-period claims checked. It is **not proof of an atomic/complete file graph**: unindexed files, silently partial host responses, delayed/missed events or an unobserved switch away and back remain limitations. Inventory rechecks compare normalized page metadata, not a second copy of every block body. Nothing here detects running legacy automation, validates all setup/template configuration, creates a backup, or authorizes applying the projection.

The registered palette command **Journal & Routines: Inspect today's journal engine (read-only)** returns no private result. Its notification uses validated scalar counts and fixed messages only. It is silent on stale/cancelled work and never logs note bodies, graph paths or UUIDs. It neither runs on startup nor shares the setup window's Refresh action.

## Internal engine API

```js
import { createJournalEngine, resolveJournalSections } from "./src/journal-engine.js";

const engine = createJournalEngine({
  invoke: (...args) => sdk.App.invokeExternalPlugin(...args),
});
// snapshot is normalized input; journal-adapter.js now collects it via the SDK.
const result = await engine.plan(snapshot);
// Inspect result programmatically only. There is intentionally no apply method.
await engine.invalidate(); // graph-context changes cancel/suppress old work
await engine.destroy();
```

This direct-engine example is API documentation; the active read-only command uses journal-adapter.js instead. Construction starts no timers, graph reads, or Calendar calls. `plan()` checks Calendar afresh using `fromJournalDay`, `describeDate`, `describeToday`, per-call API checks and a final API check. Timeouts default to three seconds per invocation. `createUuid` can be injected for deterministic tests; by default new projected blocks use native `crypto.randomUUID()`. Generated IDs must be unique across the supplied graph snapshot and routine definitions.

### Snapshot v1

```text
{
  version: 1,
  graphId: nonempty opaque graph-context string,
  journalDay: integer Gregorian YYYYMMDD for the target,
  ownerScanComplete: true,
  pages: [
    { name: existing native page name, journalDay: integer YYYYMMDD,
      blocks: expanded normalized block tree }
  ],
  routines: {
    weekly: expanded Week Routine tree OR null if definitely missing,
    monthly: expanded Month Routine tree OR null if definitely missing
  }
}
```

Blocks require their own `uuid` and string `content`; `children` is optional for leaves, otherwise an expanded array. IDs use the hyphenated UUID spelling. Textual property lines are authoritative for the extracted model; SDK property metadata is not interpreted. The adapter normalizes supported SDK shapes and rejects observed incomplete/inconsistent reads before calling this API; exact Desktop shape coverage still needs live validation. **Do not translate failed reads into `null` or empty arrays.** Extra JSON-compatible metadata is preserved on reused blocks but may reflect pre-projection content; the projection is not an SDK entity cache to write back wholesale.

The collector must include every possible owner/collision for the requested periods, including misplaced or future loaded owners; it cannot stop at the first match. `ownerScanComplete` is required for today's initialization, but is only a **caller assertion**, not proof of graph-wide discovery, consistent graph identity, or an atomic snapshot. Neither setup approval nor a legacy-automation check is inferred from it.

Limits are conservative: at most 3,660 journal pages and 10,000 total blocks across the supplied pages plus routine definitions, with 100-level tree validation and the shared bounded JSON evidence copier's additional depth/node/text limits. Projections must pass the same snapshot limits before return. Split/partial scans must not claim completeness to bypass these limits.

### Results

All results have `version: 1`, `status`, `changes`, `owners`, and `nextJournal`.

- `planned`: includes `graphId`, original target `before`, private `nextJournal` projection, change summaries, warnings, stable section IDs, date-heading ID, and weekly/monthly owner locations/keys for today's journal. `changes: []` means no change within this supplied snapshot.
- `waiting / journal-not-created`: Logseq has not supplied the target native journal.
- `skipped / historical-journal`: no automatic past-journal migration.
- `blocked`: no partial projection or changes are returned. Reasons include invalid/ambiguous snapshots, incomplete owner scan, duplicate/conflicting sections or owners, wrong/future owner periods, unmarked populated routine sections, customized reference trees, reserved routine properties, Calendar unavailability, stale context, or disposal. SDK error details and private source text are not returned as reasons.

`changes` summarizes insert/update/move/remove differences by UUID and placement. **It is not an executable transaction or approved write plan.** It omits the SDK operations and concurrency/precondition checks needed for safe application. `nextJournal`, `before`, section IDs, and owner locations are private graph data: do not log, persist or display these results wholesale.

`resolveJournalSections(blocks)` returns a title → existing UUID/null map for the six Journal sections. It recognizes legacy weekly/monthly markers, rejects duplicate/conflicting root identities, and never creates blocks. This is an internal section-resolution boundary, not yet a registered cross-plugin service or arbitrary feature-section extension API.

## Safety differences from the legacy script

These are deliberate, not claims of exact migration parity:

- No startup all-journal rewrite, journal creation, scheduler, sidebar mutation, or feature automation.
- No first-match-wins for ambiguous period owners/sections. Nested managed sections, out-of-period owners, and future owners need explicit review.
- Unmarked populated routine sections block initialization: they may contain already-copied tasks whose loaded marker was lost. Do not duplicate them on a guess.
- Reserved Journal properties/section identities in routine defaults are rejected, including titles exposed by identity-property cleanup.
- Property-first marker-identified headings preserve their property lines; they must not lose loaded-owner state during heading formatting.
- Existing reference UUIDs are reused rather than deleting/recreating the entire reference tree. Custom reference text or attached unmanaged descendants blocks replacement.
- Unknown journal roots are not explicitly moved or reparented; only managed slots are permuted.
- Exact leaf placeholder cleanup is narrower than the legacy subtree deletion.
- Newly missing Notes/review sections are empty. Existing custom template notes/review prompts are preserved, not replaced with starter examples. Installing a daily-default preset remains a separate approved setup responsibility.
- Legacy routine-copy behavior drops an entire subtree if its cleaned parent is empty; pure model parity tests document this. No source graph content is deleted by the offline engine.

The engine captures caller data before its first async boundary, owns a generation counter, and invalidates outstanding Calendar work on supersession, explicit invalidation, or destruction. Results cannot publish after context invalidation, including reentrant UUID callbacks. **These safeguards do not authorize writes or replace write-time graph checks.**

## Validation and next implementation step

`src/journal-model.test.js` compares allowlisted extracted pure legacy functions against the new model in a Node VM; it never executes the legacy IIFE/automation. `src/journal-engine.test.js` supplies fixed provider responses and in-memory graph snapshots, checks projected outcomes, then replays them for duplicate prevention. No personal graph is used.

Adapter/normalizer/inspector and registration tests now cover strict SDK reads, snapshots, misplaced/duplicate owners, tuple expansion, budgets, graph/DB edit races, midnight, unload and private-summary-only output. The real bundled browser entrypoint also exercises the on-demand adapter/engine command against a strict mocked SDK. **0.3.0 validation: 601 Node tests and 13 Chromium fixture groups passed; build succeeded. No live Desktop collector/engine evidence has yet been obtained.**

Next build the approved per-graph execution path: setup-specific collision/template/configuration checks, legacy-automation detection, backup/setup approval, graph/dependency revalidation, serialized writes with partial-failure recovery, and startup/navigation/midnight scheduling. Live writes—not this read-only command—must wait for those gates and dependency validation. Then validate real Desktop parity and deliberately retire overlapping legacy execution. Do not add a second scheduler to the starter in the meantime.
