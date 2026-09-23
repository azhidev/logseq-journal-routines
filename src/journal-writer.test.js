import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createJournalWriter } from "./journal-writer.js";
import { createJournalEngine } from "./journal-engine.js";
import { blockProperty } from "./journal-model.js";

const uuid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
const block = (n, content, children = []) => ({ uuid: uuid(n), content, children });
const clone = (value) => structuredClone(value);
const INFO = { id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"] };
function description(day) {
  const iso = `2025-03-${String(day).slice(-2)}`, pd = day - 20250320;
  return {
    gregorian: { year: 2025, month: 3, day: day % 100, iso, journalDay: day },
    persian: { year: 1404, month: 1, day: pd, iso: `1404-01-0${pd}`, label: `تاریخ 1404-01-0${pd}`, weekOfYear: pd === 1 ? 1 : 2 },
    week: pd === 1 ? { start: "2025-03-15", end: "2025-03-21", key: "weekly-20250315" } :
      { start: "2025-03-22", end: "2025-03-28", key: "weekly-20250322" },
    month: { start: "2025-03-21", end: "2025-04-20", key: "monthly-1404-01", financeKey: "1404-01" },
  };
}
function snapshot(blocks = [], day = 20250321) {
  return { version: 1, graphId: "ephemeral-scan", journalDay: day, ownerScanComplete: true,
    pages: [{ name: `journal-${day}`, journalDay: day, blocks }],
    routines: { weekly: [block(100, "TODO private weekly\ncustom:: keep", [block(101, "DONE nested")])],
      monthly: [block(110, "TODO private monthly")] } };
}
async function planFor(t, source, today = source.journalDay) {
  let next = 10000;
  const existing = new Set([...entries(source.pages.flatMap((page) => page.blocks)).keys()]);
  const engine = createJournalEngine({
    createUuid() { while (existing.has(uuid(next))) next++; return uuid(next++); },
    async invoke(target, ...args) {
      const method = target.split(".").at(-1);
      if (method === "getApiInfo") return clone(INFO);
      if (method === "fromJournalDay") return description(args[0]).gregorian.iso;
      if (method === "describeDate") return description(Number(args[0].replaceAll("-", "")));
      if (method === "describeToday") return description(today);
      throw new Error("Unexpected Calendar call");
    },
  });
  t.after(() => engine.destroy());
  const plan = await engine.plan(source);
  assert.equal(plan.status, "planned", plan.reason);
  return plan;
}
function entries(tree) {
  const result = new Map();
  function walk(list, parent = null) {
    list.forEach((block, position) => {
      result.set(block.uuid, { block, list, position, parent });
      walk(block.children ?? [], block.uuid);
    });
  }
  walk(tree);
  return result;
}
function bare(tree) {
  return tree.map(({ uuid, content, children = [] }) => ({ uuid, content, children: bare(children) }));
}
function harness(source, plan, options = {}) {
  const pageUuid = uuid(9000), graphKey = "verified-stable-graph-key";
  const input = { snapshot: source, plan, pageUuid, graphKey };
  const state = { tree: clone(plan.before.blocks), record: null, writes: [], saves: [], guards: [],
    today: source.journalDay, enabled: true, graphKey, foreign: new Map(), reads: 0,
    beforeWrite: null, afterWrite: null, beforeRead: null, guardHook: null, saveHook: null };
  const page = { id: 1, uuid: pageUuid, name: plan.before.name, journalDay: source.journalDay, "journal?": true, format: "markdown" };
  async function mutate(kind, id, perform, args) {
    assert.equal(state.record?.pending?.kind, kind, "durable intent precedes every SDK mutation");
    assert.equal(state.record.pending.uuid, id);
    assert.equal(state.guards.at(-1).phase, "write", "fresh guard immediately precedes mutation");
    state.writes.push({ kind, uuid: id, ...clone(args) });
    await state.beforeWrite?.(kind, id);
    const result = perform();
    await state.afterWrite?.(kind, id);
    return result;
  }
  const sdk = { Editor: {
    async getPage(ref) {
      assert.equal(typeof ref, "string", "Desktop 0.10.15 requires a string page identity");
            if (ref !== pageUuid) return clone(state.foreign.get(ref) ?? null);
      return clone(page);
    },
    async getPageBlocksTree(ref) {
      assert.equal(ref, pageUuid);
      await state.beforeRead?.(++state.reads);
      return clone(state.tree);
    },
    async getBlock(id) { return clone(state.foreign.get(id) ?? entries(state.tree).get(id)?.block ?? null); },
    async insertBlock(target, content, opts) {
      return mutate("insert", opts.customUUID, () => {
        assert.equal(entries(state.tree).has(opts.customUUID), false, "never insert duplicate UUID");
        const created = { uuid: opts.customUUID, content, children: [] };
        if (opts.isPageBlock) {
          assert.equal(target, pageUuid);
          assert.equal(opts.sibling, false);
          assert.equal(state.tree.length, 0, "page insertion only used for empty native journal");
          state.tree.push(created);
        } else {
          const anchor = entries(state.tree).get(target);
          assert.ok(anchor, "target exists");
          if (opts.sibling) anchor.list.splice(anchor.position + (opts.before ? 0 : 1), 0, created);
          else { anchor.block.children ??= []; anchor.block.children.unshift(created); }
        }
        return clone(created);
      }, { target, content, options: opts });
    },
    async updateBlock(id, content) {
      return mutate("update", id, () => { entries(state.tree).get(id).block.content = content; }, { content });
    },
    async moveBlock(id, target, opts) {
      return mutate("move", id, () => {
        const from = entries(state.tree).get(id);
        from.list.splice(from.position, 1);
        const anchor = entries(state.tree).get(target);
        assert.ok(anchor);
        if (opts.children) { anchor.block.children ??= []; anchor.block.children.unshift(from.block); }
        else anchor.list.splice(anchor.position + (opts.before ? 0 : 1), 0, from.block);
      }, { target, options: opts });
    },
    async removeBlock(id) {
      return mutate("remove", id, () => {
        const entry = entries(state.tree).get(id);
        assert.equal(entry.block.children?.length ?? 0, 0, "only leaf removal");
        entry.list.splice(entry.position, 1);
      }, {});
    },
  } };
  const recoveryStore = {
    async load(key) { assert.equal(key, graphKey); return clone(state.record); },
    async save(key, record) {
      assert.equal(key, graphKey);
      await state.saveHook?.(record);
      state.record = clone(record);
      state.saves.push(clone(record));
    },
  };
  async function guard(context) {
    state.guards.push(clone(context));
    await state.guardHook?.(context);
    return { allowed: state.enabled, graphKey: state.graphKey, todayJournalDay: state.today };
  }
  const makeWriter = (overrides = {}) => createJournalWriter({ sdk, guard, recoveryStore, ...options, ...overrides });
  return { input, state, page, sdk, recoveryStore, makeWriter, writer: makeWriter() };
}
async function clean(t, options) {
  const source = snapshot();
  return harness(source, await planFor(t, source), options);
}
function assertProjection(h) { assert.deepEqual(bare(h.state.tree), bare(h.input.plan.nextJournal.blocks)); }

// All SDK fixtures are isolated in memory; no personal graph or Desktop calls.
test("clean engine output: narrow writes, exact UUIDs, nested copies, loaded markers last, replay no-op", async (t) => {
  const h = await clean(t), saved = clone(h.input);
  const result = await h.writer.apply(h.input);
  assert.equal(result.status, "applied", result.reason);
  assertProjection(h);
  assert.deepEqual(clone(h.input), saved);
  assert.equal(h.state.record, null);
  const publications = h.state.writes.filter((op) => op.content?.includes("routine-loaded::"));
  assert.equal(publications.length, 2);
  assert.ok(publications.every((op) => op.kind === "update"));
  assert.deepEqual(h.state.writes.slice(-2), publications);
  assert.equal(result.operationsApplied, h.state.writes.length);
  const count = h.state.writes.length;
  assert.equal((await h.writer.apply(h.input)).status, "noop");
  const nextSource = clone(h.input.snapshot);
  nextSource.pages[0] = clone(h.input.plan.nextJournal);
  const replay = await planFor(t, nextSource);
  assert.equal((await h.makeWriter().apply({ ...h.input, snapshot: nextSource, plan: replay })).status, "noop");
  assert.equal(h.state.writes.length, count);
});

test("existing clean sections move without replacing IDs; exact leaf placeholder removed; notes and completion retained", async (t) => {
  const source = snapshot([
    block(1, "## Notes", [block(2, "PRIVATE handwritten note")]),
    block(3, "## Focus", [block(4, "What would make today successful?")]),
    block(5, "## Tasks", [block(6, "DONE user completion")]),
  ]);
  source.pages[0].blocks[0].collapsed = true;
  const h = harness(source, await planFor(t, source));
  const result = await h.writer.apply(h.input);
  assert.equal(result.status, "applied", result.reason);
  assertProjection(h);
  assert.ok(h.state.writes.some((op) => op.kind === "move"));
  assert.deepEqual(h.state.writes.filter((op) => op.kind === "remove").map((op) => op.uuid), [uuid(4)]);
  assert.equal(entries(h.state.tree).get(uuid(1)).block.collapsed, true);
  for (const id of [2, 6]) assert.ok(!h.state.writes.some((op) => op.uuid === uuid(id)));
});

test("interleaved user roots stay untouched while managed sections move around them", async (t) => {
  const source = snapshot([
    block(1, "## Notes"), block(2, "PRIVATE root A", [block(3, "PRIVATE child")]),
    block(4, "PRIVATE root B"), block(5, "## Tasks"), block(6, "## Focus"),
  ]);
  const h = harness(source, await planFor(t, source));
  const before = clone(source.pages[0].blocks.filter((b) => [uuid(2), uuid(4)].includes(b.uuid)));
  const result = await h.writer.apply(h.input);
  assert.equal(result.status, "applied", result.reason);
  assertProjection(h);
  assert.deepEqual(h.state.tree.filter((b) => [uuid(2), uuid(4)].includes(b.uuid)), before);
  assert.ok(!h.state.writes.some((op) => [uuid(2), uuid(3), uuid(4)].includes(op.uuid)));
  const writes = h.state.writes.length;
  assert.equal((await h.writer.apply(h.input)).status, "noop");
  assert.equal(h.state.writes.length, writes);
});

test("managed permutations preserve adjacent and separated user roots across anchor placements", async (t) => {
  const orders = [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]];
  for (const order of orders) for (const gap of [0, 1, 2, 3]) {
    const sections = [null, "## Notes", "## Tasks", "## Focus"];
    const roots = order.map((n) => block(n, sections[n]));
    roots.splice(gap, 0, block(10, "PRIVATE A"), block(11, "PRIVATE B", [block(12, "PRIVATE child")]));
    roots.push(block(13, "PRIVATE trailing root"));
    const source = snapshot(roots), h = harness(source, await planFor(t, source));
    const result = await h.writer.apply(h.input);
    assert.equal(result.status, "applied", `${order}, gap ${gap}: ${result.reason}`);
    assertProjection(h);
    assert.ok(!h.state.writes.some((op) => [10, 11, 12, 13].map(uuid).includes(op.uuid)));
  }
});

