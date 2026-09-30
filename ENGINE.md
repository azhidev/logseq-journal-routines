# Engineering entry point

The lightweight runtime replaces the former journal-projection/owner-discovery engine. Product authority is [SCOPE.md](SCOPE.md); implemented behavior and limitations are in [README.md](README.md). Continue with the Desktop validation gate in [NEXT_SESSION.md](NEXT_SESSION.md).

## Data flow

1. `register.js` owns palette commands and mounts `routines-view.js` only on demand.
2. `routines-runtime.js` captures the current graph and generation when actions are requested, serializes work and rechecks authorization around SDK operations. A graph change/Disable/unload invalidates pending work. A next-local-day timer and resume events replace polling.
3. `period-model.js` computes standalone Gregorian periods or qualifies Jalali bounds returned by `calendar-client.js`. Both calendar/kind and inclusive civil bounds participate in identity.
4. `period-snapshot.js` reads exact definition/current-period resources. Together with `routine-history.js`, it uses `page-metadata.js` to create fresh pages without SDK property objects, then parse complete metadata text through `updateBlock` on a verified first root. Native title headers are preserved; ambiguous/interrupted bootstrap pauses without adoption or repair. It uses the actual properties pre-block for mutable checkpoints. A definition fingerprint plus fresh block IDs/cursor allow verified continuation; ambiguous outcomes pause. Completed task content is never repopulated.
5. Native sidebar requests target verified summary-block UUIDs, with page fallback only for older page-only plans. Session-local automatic-open tracking respects manual closure; no sidebar-wide clear or private DOM task renderer exists.
6. `routine-history.js` creates an ordinary history page only on explicit request. Native page queries own evaluation/rendering; the plugin has no background history inventory.

IndexedDB stores preferences and per-resource creation markers, never task content. Write intent markers precede possible resource creation to avoid rebuilding user-deleted pages after ambiguous writes. They are local to the plugin profile and graph path; see README for backup limits.

## Host boundary

Logseq 0.10.15 page creation with a nonempty properties object can store an unserializable `cljs-bean/Bean` on the page. Avoid that API path: create with null properties and parse metadata text instead. The first-root bootstrap must become a verified native pre-block before task/query insertion. `insertBlock` acknowledgements may contain a UUID without a numeric ID; persisted identity comes from subsequent reads. A native title header may initially exist without mirrored page properties. The resulting header appears in page trees, has a separate UUID, and precedes root content. `upsertBlockProperty` must target it, not the page UUID. Mutable header state is authoritative because the page's property mirror may lag. Fixtures model this explicitly.

SDK operations and graph-switch checks are not atomic transactions. Source inspection plus fixtures improve confidence but do not replace real Desktop validation, especially metadata serialization/indexing, native sidebar behavior and history-query rendering.
