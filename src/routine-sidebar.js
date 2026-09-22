import { graphIdentity } from "./activation-storage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PERIODS = ["weekly", "monthly"];
const failure = (code) => Object.assign(new Error(code), { code });

/**
 * sync({ owners: enginePlan.owners, graphKey, enabled = true }) returns
 * {status, reason, owners: {weekly: {status,reason}, monthly: {status,reason}}}.
 * Per-owner status: requested | skipped | blocked; aggregate additionally partial.
 * "requested" means SDK call returned, NOT verified sidebar visibility.
 * Caller owns the enable toggle and must call reset on graph/lifecycle changes.
 * Optional guard({graphKey, kind, uuid, phase: 'sidebar-open'}) must return exactly
 * true, freshly checking lifecycle/graph authorization immediately before each open.
 * reset/destroy invalidate pending work but never clear/close anyone's sidebar.
 * Reads and guards are bounded; SDK calls already dispatched cannot be cancelled.
 *
 * Host evidence (Logseq tag 0.10.15):
 * - src/main/logseq/api.cljs:581 open_in_right_sidebar accepts UUID/entity ID.
 * - src/main/frontend/handler/editor.cljs:201 resolves entity, then calls state.
 * - src/main/frontend/state.cljs:1121 sidebar-add-block! removes matching db-id,
 *   prepends/reuses that card, expands it and opens sidebar, preserving other IDs.
 *   Small-screen breakpoint is a silent no-op. Reuse can reorder existing cards.
 * Installed @logseq/libs 0.0.17 dist/LSPlugin.d.ts:591 declares
 * Editor.openInRightSidebar(id: BlockUUID | EntityID): void. There is no supported
 * sidebar-list/visibility acknowledgement API. No DOM/private-state probes here.
 * We rely on host deduplication, not a local "already open" cache that goes stale
 * when a user closes a card. No date card, graph writes, settings or sidebar clear.
 */
export function createRoutineSidebar({ sdk, guard, timeoutMs = 3000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
      (guard !== undefined && typeof guard !== "function")) throw failure("invalid-sidebar-options");
  let generation = 0, destroyed = false, queue = Promise.resolve();
  const entry = (status, reason = null) => ({ status, reason });
  function all(status, reason) {
    return { status, reason, owners: { weekly: entry(status, reason), monthly: entry(status, reason) } };
  }
  async function bounded(fn, code) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn).catch(() => { throw failure(code); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure(`${code}-timeout`)), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function current(token) {
    if (destroyed) throw failure("destroyed");
    if (token !== generation) throw failure("stale-context");
  }
  async function run(owners, graphKey, token) {
    if (destroyed) return all("blocked", "destroyed");
    if (token !== generation) return all("blocked", "stale-context");
    if (typeof graphKey !== "string" || !HASH.test(graphKey)) return all("blocked", "invalid-graph-key");
    if (!owners || typeof owners !== "object" || Array.isArray(owners)) return all("blocked", "invalid-owners");
    if (typeof sdk?.Editor?.openInRightSidebar !== "function") return all("blocked", "sidebar-open-api-unavailable");
    if (typeof sdk?.Editor?.getBlock !== "function") return all("blocked", "sidebar-block-read-api-unavailable");
    if (typeof sdk?.App?.getCurrentGraph !== "function") return all("blocked", "sidebar-graph-read-api-unavailable");
    const results = {};
    for (const kind of PERIODS) {
      const owner = owners[kind];
      if (owner == null) { results[kind] = entry("skipped", "no-owner"); continue; }
      if (typeof owner !== "object" || !UUID.test(owner.uuid) || typeof owner.page !== "string" ||
          !owner.page.trim() || typeof owner.key !== "string" || !owner.key.trim()) {
        results[kind] = entry("blocked", "invalid-owner");
        continue;
      }
      try {
        current(token);
        const identity = await bounded(() => graphIdentity(sdk), "sidebar-graph-read-failed");
        current(token);
        if (identity.key !== graphKey) throw failure("graph-changed");
        const block = await bounded(() => sdk.Editor.getBlock(owner.uuid, { includeChildren: false }), "sidebar-block-read-failed");
        current(token);
        if (!block || typeof block.uuid !== "string" || block.uuid.toLowerCase() !== owner.uuid.toLowerCase()) {
          throw failure("owner-block-missing");
        }
        // Recheck after the block read; it may have crossed a graph switch.
        const fresh = await bounded(() => graphIdentity(sdk), "sidebar-graph-read-failed");
        current(token);
        if (fresh.key !== graphKey) throw failure("graph-changed");
        if (guard && await bounded(() => guard({ graphKey, kind, uuid: owner.uuid, phase: "sidebar-open" }), "sidebar-guard-failed") !== true) {
          throw failure("guard-denied");
        }
        current(token);
        const response = await bounded(() => {
          current(token);
          return sdk.Editor.openInRightSidebar(owner.uuid);
        }, "sidebar-open-failed");
        if (response === false) throw failure("sidebar-open-failed");
        results[kind] = entry("requested");
      } catch (error) {
        results[kind] = entry("blocked", error.code ?? "sidebar-open-failed");
      }
    }
    const requested = Object.values(results).some((result) => result.status === "requested");
    const blocked = Object.values(results).find((result) => result.status === "blocked");
    return { status: blocked ? (requested ? "partial" : "blocked") : requested ? "requested" : "skipped",
      reason: blocked?.reason ?? (requested ? null : "no-owners"), owners: results };
  }
  return {
    async sync({ owners, graphKey, enabled = true } = {}) {
      const token = ++generation;
      if (destroyed) return all("blocked", "destroyed");
      if (enabled !== true) return all("skipped", "disabled");
      // Capture only owner metadata, never a plan/tree or caller-owned mutable object.
      let captured;
      try {
        captured = owners && !Array.isArray(owners) && typeof owners === "object" ? Object.fromEntries(PERIODS.map((kind) => {
          const owner = owners[kind];
          return [kind, owner == null ? null : { uuid: owner.uuid, page: owner.page, key: owner.key }];
        })) : null;
      } catch { return all("blocked", "invalid-owners"); }
      const work = queue.then(() => run(captured, graphKey, token));
      queue = work.catch(() => {});
      return work;
    },
    reset() { generation += 1; },
    destroy() { destroyed = true; generation += 1; },
  };
}