test("interleaved layout resumes after each committed operation without moving or duplicating user blocks", async (t) => {
  const source = snapshot([block(1, "## Notes"), block(2, "PRIVATE A"), block(3, "PRIVATE B"), block(4, "## Focus")]);
  const plan = await planFor(t, source), baseline = harness(source, plan);
  assert.equal((await baseline.writer.apply(baseline.input)).status, "applied");
  for (let at = 1; at <= baseline.state.writes.length; at++) {
    const h = harness(source, plan);
    h.state.afterWrite = () => { if (h.state.writes.length === at) throw new Error("PRIVATE lost reply"); };
    assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
    h.state.afterWrite = null;
    assert.equal((await h.makeWriter().apply(h.input)).status, "applied");
    assertProjection(h);
    assert.deepEqual(h.state.writes, baseline.state.writes);
    assert.ok(!h.state.writes.some((op) => [uuid(2), uuid(3)].includes(op.uuid)));
  }
});

test("unachievable user sibling reordering is rejected before reads, checkpoint saves or writes", async (t) => {
  for (const nested of [false, true]) {
    const users = [block(2, "PRIVATE A"), block(3, "PRIVATE B")];
    const source = snapshot(nested ? [block(1, "## Notes", users)] : users);
    const h = harness(source, await planFor(t, source));
    const tree = nested ? h.input.plan.nextJournal.blocks.find((b) => b.uuid === uuid(1)).children : h.input.plan.nextJournal.blocks;
    const a = tree.findIndex((b) => b.uuid === uuid(2)), b = tree.findIndex((b) => b.uuid === uuid(3));
    [tree[a], tree[b]] = [tree[b], tree[a]];
    const result = await h.writer.apply(h.input);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unsafe-order");
    assert.equal(h.state.reads, 0);
    assert.deepEqual(h.state.writes, []);
    assert.deepEqual(h.state.saves, []);
  }
});

