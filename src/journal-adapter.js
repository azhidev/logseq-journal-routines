import { createCalendarClient } from "./calendar-client.js";
import { createJournalEngine } from "./journal-engine.js";
import { blockProperty, validateBlocks } from "./journal-model.js";
import { snapshotSetupEvidence } from "./setup-plan.js";
import { GraphDataError, normalizeBlock, normalizeGraph, normalizePage } from "./graph-normalize.js";

class ReadError extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (value) => value.toLowerCase();
const fail = (reason) => { throw new ReadError(reason); };
const requireValue = (value, reason) => { if (!value) fail(reason); };
const ROUTINES = [["weekly", "Week Routine"], ["monthly", "Month Routine"]];

function summary() {
  return { pagesScanned: 0, journalsScanned: 0, blocksScanned: 0,
    changes: { insert: 0, update: 0, move: 0, remove: 0 }, owners: { weekly: "none", monthly: "none" } };
}
function denseArray(value, limit) {
  requireValue(Array.isArray(value), "malformed-response");
  requireValue(value.length <= limit, "scan-limit");
  const items = [];
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, i);
    requireValue(property && Object.hasOwn(property, "value"), "malformed-response");
    items.push(property.value);
  }
  return items;
}

/**
 * On-demand, read-only graph-to-engine adapter. No reads/hooks start at construction.
 * inspect() owns graph/DB invalidation for the WHOLE scan + engine pipeline.
 * Successful snapshot/plan fields are private; only summary is suitable for UI.
 */
