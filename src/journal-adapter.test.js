import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createJournalAdapter } from "./journal-adapter.js";

const uuid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
const page = (id, name, day) => ({ id, uuid: uuid(id), name, "journal?": day !== undefined,
  ...(day === undefined ? {} : { journalDay: day }), format: "markdown" });
const block = (id, content, children = []) => ({ id, uuid: uuid(id), content, children, format: "markdown" });
const INFO = { id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"] };
const DATE = {
  gregorian: { year: 2025, month: 3, day: 21, iso: "2025-03-21", journalDay: 20250321 },
  persian: { year: 1404, month: 1, day: 1, iso: "1404-01-01", label: "جمعه 1 فروردین 1404", weekOfYear: 1 },
  week: { start: "2025-03-15", end: "2025-03-21", key: "weekly-20250315" },
  month: { start: "2025-03-21", end: "2025-04-20", key: "monthly-1404-01", financeKey: "1404-01" },
};
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function harness(t, options = {}) {
  const state = {
    graph: { name: "PRIVATE graph", path: "/PRIVATE/path" },
    pages: [page(1, "native today", 20250321), page(2, "prior", 20250320), page(3, "private notes"),
      page(4, "week routine"), page(5, "month routine")],
    trees: new Map([
      [uuid(1), [block(100, "## Tasks", [block(101, "PRIVATE note")])]],
      [uuid(2), [block(200, "## Weekly tasks — 53\nroutine-loaded:: weekly-20250315\nroutine-section:: [[Routine Weekly Section]]", [block(201, "DONE shared task")])]],
      [uuid(3), [block(300, "PRIVATE unrelated note")]],
      [uuid(4), [block(400, "# Week Routine", [block(401, "TODO weekly default")])]],
      [uuid(5), [block(500, "# Month Routine", [block(501, "TODO monthly default")])]],
    ]),
    blocks: new Map(), calls: [], graphHooks: new Set(), dbHooks: new Set(),
    before: null, getAllPages: null, getPage: null, provider: true, date: structuredClone(DATE),
  };
  const unexpected = [];
  const strict = (object) => new Proxy(object, { get(target, name) {
    if (Object.hasOwn(target, name)) return target[name];
    unexpected.push(String(name)); throw new Error("Forbidden SDK access");
  } });
  const read = (name, run) => async (...args) => {
    state.calls.push([name, ...args]);
    await state.before?.(name, args);
    return run(...args);
  };
  const sdk = strict({
    App: strict({
      getCurrentGraph: read("graph", () => state.graph),
      onCurrentGraphChanged(callback) { state.graphHooks.add(callback); return () => state.graphHooks.delete(callback); },
      invokeExternalPlugin: read("calendar", (target, ...args) => {
        if (!state.provider) throw new Error("PRIVATE provider error");
        if (target.endsWith("getApiInfo")) return structuredClone(INFO);
        if (target.endsWith("fromJournalDay")) { assert.equal(args[0], 20250321); return "2025-03-21"; }
        if (target.endsWith("describeDate")) { assert.equal(args[0], "2025-03-21"); return structuredClone(DATE); }
        if (target.endsWith("describeToday")) return state.date;
        throw new Error("Unexpected Calendar method");
      }),
    }),
    DB: strict({ onChanged(callback) { state.dbHooks.add(callback); return () => state.dbHooks.delete(callback); } }),
    Editor: strict({
      getAllPages: read("inventory", () => state.getAllPages ? state.getAllPages() : state.pages),
      getPage: read("page", (name) => state.getPage ? state.getPage(name) : state.pages.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? null),
      getPageBlocksTree: read("tree", (identity) => { assert.equal(typeof identity, "string", "Desktop 0.10.15 requires a string page identity"); return state.trees.get(identity); }),
      getBlock: read("block", (id, options) => { assert.deepEqual(options, { includeChildren: true }); return state.blocks.get(id) ?? null; }),
    }),
  });
  let nextId = 10000;
  const adapter = createJournalAdapter({ sdk, createUuid: () => uuid(nextId++), ...options });
  t.after(() => {
    adapter.destroy();
    assert.deepEqual(unexpected, []);
    assert.equal(state.graphHooks.size, 0);
    assert.equal(state.dbHooks.size, 0);
  });
  return { adapter, state, sdk,
    emitGraph: () => { for (const callback of state.graphHooks) callback(); },
    emitEdit: () => { for (const callback of state.dbHooks) callback({ blocks: [], txData: [] }); },
  };
}
function safeBlocked(result, reason) {
  assert.equal(result.status, "blocked");
  if (reason) assert.equal(result.reason, reason);
  assert.equal(result.snapshot, undefined);
  assert.equal(result.plan, undefined);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
}

test("lazy construction; full graph collection feeds real engine and returns private projection plus safe summary", async (t) => {
  const { adapter, state } = harness(t);
  assert.equal(state.calls.length, 0);
  assert.equal(state.graphHooks.size, 0);
  const before = structuredClone({ pages: state.pages, trees: state.trees });
  const result = await adapter.inspect();
  assert.equal(result.status, "planned", result.reason);
  assert.equal(result.snapshot.ownerScanComplete, true);
  assert.equal(result.snapshot.pages.length, 2);
  assert.equal(result.summary.pagesScanned, 5);
  assert.equal(result.summary.journalsScanned, 2);
  assert.equal(result.summary.blocksScanned, 9);
  assert.equal(result.summary.owners.weekly, "existing");
  assert.equal(result.summary.owners.monthly, "new");
  assert.ok(result.summary.changes.insert > 0);
  assert.equal(result.plan.owners.weekly.uuid, uuid(200));
  assert.notEqual(result.snapshot.graphId, state.graph.path);
  assert.ok(!JSON.stringify(result.summary).includes("PRIVATE"));
  assert.deepEqual({ pages: state.pages, trees: state.trees }, before);
  assert.deepEqual(state.calls.filter(([name]) => name === "tree").map(([, identity]) => identity), state.pages.map((entry) => entry.uuid));
  assert.equal(state.calls.filter(([name]) => name === "inventory").length, 2);
});

test("UUID tuples expand recursively through supported getBlock reads with ownership checks", async (t) => {
  const { adapter, state } = harness(t);
  state.trees.set(uuid(3), [block(300, "parent", [["uuid", uuid(301)]])]);
  state.blocks.set(uuid(301), { ...block(301, "PRIVATE resolved child", [["uuid", uuid(302)]]), page: { id: 3 } });
  state.blocks.set(uuid(302), { ...block(302, "leaf"), page: { id: 3 } });
  const result = await adapter.inspect();
  assert.equal(result.status, "planned", result.reason);
  assert.equal(state.calls.filter(([name]) => name === "block").length, 2);
  assert.equal(result.summary.blocksScanned, 11);
});

test("missing routines require explicit null and stay distinct from an empty existing routine", async (t) => {
  const { adapter, state } = harness(t);
  state.pages = state.pages.filter((entry) => entry.id !== 4);
  state.trees.set(uuid(5), []);
  const result = await adapter.inspect();
  assert.equal(result.status, "planned", result.reason);
  assert.equal(result.snapshot.routines.weekly, null);
  assert.deepEqual(result.snapshot.routines.monthly, []);
  assert.equal(result.summary.owners.monthly, "none");
});

for (const [label, change, reason] of [
  ["owner on nonjournal page", (s) => { s.trees.set(uuid(3), [block(300, "## Monthly tasks\nroutine-loaded:: monthly-1404-01")]); }, "non-journal-period-owner"],
  ["duplicate owner across journal and nonjournal", (s) => { s.trees.set(uuid(3), [block(300, "## Weekly tasks\nroutine-loaded:: weekly-20250315")]); }, "duplicate-period-owner"],
  ["owner on future page", (s) => { s.pages.push(page(6, "future", 20250322)); s.trees.set(uuid(6), [block(600, "## Monthly tasks\nroutine-loaded:: monthly-1404-01")]); }, "future-period-owner"],
  ["owner outside period", (s) => { s.trees.get(uuid(2))[0].content = "## Monthly tasks\nroutine-loaded:: monthly-1404-01"; }, "owner-outside-period"],
  ["nested owner", (s) => { s.trees.set(uuid(2), [block(202, "parent", s.trees.get(uuid(2)))]); }, "invalid-period-owner"],
  ["duplicate journal identity", (s) => { s.pages.push(page(6, "same day", 20250321)); }, "duplicate-journal"],
  ["null inventory", (s) => { s.getAllPages = () => null; }, "malformed-response"],
  ["journal flag absent", (s) => { delete s.pages[2]["journal?"]; }, "invalid-page"],
  ["Org nonjournal page", (s) => { s.pages[2].format = "org"; }, "unsupported-format"],
  ["Org block", (s) => { s.trees.get(uuid(3))[0].format = "org"; }, "unsupported-format"],
  ["metadata-only owner", (s) => { s.trees.get(uuid(3))[0].properties = { routineLoaded: "monthly-1404-01" }; }, "conflicting-properties"],
  ["conflicting page alias", (s) => { s.pages[0]["block/name"] = "other"; }, "conflicting-aliases"],
  ["null tree", (s) => { s.trees.set(uuid(3), null); }, "malformed-response"],
  ["missing tree response", (s) => { s.trees.delete(uuid(3)); }, "malformed-response"],
  ["wrong page membership", (s) => { s.trees.get(uuid(3))[0].page = { id: 1 }; }, "wrong-block-page"],
  ["duplicate block UUID", (s) => { s.trees.get(uuid(3))[0].uuid = uuid(200); }, "duplicate-block"],
  ["duplicate block entity ID", (s) => { s.trees.get(uuid(3))[0].id = 200; }, "duplicate-block"],
  ["routine lookup inconsistent inventory", (s) => { s.getPage = () => null; }, "inventory-changed"],
  ["routine page is a journal", (s) => { s.pages[3]["journal?"] = true; s.pages[3].journalDay = 20250319; }, "invalid-routine-page"],
]) {
  test(`incomplete/ambiguous evidence blocks instead of being omitted: ${label}`, async (t) => {
    const { adapter, state } = harness(t);
    change(state);
    safeBlocked(await adapter.inspect(), reason);
  });
}

for (const [label, resolved, reason] of [
  ["missing", null, "invalid-block"],
  ["wrong UUID", block(399, "wrong"), "mismatched-block"],
  ["cycle", block(301, "cycle", [["uuid", uuid(301)]]), "duplicate-block"],
  ["wrong page", { ...block(301, "wrong page"), page: { id: 2 } }, "wrong-block-page"],
]) {
  test(`unresolved child cannot silently become a leaf: ${label}`, async (t) => {
    const { adapter, state } = harness(t);
    state.trees.set(uuid(3), [block(300, "parent", [["uuid", uuid(301)]])]);
    state.blocks.set(uuid(301), resolved);
    safeBlocked(await adapter.inspect(), reason);
  });
}

for (const [limit, value] of [["maxPages", 4], ["maxBlocks", 3], ["maxCalls", 2], ["maxTextLength", 10], ["maxDepth", 1]]) {
  test(`exhausting ${limit} never reports a complete scan`, async (t) => {
    const { adapter } = harness(t, { [limit]: value });
    safeBlocked(await adapter.inspect(), "scan-limit");
  });
}

for (const event of ["graph", "edit", "abort", "dispose", "supersede"]) {
  test(`pending scan is invalidated by ${event}; late SDK reply is inert`, async (t) => {
    const h = harness(t), gate = deferred();
    let reached = false;
    h.state.before = async (name) => {
      if (name === "tree" && !reached) { reached = true; await gate.promise; }
    };
    const abort = new AbortController();
    const pending = h.adapter.inspect({ signal: abort.signal });
    await nextTurn();
    assert.equal(reached, true);
    let fresh;
    if (event === "graph") { h.emitGraph(); h.state.graph.path = "/PRIVATE/B"; h.state.graph.path = "/PRIVATE/path"; }
    if (event === "edit") h.emitEdit();
    if (event === "abort") abort.abort("PRIVATE abort reason");
    if (event === "dispose") h.adapter.destroy();
    if (event === "supersede") fresh = h.adapter.inspect();
    const result = await pending;
    safeBlocked(result, { graph: "graph-changed", edit: "graph-edited", abort: "cancelled", dispose: "disposed", supersede: "superseded" }[event]);
    gate.resolve();
    await nextTurn();
    if (fresh) assert.equal((await fresh).status, "planned");
    if (event === "dispose") safeBlocked(await h.adapter.inspect(), "disposed");
  });
}

test("sampled path change blocks even when no event arrives", async (t) => {
  const { adapter, state } = harness(t);
  state.before = (name) => { if (name === "tree") state.graph.path = "/PRIVATE/changed"; };
  safeBlocked(await adapter.inspect(), "graph-changed");
});

test("final inventory catches additions/deletions without a delivered DB event", async (t) => {
  const { adapter, state } = harness(t);
  let inventories = 0;
  state.getAllPages = () => ++inventories === 1 ? state.pages : state.pages.slice(1);
  safeBlocked(await adapter.inspect(), "inventory-changed");
});

test("graph edit during the engine phase discards its projection", async (t) => {
  const h = harness(t);
  let fromCalls = 0;
  h.state.before = (name, args) => {
    if (name === "calendar" && args[0].endsWith("fromJournalDay") && ++fromCalls === 2) h.emitEdit();
  };
  safeBlocked(await h.adapter.inspect(), "graph-edited");
});

for (const options of [{ timeoutMs: 10 }, { timeoutMs: 1000, totalTimeoutMs: 10 }]) {
  test(`hung SDK read respects ${options.totalTimeoutMs ? "overall" : "per-call"} deadline and recovers`, async (t) => {
    const { adapter, state } = harness(t, options);
    state.before = (name) => name === "tree" ? new Promise(() => {}) : undefined;
    safeBlocked(await adapter.inspect(), options.totalTimeoutMs ? "scan-timeout" : "tree-read-timeout");
    state.before = null;
    assert.equal((await adapter.inspect()).status, "planned");
  });
}

test("SDK rejection and Calendar loss remain sanitized, then recover", async (t) => {
  const { adapter, state } = harness(t);
  state.before = (name) => { if (name === "tree") throw new Error("PRIVATE note path"); };
  safeBlocked(await adapter.inspect(), "tree-read-failed");
  state.before = null;
  state.provider = false;
  safeBlocked(await adapter.inspect(), "calendar-unavailable");
  state.provider = true;
  assert.equal((await adapter.inspect()).status, "planned");
});

test("inventory SDK objects are captured before later host mutation", async (t) => {
  const { adapter, state } = harness(t);
  const original = state.pages;
  let captured = false;
  state.before = (name) => {
    if (name === "inventory" && !captured) { captured = true; return; }
    if (name === "page" && state.pages === original) {
      state.pages = structuredClone(original);
      original[0].name = "PRIVATE mutated original";
    }
  };
  const result = await adapter.inspect();
  assert.equal(result.status, "planned", result.reason);
  assert.equal(result.plan.nextJournal.name, "native today");
});

test("absent native target waits without creating it", async (t) => {
  const { adapter, state } = harness(t);
  state.pages = state.pages.filter((entry) => entry.id !== 1);
  const result = await adapter.inspect();
  assert.equal(result.status, "waiting", result.reason);
  assert.equal(result.reason, "journal-not-created");
  assert.equal(result.plan.nextJournal, null);
});

test("new projected IDs cannot collide with unselected nonjournal blocks", async (t) => {
  let next = 9999;
  const { adapter } = harness(t, { createUuid: () => ++next === 10000 ? uuid(300) : uuid(next) });
  safeBlocked(await adapter.inspect(), "duplicate-new-identity");
});

test("routine lookup can enrich optional inventory metadata without changing identity", async (t) => {
  const { adapter, state } = harness(t);
  state.getPage = (name) => {
    const entry = state.pages.find((page) => page.name === name.toLowerCase());
    const copy = { ...entry, name, format: "markdown" };
    return copy;
  };
  delete state.pages[3].format;
  delete state.pages[4].format;
  assert.equal((await adapter.inspect()).status, "planned");
});

test("midnight during the pipeline discards the now-stale target observation", async (t) => {
  const { adapter, state } = harness(t);
  let todayCalls = 0;
  state.before = (name, args) => {
    if (name === "calendar" && args[0].endsWith("describeToday") && ++todayCalls === 3) {
      state.date = { ...structuredClone(DATE),
        gregorian: { ...DATE.gregorian, day: 22, iso: "2025-03-22", journalDay: 20250322 },
        persian: { ...DATE.persian, day: 2, iso: "1404-01-02", weekOfYear: 2 },
        week: { start: "2025-03-22", end: "2025-03-28", key: "weekly-20250322" },
      };
    }
  };
  safeBlocked(await adapter.inspect(), "date-changed");
});

test("pre-aborted signal does not touch SDK; failed DB subscription releases graph hook", async (t) => {
  const { adapter, state, sdk } = harness(t);
  const control = new AbortController(); control.abort();
  safeBlocked(await adapter.inspect({ signal: control.signal }), "cancelled");
  assert.equal(state.calls.length, 0);
  sdk.DB.onChanged = () => { throw new Error("PRIVATE subscription failure"); };
  safeBlocked(await adapter.inspect(), "collection-unavailable");
  assert.equal(state.graphHooks.size, 0);
});