test("removing a leaf placeholder does not require moving the user's following children", async (t) => {
  const source = snapshot([block(1, "## Focus", [
    block(2, "What would make today successful?"),
    block(3, "PRIVATE focus note", [block(4, "PRIVATE nested note")]), block(5, "DONE my task"),
  ])]);
  const h = harness(source, await planFor(t, source));
  const result = await h.writer.apply(h.input);
  assert.equal(result.status, "applied", result.reason);
  assertProjection(h);
  assert.deepEqual(h.state.writes.filter((op) => op.kind === "remove").map((op) => op.uuid), [uuid(2)]);
  assert.ok(!h.state.writes.some((op) => [uuid(3), uuid(4), uuid(5)].includes(op.uuid)));
});

test("historical owners remain read-only; canonical references reparent with retained UUIDs and stale leaves are removed", async (t) => {
  const ownerSource = snapshot([], 20250322);
  const ownerPlan = await planFor(t, ownerSource);
  const source = snapshot([], 20250323);
  source.pages.unshift(clone(ownerPlan.nextJournal));
  const initial = await planFor(t, source);
  source.pages[1] = clone(initial.nextJournal);
  const weeklyId = ownerPlan.sections["Weekly tasks"];
  const owner = entries(source.pages[0].blocks).get(weeklyId).block;
  const root = owner.children[0], nested = root.children[0];
  root.children = [];
  owner.children = [nested];
  nested.children = [root];
  const monthly = entries(source.pages[0].blocks).get(ownerPlan.sections["Monthly tasks"]).block;
  monthly.children = [];
  const beforeHistory = clone(source.pages[0]);
  const h = harness(source, await planFor(t, source));
  const refsBefore = [...entries(source.pages[1].blocks).values()].filter(({ block }) => blockProperty(block, "routine-reference"));
  const result = await h.writer.apply(h.input);
  assert.equal(result.status, "applied", result.reason);
  assertProjection(h);
  assert.ok(h.state.writes.some((op) => op.kind === "move" && op.options.children));
  assert.ok(h.state.writes.some((op) => op.kind === "remove"));
  assert.equal(h.state.writes.filter((op) => op.kind === "insert").length, 0);
  assert.ok(refsBefore.some(({ block }) => entries(h.state.tree).has(block.uuid)));
  assert.deepEqual(source.pages[0], beforeHistory);
  assert.ok(h.state.writes.every((op) => !entries(beforeHistory.blocks).has(op.uuid)));
});