export function createJournalAdapter({ sdk, timeoutMs = 3000, totalTimeoutMs = 30000,
  maxPages = 3660, maxBlocks = 10000, maxCalls = 20000, maxDepth = 40,
  maxTextLength = 4_000_000, createUuid = () => globalThis.crypto.randomUUID() }) {
  for (const [value, maximum] of [[timeoutMs, 2_147_483_647], [totalTimeoutMs, 2_147_483_647],
    [maxPages, 3660], [maxBlocks, 10000], [maxCalls, 100000], [maxDepth, 40], [maxTextLength, 4_000_000]]) {
    requireValue(Number.isInteger(value) && value > 0 && value <= maximum, "invalid-limits");
  }
  let disposed = false, pending;
  return {
    async inspect({ journalDay, signal } = {}) {
      const stats = summary();
      const blocked = (reason) => ({ version: 1, status: "blocked", reason,
        summary: { ...stats, changes: summary().changes, owners: summary().owners } });
      if (disposed) return blocked("disposed");
      pending?.stop("superseded");
      const controller = new AbortController();
      const request = { reason: null, stop(reason) {
        if (!controller.signal.aborted) { request.reason = reason; controller.abort(); }
      } };
      pending = request;
      const { stop } = request;
      const hooks = [];
      const totalTimer = setTimeout(() => stop("scan-timeout"), totalTimeoutMs);
      let calendar, engine, graph, calls = 0, textLength = 0;
      const abort = () => stop("cancelled");
      function active() { if (controller.signal.aborted) fail(request.reason); }
      // Snapshot/normalize inside settlement, before yielding back to the caller.
      // SDK-owned mutable objects are never retained across later graph reads.
      function read(invoke, normalize = snapshotSetupEvidence, failure = "read-failed") {
        active();
        if (++calls > maxCalls) { stop("scan-limit"); fail("scan-limit"); }
        return new Promise((resolve, reject) => {
          let finished = false;
          const timeoutReason = failure.endsWith("-read-failed") ? failure.replace(/-failed$/, "-timeout") : "read-timeout";
                    const timer = setTimeout(() => stop(timeoutReason), timeoutMs);
          function finish(error, value) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", cancelled);
            if (error) reject(error); else resolve(value);
          }
          function cancelled() { finish(new ReadError(request.reason)); }
          controller.signal.addEventListener("abort", cancelled, { once: true });
          Promise.resolve().then(() => {
            active();
            return invoke();
          }).then((value) => {
            if (finished) return;
            try { active(); finish(null, normalize(value)); }
            catch (error) {
              stop(error instanceof GraphDataError ? error.code : error instanceof ReadError ? error.message : "malformed-response");
            }
          }, () => { if (!finished) stop(failure); });
        });
      }
      const graphInfo = () => read(() => sdk.App.getCurrentGraph(), normalizeGraph, "graph-read-failed");
      async function verifyGraph() {
        const current = await graphInfo();
        if (current.path !== graph.path) { stop("graph-changed"); fail("graph-changed"); }
        active();
      }
      async function checkedRead(invoke, normalize, failure) {
        await verifyGraph();
        const value = await read(invoke, normalize, failure);
        await verifyGraph();
        return value;
      }
      const transport = (...args) => checkedRead(() => sdk.App.invokeExternalPlugin(...args), snapshotSetupEvidence, "calendar-unavailable");
      function inventory(raw) {
        const pages = denseArray(raw, maxPages).map(normalizePage);
        const names = new Set(), uuids = new Set(), ids = new Set(), days = new Set();
        for (const page of pages) {
          requireValue(!names.has(key(page.name)) && !uuids.has(key(page.uuid)) && !ids.has(page.id), "duplicate-page");
          names.add(key(page.name)); uuids.add(key(page.uuid)); ids.add(page.id);
          if (page.journalDay !== null) {
            requireValue(!days.has(page.journalDay), "duplicate-journal");
            days.add(page.journalDay);
          }
        }
        return pages.sort((a, b) => a.id - b.id);
      }
      // Capture the entire expanded response synchronously. Tuples stay explicit
      // and are resolved later; unknown SDK metadata is never serialized.
      function captureTree(raw) {
        let count = 0, chars = 0;
        function capture(list, depth) {
          requireValue(depth <= maxDepth, "scan-limit");
          return denseArray(list, maxBlocks).map((item) => {
            if (Array.isArray(item)) {
              const tuple = denseArray(item, 2);
              requireValue(tuple.length === 2 && tuple[0] === "uuid" && typeof tuple[1] === "string" && UUID.test(tuple[1]), "invalid-block");
              return tuple;
            }
            requireValue(++count <= maxBlocks, "scan-limit");
            const block = normalizeBlock(item);
            chars += block.content.length;
            requireValue(chars <= maxTextLength, "scan-limit");
            return { ...block, children: block.children.length ? capture(block.children, depth + 1) : [] };
          });
        }
        return capture(raw, 1);
      }
      try {
        if (signal?.aborted) stop("cancelled");
        signal?.addEventListener("abort", abort, { once: true });
        active();
        const onGraph = sdk.App.onCurrentGraphChanged(() => stop("graph-changed"));
        requireValue(typeof onGraph === "function", "subscription-unavailable"); hooks.push(onGraph);
        const onChange = sdk.DB.onChanged(() => stop("graph-edited"));
        requireValue(typeof onChange === "function", "subscription-unavailable"); hooks.push(onChange);
        graph = await graphInfo();
        calendar = createCalendarClient({ invoke: transport, timeoutMs });
        async function calendarRead(invoke) {
          try { return await invoke(); }
          catch { active(); fail("calendar-unavailable"); }
        }
        const today = await calendarRead(() => calendar.describeToday());
        const day = journalDay ?? today.gregorian.journalDay;
        requireValue(Number.isInteger(day) && /^\d{8}$/.test(String(day)), "invalid-request");
        const iso = await calendarRead(() => calendar.fromJournalDay(day));
        const description = await calendarRead(() => calendar.describeDate(iso));
        const pages = await checkedRead(() => sdk.Editor.getAllPages(), inventory, "inventory-read-failed");
        const initialInventory = JSON.stringify(pages);
        const seen = new Set(pages.map((page) => key(page.uuid)));
        const entityIds = new Set(pages.map((page) => page.id));
        const journalPages = [], routines = { weekly: null, monthly: null }, routineMetadata = {};
        // Missing is established by an explicit null lookup, never a failed read.
        for (const [kind, name] of ROUTINES) {
          const value = await checkedRead(() => sdk.Editor.getPage(name), (raw) => raw === null ? null : normalizePage(raw), "routine-read-failed");
          const listed = pages.find((page) => key(page.name) === key(name));
          // getPage may include optional metadata omitted by getAllPages.
          const agrees = value && listed && value.id === listed.id && key(value.uuid) === key(listed.uuid) &&
            key(value.name) === key(listed.name) && value.journalDay === listed.journalDay &&
            (value.format === null || listed.format === null || value.format === listed.format);
          requireValue(value === null ? !listed : agrees, "inventory-changed");
          if (value) requireValue(key(value.name) === key(name) && value.journalDay === null, "invalid-routine-page");
          routineMetadata[kind] = value;
        }
        const claims = { weekly: [], monthly: [] };
        async function expand(list, page, depth = 1, parent = null) {
          requireValue(depth <= maxDepth, "scan-limit");
          const result = [];
          for (let item of list) {
            active();
            const requested = Array.isArray(item) ? item[1] : item.uuid;
            requireValue(!seen.has(key(requested)), "duplicate-block");
            seen.add(key(requested));
            if (Array.isArray(item)) {
              const resolved = await checkedRead(() => sdk.Editor.getBlock(requested, { includeChildren: true }), (raw) => captureTree([raw]), "block-read-failed");
              requireValue(resolved.length === 1 && key(resolved[0].uuid) === key(requested), "mismatched-block");
              item = resolved[0];
            }
            requireValue(item.pageId === null || item.pageId === page.id, "wrong-block-page");
            if (item.id !== null) {
              requireValue(!entityIds.has(item.id), "duplicate-block");
              entityIds.add(item.id);
            }
            stats.blocksScanned += 1;
            textLength += item.content.length;
            requireValue(stats.blocksScanned <= maxBlocks && textLength <= maxTextLength, "scan-limit");
            const block = { uuid: item.uuid, content: item.content, children: [] };
            const loaded = blockProperty(block, "routine-loaded");
            for (const [kind, field] of [["weekly", "week"], ["monthly", "month"]]) {
              if (loaded === description[field].key) claims[kind].push({ page, uuid: block.uuid, parent });
            }
            block.children = item.children.length ? await expand(item.children, page, depth + 1, block.uuid) : [];
            result.push(block);
          }
          return result;
        }
        for (const page of pages) {
          // Desktop 0.10.15 accepts UUID strings, not the SDK-declared { uuid } form.
          const captured = await checkedRead(() => sdk.Editor.getPageBlocksTree(page.uuid), captureTree, "tree-read-failed");
          const blocks = await expand(captured, page);
          validateBlocks(blocks);
          stats.pagesScanned += 1;
          if (page.journalDay !== null) {
            stats.journalsScanned += 1;
            journalPages.push({ name: page.name, journalDay: page.journalDay, blocks });
          }
          for (const [kind] of ROUTINES) {
            if (routineMetadata[kind] && key(routineMetadata[kind].uuid) === key(page.uuid)) routines[kind] = blocks;
          }
        }
        for (const [kind] of ROUTINES) {
          requireValue(claims[kind].length <= 1, "duplicate-period-owner");
          requireValue(claims[kind].every((claim) => claim.page.journalDay !== null), "non-journal-period-owner");
        }
        const snapshot = { version: 1, graphId: globalThis.crypto.randomUUID(), journalDay: Number(day),
          ownerScanComplete: true, pages: journalPages, routines };
        // This is an on-demand engine connection, never an execution adapter.
        engine = createJournalEngine({ invoke: transport, timeoutMs, createUuid });
        const plan = await engine.plan(snapshot);
        active();
        const finalPages = await checkedRead(() => sdk.Editor.getAllPages(), inventory, "inventory-read-failed");
        requireValue(JSON.stringify(finalPages) === initialInventory, "inventory-changed");
        const finalToday = await calendarRead(() => calendar.describeToday());
        requireValue(finalToday.gregorian.iso === today.gregorian.iso, "date-changed");
        await verifyGraph();
        if (plan.status === "blocked") return blocked(plan.reason);
        requireValue(["planned", "waiting", "skipped"].includes(plan.status), "engine-unavailable");
        if (plan.status === "planned") {
          for (const change of plan.changes) {
            requireValue(Object.hasOwn(stats.changes, change.kind), "engine-unavailable");
            if (change.kind === "insert") requireValue(!seen.has(key(change.uuid)), "duplicate-new-identity");
            stats.changes[change.kind] += 1;
          }
          for (const [kind] of ROUTINES) {
            const owner = plan.owners[kind];
            stats.owners[kind] = !owner ? "none" : claims[kind].some((claim) => key(claim.uuid) === key(owner.uuid)) ? "existing" : "new";
          }
        }
        active();
        return { version: 1, status: plan.status, reason: plan.reason, summary: stats, snapshot, plan };
      } catch (error) {
        return blocked(request.reason ?? (error instanceof GraphDataError ? error.code :
          error instanceof ReadError ? error.message : "collection-unavailable"));
      } finally {
        clearTimeout(totalTimer);
        signal?.removeEventListener("abort", abort);
        // Close local waits before releasing subscriptions; late remote replies
        // are inert. Each hook owns exactly one unsubscribe, even on failure.
        stop("cancelled");
        void calendar?.destroy();
        void engine?.destroy();
        for (const off of hooks.reverse()) { try { off(); } catch { /* All hooks still get a cleanup attempt. */ } }
        if (pending === request) pending = undefined;
      }
    },
    invalidate() { pending?.stop("cancelled"); },
    destroy() { disposed = true; pending?.stop("disposed"); },
  };
}