for (const kind of ["move", "remove"]) {
  for (const committed of [false, true]) {
    test(`${kind} ${committed ? "lost reply after commit" : "rejected before commit"} is never blindly retried`, async (t) => {
      const source = snapshot([block(1, "## Notes"), block(2, "## Focus", [block(3, "TODO Choose one important task.")])]);
      const h = harness(source, await planFor(t, source));
      const hook = (operation) => { if (operation === kind) throw new Error("PRIVATE remote failure"); };
      if (committed) h.state.afterWrite = hook;
      else h.state.beforeWrite = hook;
      assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
      const failed = h.state.writes.at(-1), count = h.state.writes.length;
      assert.equal(failed.kind, kind);
      h.state.afterWrite = null;
      h.state.beforeWrite = null;
      const result = await h.makeWriter().apply(h.input);
      if (committed) {
        assert.equal(result.status, "applied", result.reason);
        assertProjection(h);
        assert.equal(h.state.writes.filter((op) => op.kind === kind && op.uuid === failed.uuid).length, 1);
      } else {
        assert.equal(result.reason, "uncertain-outcome");
        assert.equal(h.state.writes.length, count);
      }
    });
  }
}

test("future engine journal structure is supported but stale today-copy plan cannot publish future routines", async (t) => {
  const source = snapshot([], 20250322), plan = await planFor(t, source, 20250321);
  const h = harness(source, plan);
  h.state.today = 20250321;
  assert.equal((await h.writer.apply(h.input)).status, "applied");
  assertProjection(h);
  assert.ok(!h.state.writes.some((op) => op.content?.includes("routine-loaded::")));
  const stale = await clean(t);
  stale.state.today = 20250320;
  assert.equal((await stale.writer.apply(stale.input)).reason, "future-routine-write");
  assert.equal(stale.state.writes.length, 0);
});

for (const mode of ["disabled", "graph-switch", "midnight", "invalid-today", "calendar-rejection"]) {
  test(`fresh guard blocks ${mode} between operations`, async (t) => {
    const h = await clean(t);
    h.state.afterWrite = () => {
      if (mode === "disabled") h.state.enabled = false;
      if (mode === "graph-switch") h.state.graphKey = "different-graph";
      if (mode === "midnight") h.state.today = 20250322;
      if (mode === "invalid-today") h.state.today = 20250230;
      if (mode === "calendar-rejection") h.state.guardHook = () => { throw new Error("PRIVATE Calendar failure"); };
    };
    const result = await h.writer.apply(h.input);
    assert.equal(result.status, "blocked");
    assert.equal(result.recoveryRequired, true);
    assert.equal(h.state.writes.length, 1);
    assert.ok(h.state.record.pending);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  });
}

test("guard is checked again after durable prepare and final reread, before any SDK mutation", async (t) => {
  const h = await clean(t);
  h.state.guardHook = ({ phase }) => { if (phase === "write") h.state.enabled = false; };
  assert.equal((await h.writer.apply(h.input)).reason, "guard-denied");
  assert.equal(h.state.writes.length, 0);
  assert.ok(h.state.record.pending);
});

test("historical target is rejected even if authorization incorrectly allows it", async (t) => {
  const h = await clean(t);
  h.state.today = 20250322;
  assert.equal((await h.writer.apply(h.input)).reason, "historical-journal");
  assert.equal(h.state.writes.length, 0);
});

test("SDK rejection before applying stays uncertain and cannot duplicate retry", async (t) => {
  const h = await clean(t);
  h.state.beforeWrite = () => { throw new Error("PRIVATE failed remote path"); };
  assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
  h.state.beforeWrite = null;
  const retried = await h.makeWriter().apply(h.input);
  assert.equal(retried.reason, "uncertain-outcome");
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.tree.length, 0);
});

test("SDK applies then rejects: a new executor reconciles postcondition and continues without another insert", async (t) => {
  const h = await clean(t);
  h.state.afterWrite = () => { throw new Error("response lost after commit"); };
  assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
  const first = h.state.writes[0].uuid;
  h.state.afterWrite = null;
  const result = await h.makeWriter().apply(h.input);
  assert.equal(result.status, "applied", result.reason);
  assertProjection(h);
  assert.equal(h.state.writes.filter((op) => op.uuid === first && op.kind === "insert").length, 1);
});

test("timeout before commit halts; late completion is reconciled instead of retried", async (t) => {
  const h = await clean(t, { timeoutMs: 30 });
  let release;
  h.state.beforeWrite = () => new Promise((resolve) => { release = resolve; });
  assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
  assert.equal((await h.makeWriter().apply(h.input)).reason, "uncertain-outcome");
  assert.equal(h.state.writes.length, 1);
  h.state.beforeWrite = null;
  release();
  await nextTurn();
  const result = await h.makeWriter().apply(h.input);
  assert.equal(result.status, "applied", result.reason);
  assertProjection(h);
});

test("crash after each individual clean-output operation can reconcile without duplicate tasks or false loaded owners", async (t) => {
  const baseline = await clean(t);
  assert.equal((await baseline.writer.apply(baseline.input)).status, "applied");
  for (let failure = 1; failure <= baseline.state.writes.length; failure++) {
    const h = await clean(t);
    h.state.afterWrite = () => { if (h.state.writes.length === failure) throw new Error("simulated lost reply/crash"); };
    assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
    for (const { block: owner } of entries(h.state.tree).values()) {
      if (!blockProperty(owner, "routine-loaded")) continue;
      const expected = entries(h.input.plan.nextJournal.blocks).get(owner.uuid).block;
      assert.deepEqual(bare(owner.children), bare(expected.children));
    }
    h.state.afterWrite = null;
    assert.equal((await h.makeWriter().apply(h.input)).status, "applied");
    assertProjection(h);
    assert.equal(h.state.writes.length, baseline.state.writes.length);
  }
});

test("interrupted confirmed progress resumes exact plan; regenerated UUID plan and other target jobs are blocked", async (t) => {
  const h = await clean(t);
  h.state.guardHook = ({ phase }) => {
    if (phase === "precondition" && h.state.writes.length === 2) h.state.enabled = false;
  };
  assert.equal((await h.writer.apply(h.input)).reason, "guard-denied");
  assert.equal(h.state.record.cursor, 2);
  assert.equal(h.state.record.pending, null);
  h.state.enabled = true;
  h.state.guardHook = null;
  const changed = clone(h.input);
  const originalId = changed.plan.nextJournal.blocks[0].uuid;
  changed.plan.nextJournal.blocks[0].uuid = uuid(99999);
  changed.plan.dateHeading = uuid(99999);
  assert.notEqual(originalId, changed.plan.dateHeading);
  assert.equal((await h.makeWriter().apply(changed)).reason, "recovery-plan-required");
  const other = { ...h.input, pageUuid: uuid(99998) };
  assert.equal((await h.makeWriter().apply(other)).reason, "recovery-plan-required");
  assert.equal((await h.makeWriter().apply(h.input)).status, "applied");
  assertProjection(h);
});

test("concurrent note edit is not overwritten and blocks remaining work and recovery", async (t) => {
  const h = await clean(t);
  h.state.afterWrite = () => { h.state.tree[0].content += "\nPRIVATE concurrent note"; };
  assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
  h.state.afterWrite = null;
  assert.equal((await h.makeWriter().apply(h.input)).reason, "uncertain-outcome");
  assert.equal(h.state.writes.length, 1);
  assert.match(h.state.tree[0].content, /concurrent note/);
});

test("reread catches changes after durable intent before mutation", async (t) => {
  const h = await clean(t);
  h.state.saveHook = (record) => { if (record?.pending) h.state.tree.push(block(777, "PRIVATE new note")); };
  assert.equal((await h.writer.apply(h.input)).reason, "precondition-conflict");
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.state.tree[0].content, "PRIVATE new note");
});

for (const mode of ["initial-content", "page-day", "page-uuid", "page-name", "read-reject", "tuple", "metadata-only", "foreign-membership"]) {
  test(`reread preconditions reject ${mode} without writes`, async (t) => {
    const h = await clean(t);
    if (mode === "initial-content") h.state.tree.push(block(777, "unexpected user note"));
    if (mode === "page-day") h.page.journalDay = 20250320;
    if (mode === "page-uuid") h.page.uuid = uuid(888);
    if (mode === "page-name") h.page.name = "renamed";
    if (mode === "read-reject") h.state.beforeRead = () => { throw new Error("PRIVATE read failure"); };
    if (mode === "tuple") h.state.tree.push(["uuid", uuid(777)]);
    if (mode === "metadata-only") h.state.tree.push({ ...block(777, "text"), properties: { routineLoaded: "weekly-20250315" } });
    if (mode === "foreign-membership") h.state.tree.push({ ...block(777, "text"), page: { id: 2 } });
    const result = await h.writer.apply(h.input);
    assert.equal(result.status, "blocked");
    assert.equal(h.state.writes.length, 0);
    assert.equal(h.state.record, null);
  });
}

test("new UUID already present elsewhere blocks insertion; undefined getBlock is not absence", async (t) => {
  for (const undefinedResult of [false, true]) {
    const h = await clean(t), first = h.input.plan.nextJournal.blocks[0];
    if (undefinedResult) h.sdk.Editor.getBlock = async () => undefined;
    else h.state.foreign.set(first.uuid, clone(first));
    assert.equal((await h.writer.apply(h.input)).reason, "uuid-collision");
    assert.equal(h.state.writes.length, 0);
  }
});

test("SDK successful return without actual write is uncertain, not permission to continue", async (t) => {
  const h = await clean(t);
  h.sdk.Editor.insertBlock = async () => null;
  assert.equal((await h.writer.apply(h.input)).reason, "uncertain-outcome");
  assert.equal((await h.makeWriter().apply(h.input)).reason, "uncertain-outcome");
  assert.equal(h.state.tree.length, 0);
});

test("SDK return shape is ignored if reread confirms the actual mutation", async (t) => {
  const h = await clean(t), insert = h.sdk.Editor.insertBlock;
  h.sdk.Editor.insertBlock = async (...args) => { await insert(...args); return null; };
  assert.equal((await h.writer.apply(h.input)).status, "applied");
  assertProjection(h);
});

test("durable records contain only small metadata and hashes, never task bodies or snapshots", async (t) => {
  const h = await clean(t);
  assert.equal((await h.writer.apply(h.input)).status, "applied");
  for (const record of h.state.saves.filter(Boolean)) {
    const text = JSON.stringify(record);
    assert.ok(text.length < 700);
    for (const secret of ["private weekly", "DONE nested", "private monthly", "blocks", "content", "nextJournal", "snapshot"]) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.match(record.planHash, /^[0-9a-f]{64}$/);
    assert.match(record.stateHash, /^[0-9a-f]{64}$/);
  }
});

test("storage load/save failures cannot fall through to graph writes and latch uncertain saves", async (t) => {
  const h = await clean(t);
  const badLoad = h.makeWriter({ recoveryStore: { ...h.recoveryStore, load: async () => { throw new Error("PRIVATE storage path"); } } });
  assert.equal((await badLoad.apply(h.input)).reason, "recovery-store-failed");
  h.state.saveHook = () => { throw new Error("PRIVATE storage full"); };
  assert.equal((await h.writer.apply(h.input)).reason, "recovery-store-failed");
  h.state.saveHook = null;
  assert.equal((await h.writer.apply(h.input)).reason, "recovery-store-uncertain");
  assert.equal(h.state.writes.length, 0);
});

test("ack persistence failure after write retains pending intent; new writer reconciles verified content", async (t) => {
  const h = await clean(t);
  h.state.saveHook = (record) => { if (record && !record.pending) throw new Error("ack persistence failed"); };
  assert.equal((await h.writer.apply(h.input)).reason, "recovery-store-failed");
  assert.equal(h.state.writes.length, 1);
  assert.ok(h.state.record.pending);
  h.state.saveHook = null;
  assert.equal((await h.makeWriter().apply(h.input)).status, "applied");
  assertProjection(h);
});

test("clear failure after all writes leaves completed receipt and replay only clears after verification", async (t) => {
  const h = await clean(t);
  h.state.saveHook = (record) => { if (record === null) throw new Error("clear failed"); };
  assert.equal((await h.writer.apply(h.input)).reason, "recovery-store-failed");
  assertProjection(h);
  assert.equal(h.state.record.pending, null);
  const count = h.state.writes.length;
  h.state.saveHook = null;
  assert.equal((await h.makeWriter().apply(h.input)).status, "applied");
  assert.equal(h.state.writes.length, count);
  assert.equal(h.state.record, null);
});

test("busy caller is rejected; caller mutation after apply cannot change captured plan", async (t) => {
  const h = await clean(t);
  let release, reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  h.state.guardHook = async ({ phase }) => { if (phase === "start") { reached(); await new Promise((resolve) => { release = resolve; }); } };
  const running = h.writer.apply(h.input);
  await arrived;
  assert.equal((await h.writer.apply(h.input)).reason, "busy");
  const desired = clone(h.input.plan.nextJournal.blocks);
  h.input.plan.nextJournal.blocks[0].content = "PRIVATE caller changed projection";
  release();
  assert.equal((await running).status, "applied");
  assert.deepEqual(bare(h.state.tree), bare(desired));
});

test("unsafe custom deletion/update or move fails compilation before any partial writes", async (t) => {
  for (const mode of ["delete", "update", "move"]) {
    const source = snapshot([block(1, "PRIVATE custom root", [block(2, "user child")])]);
    const h = harness(source, await planFor(t, source));
    const tree = h.input.plan.nextJournal.blocks;
    const custom = tree.find((item) => item.uuid === uuid(1));
    if (mode === "delete") tree.splice(tree.indexOf(custom), 1);
    if (mode === "update") custom.content = "not authorized by engine";
    if (mode === "move") { tree.splice(tree.indexOf(custom), 1); tree[0].children.push(custom); }
    assert.equal((await h.writer.apply(h.input)).status, "blocked");
    assert.equal(h.state.writes.length, 0);
    assert.equal(h.state.record, null);
  }
});

test("invalid plan, incomplete collection, mismatched identity and operation budget fail closed", async (t) => {
  for (const change of [
    (input) => { input.plan.status = "blocked"; },
    (input) => { input.snapshot.ownerScanComplete = false; },
    (input) => { input.plan.graphId = "other-scan"; },
    (input) => { input.plan.before.blocks.push(block(1, "invented before")); },
    (input) => { input.plan.nextJournal.name = "another page"; },
    (input) => { input.plan.nextJournal.blocks[0].uuid = uuid(100); },
  ]) {
    const h = await clean(t);
    change(h.input);
    assert.equal((await h.writer.apply(h.input)).status, "blocked");
    assert.equal(h.state.writes.length, 0);
  }
  const h = await clean(t, { maxOperations: 1 });
  assert.equal((await h.writer.apply(h.input)).reason, "operation-limit");
  assert.equal(h.state.writes.length, 0);
});
