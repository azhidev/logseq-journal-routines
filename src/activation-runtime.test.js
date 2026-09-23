import assert from "node:assert/strict";
import test from "node:test";
import { createActivationRuntime } from "./activation-runtime.js";
import { graphIdentity } from "./activation-storage.js";
import { blockProperty } from "./journal-model.js";

const id = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
const clone = (value) => structuredClone(value);
const APPROVALS = { backupConfirmed: true, legacyAutomationDisabled: true, liveSafetyAcknowledged: true };
const A = "journal-routines:activation:v1:", R = "journal-routines:writer:v1:";
const INFO = { id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"] };
function description(day) {
  const pd = day - 20250320;
  return {
    gregorian: { year: 2025, month: 3, day: day % 100, iso: `2025-03-${day % 100}`, journalDay: day },
    persian: { year: 1404, month: 1, day: pd, iso: `1404-01-0${pd}`, label: `تاریخ ${pd}`, weekOfYear: pd === 1 ? 1 : 2 },
    week: pd === 1 ? { start: "2025-03-15", end: "2025-03-21", key: "weekly-20250315" } :
      { start: "2025-03-22", end: "2025-03-28", key: "weekly-20250322" },
    month: { start: "2025-03-21", end: "2025-04-20", key: "monthly-1404-01", financeKey: "1404-01" },
  };
}
function properties(content) {
  const result = Object.fromEntries(content.split("\n").flatMap((line) => {
    const match = /^([^\s:]+)::\s*(.*)$/.exec(line);
    return match ? [[match[1], match[2] === "false" ? false : match[2]]] : [];
  }));
  const heading = /^(#{1,6})\s/.exec(content);
  if (heading) result.heading = heading[1].length;
  return result;
}
function fixture(t, options = {}) {
  let next = 10, timerId = 0;
  const pages = [], data = new Map(), timers = new Map(), hooks = { graph: new Set(), db: new Set(), route: new Set() };
  const f = { pages, data, timers, hooks, day: 20250321, time: new Date("2025-03-21T10:00:00Z").getTime(),
    graph: { name: "PRIVATE name", path: "/PRIVATE/graph" }, config: "daily-default", provider: true,
    current: null, writes: [], scans: 0, shows: 0, held: false, lockCalls: 0, closed: false,
    sidebar: [], beforeMutation: null, afterMutation: null, onRead: null, queryExtra: [], callbacks: null };
  const listen = (name) => (fn) => { hooks[name].add(fn); return () => hooks[name].delete(fn); };
  function block(content, children = [], uuid = id(next++)) { return { uuid, content, properties: properties(content), children }; }
  function page(name, day, blocks = []) {
    const n = next++;
    const p = { id: n, uuid: id(n), name: name.toLowerCase(), "journal?": day !== undefined, format: "markdown", properties: {}, blocks,
      ...(day === undefined ? {} : { journalDay: day }) };
    pages.push(p); return p;
  }
  function findPage(ref) { return pages.find((p) => typeof ref === "string" ? p.name === ref.toLowerCase() || p.uuid === ref.toLowerCase() : p.uuid === ref.uuid) ?? null; }
  function entries() {
    const rows = [];
    function visit(list, page) { list.forEach((b, index) => { rows.push({ block: b, list, index, page }); visit(b.children, page); }); }
    for (const p of pages) visit(p.blocks, p);
    return rows;
  }
  const locate = (uuid) => entries().find((row) => row.block.uuid === uuid);
  const templates = () => entries().filter(({ block }) => block.properties.template).map(({ block }) => block);
  const meta = (p) => { if (!p) return null; const { blocks, ...rest } = p; return clone(rest); };
  async function mutation(kind, perform) {
    assert.equal(f.held, true, "entire setup/writer call must hold the cross-window lock");
    await f.beforeMutation?.(kind);
    f.writes.push(kind);
    const result = perform();
    for (const fn of hooks.db) fn({});
    await f.afterMutation?.(kind);
    return clone(result);
  }
  const sdk = {
    App: {
      getCurrentGraph: async () => clone(f.graph),
      getUserConfigs: async () => ({ preferredFormat: "markdown", enabledJournals: true }),
      getCurrentGraphConfigs: async (...args) => {
        if (args.length === 1) { assert.equal(args[0], "default-templates"); return { other: "keep", ...(f.config === null ? {} : { journals: f.config }) }; }
        assert.deepEqual(args, ["default-templates", "journals"]); return f.config;
      },
      getTemplate: async () => clone(templates().find((b) => b.properties.template === "daily-default") ?? null),
      onCurrentGraphChanged: listen("graph"), onRouteChanged: listen("route"),
      registerUIItem: (type, item) => { assert.equal(type, "toolbar"); f.toolbar = item; },
      registerCommandPalette: (item, fn) => { f.command = fn; f.commandItem = item; },
      invokeExternalPlugin: async (target, arg) => {
        if (!f.provider) throw new Error("PRIVATE path and note body");
        if (target.endsWith("getApiInfo")) return clone(INFO);
        if (target.endsWith("describeToday")) return description(f.day);
        if (target.endsWith("fromJournalDay")) return description(arg).gregorian.iso;
        if (target.endsWith("describeDate")) return description(Number(arg.replaceAll("-", "")));
        assert.fail("unexpected Calendar method");
      },
    },
    DB: {
      onChanged: listen("db"),
      datascriptQuery: async (query) => {
        await f.onRead?.("query");
        if (query.includes(":template")) return templates().map((b) => [b.uuid, b.properties.template]);
        if (query.includes(":block/journal-day")) {
          const day = Number(/:block\/journal-day (\d{8})/.exec(query)[1]);
          // Desktop can store journal-day on ordinary blocks as well as pages.
          const entities = [...pages, ...entries().map(({ block, page }) => ({ ...block, journalDay: page.journalDay }))];
          return entities.filter((entity) => entity.journalDay === day &&
            (!query.includes("[?p :block/name]") || typeof entity.name === "string")).map((entity) => [entity.uuid]);
        }
        assert.ok(query.includes(":routine-loaded"));
        return [...entries().filter(({ block: b }) => b.properties["routine-loaded"])
          .map(({ block: b, page: p }) => [b.uuid, p.name, b.properties["routine-loaded"]]), ...f.queryExtra];
      },
    },
    Editor: {
      getAllPages: async () => { f.scans++; return pages.map(meta); },
      getPage: async (ref) => { assert.equal(typeof ref, "string"); await f.onRead?.("page", ref); return meta(findPage(ref)); },
      getCurrentPage: async () => meta(f.current),
      getPageBlocksTree: async (ref) => { assert.equal(typeof ref, "string", "Desktop 0.10.15 requires a string page identity"); await f.onRead?.("tree", ref); return clone(findPage(ref)?.blocks ?? null); },
      getBlock: async (uuid) => clone(locate(uuid)?.block ?? null),
      createPage: async (name, props, opts) => mutation("createPage", () => {
        assert.equal(opts.journal, false);
        assert.equal(opts.redirect, false);
        const p = findPage(name) ?? page(name, undefined, [block(`journal-routines-setup:: ${props["journal-routines-setup"]}`)]);
        p.properties = clone(props); return meta(p);
      }),
      insertBlock: async (anchor, content, opts) => mutation("insertBlock", () => {
        assert.equal(locate(opts.customUUID), undefined);
        const b = block(content, [], opts.customUUID), at = locate(anchor);
        const p = typeof anchor === "string" ? findPage(anchor) ?? findPage({ uuid: anchor }) : null;
        if (opts.sibling) {
          assert.ok(at); at.list.splice(at.index + (opts.before ? 0 : 1), 0, b);
        } else if (p) p.blocks.push(b);
        else { assert.ok(at); at.block.children.unshift(b); }
        return b;
      }),
      updateBlock: async (uuid, content) => mutation("updateBlock", () => {
        const b = locate(uuid).block; b.content = content; b.properties = properties(content);
      }),
      moveBlock: async (uuid, target, opts) => mutation("moveBlock", () => {
        const from = locate(uuid); from.list.splice(from.index, 1); const at = locate(target);
        if (opts.children) at.block.children.unshift(from.block);
        else at.list.splice(at.index + (opts.before ? 0 : 1), 0, from.block);
      }),
      removeBlock: async (uuid) => mutation("removeBlock", () => { const at = locate(uuid); at.list.splice(at.index, 1); }),
      openInRightSidebar: async (uuid) => { f.sidebar.push(uuid); },
    },
    provideModel: (model) => { f.model = model; },
    setMainUIInlineStyle: () => {}, showMainUI: () => { f.shows++; }, hideMainUI: () => {},
  };
  const storage = {
    get: async (key) => clone(data.get(key) ?? null),
    set: async (key, value) => { data.set(key, clone(value)); },
    close: () => { f.closed = true; },
  };
  const locks = { request: async (name, opts, fn) => {
    assert.match(name, /^journal-routines:write:v1:[a-f0-9]{64}$/);
    assert.deepEqual(opts, { mode: "exclusive", ifAvailable: true });
    f.lockCalls++;
    if (f.held) return fn(null);
    f.held = true;
    try { return await fn({ name }); } finally { f.held = false; }
  } };
  const document = new EventTarget(); document.defaultView = new EventTarget(); document.visibilityState = "visible";
  const runtimeOptions = { sdk, storage, locks, document, now: () => f.time,
    setTimer: (fn, ms) => { const n = ++timerId; timers.set(n, { fn, ms }); return n; }, clearTimer: (n) => timers.delete(n),
    mount: (_document, callbacks) => { f.callbacks = callbacks; return { render: (s) => { f.rendered = s; }, focus() {}, destroy: () => { f.viewDestroyed = true; } }; },
    ...options };
  const runtime = createActivationRuntime(runtimeOptions);
  Object.assign(f, { runtime, sdk, storage, locks, document, runtimeOptions, block, page, entries, templates,
    native: page("native today", f.day),
    async reviewAndEnable() { await runtime.open(); await runtime.enable(APPROVALS); },
    async tick() {
      const timer = [...timers.entries()].find(([, value]) => value.ms === 750);
      if (timer) { timers.delete(timer[0]); timer[1].fn(); }
      await runtime.whenIdle();
    },
    async advance() { f.time += 60_001; for (const fn of hooks.route) fn({}); await f.tick(); },
    emit(name) { for (const fn of [...hooks[name]]) fn({}); },
  });
  t.after(async () => { runtime.destroy(); await runtime.whenIdle(); });
  return f;
}
function reason(f, expected) { assert.equal(f.runtime.getStatus().reason, expected, JSON.stringify(f.runtime.getStatus())); }
function enabled(f) { assert.equal(f.runtime.getStatus().status, "enabled", JSON.stringify(f.runtime.getStatus())); }

// These fixtures exercise the real setup service, adapter, Calendar client,
// writer, engine and sidebar. Only host/UI/storage/clock boundaries are mocked.
test("setup -> three approvals -> real narrow writes -> persistent Enable; startup never opens preview", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  assert.equal(f.shows, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.runtime.getStatus().status, "setup-required");
  assert.ok(f.toolbar.template.includes("openJournalActivation"));
  assert.deepEqual(Object.keys(f.callbacks).sort(), ["onClose", "onDisable", "onEnable", "onInspect", "onSidebar"]);
  await f.command();
  assert.equal(f.runtime.getStatus().canEnable, true);
  await f.callbacks.onEnable(APPROVALS);
  enabled(f);
  assert.equal(f.pages.filter((p) => !p["journal?"]).length, 3);
  assert.equal(f.templates().length, 1);
  assert.equal(f.native.blocks.filter((b) => blockProperty(b, "routine-loaded")).length, 2);
  assert.equal(f.sidebar.length, 2);
  const key = (await graphIdentity(f.sdk)).key;
  assert.deepEqual(f.data.get(A + key), { version: 1, configured: true, enabled: true, approved: true, sidebar: true });
  assert.equal(f.data.get(R + key), null);
  assert.ok(!JSON.stringify([...f.data]).includes("PRIVATE"));
  assert.ok(!JSON.stringify([...f.data]).includes("TODO"));
  const count = f.writes.length, scans = f.scans;
  await f.runtime.refresh(); await f.advance();
  assert.equal(f.writes.length, count); assert.equal(f.scans, scans, "unchanged events use targeted evidence, not full scans");
});

test("verified config setter selects only the journal default during approved setup", async (t) => {
  const f = fixture(t); f.config = null;
  f.sdk.App.setCurrentGraphConfigs = async (value) => {
    assert.equal(f.held, true);
    assert.deepEqual(value, { "default-templates": { other: "keep", journals: "daily-default" } });
    f.config = value["default-templates"].journals;
    f.writes.push("setCurrentGraphConfigs");
  };
  await f.runtime.start(); await f.runtime.open();
  assert.equal(f.runtime.getStatus().summary.configuration, "selection-on-enable");
  await f.runtime.enable(APPROVALS); enabled(f);
  assert.equal(f.runtime.getStatus().summary.configuration, "daily-default");
  assert.deepEqual(f.runtime.getStatus().summary.changes, []);
  assert.equal(f.writes.filter((kind) => kind === "setCurrentGraphConfigs").length, 1);
  await f.runtime.refresh();
  assert.equal(f.writes.filter((kind) => kind === "setCurrentGraphConfigs").length, 1);
});

test("uncertain configuration is not retried blindly", async (t) => {
  const f = fixture(t); f.config = null; let attempts = 0;
  f.sdk.App.setCurrentGraphConfigs = async () => { attempts++; throw new Error("private"); };
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "configuration-uncertain");
  f.time += 60_001;
  await f.reviewAndEnable(); reason(f, "configuration-uncertain");
  assert.equal(attempts, 1); assert.equal(f.native.blocks.length, 0);
});

test("manual-selection-required applies approved resources but does not enable or invent a setter", async (t) => {
  const f = fixture(t); f.config = null;
  await f.runtime.start(); await f.reviewAndEnable();
  reason(f, "configuration-required");
  assert.equal(f.templates().length, 1);
  assert.equal(f.native.blocks.length, 0);
  const count = f.writes.length;
  f.config = "daily-default"; f.time += 60_001;
  await f.reviewAndEnable(); enabled(f);
  assert.equal(f.writes.filter((kind) => kind === "createPage").length, 3);
  assert.ok(f.writes.length > count);
});

for (const missing of Object.keys(APPROVALS)) test(`missing ${missing} cannot authorize setup`, async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.runtime.open();
  await f.runtime.enable({ ...APPROVALS, [missing]: false });
  reason(f, "approval-required"); assert.equal(f.writes.length, 0);
});

test("no Web Locks fails closed; no setup or writer mutations", async (t) => {
  const f = fixture(t, { locks: null }); await f.runtime.start(); await f.reviewAndEnable();
  reason(f, "locks-unavailable"); assert.equal(f.writes.length, 0);
});

test("Disable cancels work, removes automatic listeners/timers and persists off across restart", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  await f.runtime.disable();
  assert.equal(f.runtime.getStatus().status, "disabled");
  assert.equal(f.hooks.db.size, 0); assert.equal(f.hooks.route.size, 0); assert.equal(f.timers.size, 0);
  const count = f.writes.length;
  f.runtime.destroy(); await f.runtime.whenIdle();
  const restarted = createActivationRuntime(f.runtimeOptions); t.after(() => restarted.destroy());
  await restarted.start();
  assert.equal(restarted.getStatus().status, "disabled"); assert.equal(f.writes.length, count);
  assert.equal(f.shows, 1, "reload must not show UI");
});

test("enabled reload validates fresh Calendar and resumes without repeated approval or modal", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  const count = f.writes.length;
  f.runtime.destroy(); await f.runtime.whenIdle();
  const restarted = createActivationRuntime(f.runtimeOptions); t.after(() => restarted.destroy());
  await restarted.start(); assert.equal(restarted.getStatus().status, "enabled", JSON.stringify(restarted.getStatus()));
  assert.equal(f.writes.length, count); assert.equal(f.shows, 1);
});

test("dependency loss is sanitized, preserves intent and recovers through automatic retry", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  f.provider = false; await f.advance(); reason(f, "calendar-unavailable");
  const key = (await graphIdentity(f.sdk)).key;
  assert.equal(f.data.get(A + key).enabled, true);
  assert.ok(!JSON.stringify(f.runtime.getStatus()).includes("PRIVATE"));
  f.provider = true; await f.advance(); enabled(f);
});

test("graph path, not duplicate display name, scopes authorization; graph switch invalidates reviewed token", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.runtime.open();
  f.graph.path = "/PRIVATE/other"; f.emit("graph");
  await f.runtime.enable(APPROVALS); await f.runtime.whenIdle();
  assert.equal(f.writes.length, 0);
  assert.equal(f.runtime.getStatus().configured, false);
});

test("waiting for native creation never fabricates a journal page", async (t) => {
  const f = fixture(t); f.pages.splice(f.pages.indexOf(f.native), 1);
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "waiting-native-journal");
  assert.equal(f.pages.filter((p) => p["journal?"]).length, 0);
  f.native = f.page("host supplied name", f.day);
  await f.advance(); enabled(f); assert.ok(f.native.blocks.length > 0);
});

test("fresh indexed conflicting owner claims stop setup, including non-journal claims", async (t) => {
  const f = fixture(t); f.queryExtra = [[id(9000), "ordinary notes", "weekly-20250315"]];
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "source-changed");
  assert.equal(f.writes.length, 0);
});

test("continued routine/source evidence is checked after each writer mutation, not only discovery", async (t) => {
  const f = fixture(t); await f.runtime.start();
  f.afterMutation = () => {
    if (!f.native.blocks.length) return;
    const routine = f.pages.find((p) => p.name === "week routine");
    routine.blocks.push(f.block("PRIVATE concurrent task")); f.afterMutation = null;
  };
  await f.reviewAndEnable(); reason(f, "writer-guard-denied");
  assert.equal(f.native.blocks.length, 1, "no second operation after source edit");
  const key = (await graphIdentity(f.sdk)).key;
  assert.ok(f.data.get(R + key)?.pending);
});

test("historical owner tree changes during a write stop it without writing history", async (t) => {
  const f = fixture(t);
  const owner = f.block("## Weekly tasks\nroutine-loaded:: weekly-20250315\nroutine-section:: [[Routine Weekly Section]]", [f.block("DONE shared")]);
  const history = f.page("historical owner", 20250320, [owner]);
  await f.runtime.start();
  f.afterMutation = () => {
    if (!f.native.blocks.length) return;
    owner.children[0].content = "DONE user edit"; f.afterMutation = null;
  };
  await f.reviewAndEnable(); reason(f, "writer-guard-denied");
  assert.equal(f.native.blocks.length, 1);
  assert.equal(history.blocks[0], owner);
});

test("same-session uncertain completion resumes original identities; restart without plan blocks and retains checkpoint", async (t) => {
  const f = fixture(t); await f.runtime.start();
  f.afterMutation = () => {
    if (!f.native.blocks.length) return;
    f.afterMutation = null; throw new Error("PRIVATE remote rejection after success");
  };
  await f.reviewAndEnable(); reason(f, "writer-uncertain-outcome");
  const first = f.native.blocks[0].uuid;
  await f.runtime.refresh(); enabled(f);
  assert.equal(f.native.blocks[0].uuid, first);
  const key = (await graphIdentity(f.sdk)).key;
  const checkpoint = { version: 1, pageUuid: f.native.uuid, pending: { uuid: first } };
  f.data.set(R + key, clone(checkpoint));
  f.runtime.destroy(); await f.runtime.whenIdle();
  const restarted = createActivationRuntime(f.runtimeOptions); t.after(() => restarted.destroy());
  const writes = f.writes.length;
  await restarted.start();
  assert.equal(restarted.getStatus().reason, "recovery-plan-required");
  assert.deepEqual(f.data.get(R + key), checkpoint); assert.equal(f.writes.length, writes);
});

test("Disable during an issued writer call prevents further mutations and retains uncertain recovery", async (t) => {
  const f = fixture(t); await f.runtime.start();
  let disable;
  f.afterMutation = () => {
    if (!f.native.blocks.length) return;
    f.afterMutation = null; disable = f.runtime.disable();
  };
  await f.reviewAndEnable(); await disable; await f.runtime.whenIdle();
  assert.equal(f.runtime.getStatus().status, "disabled"); assert.equal(f.native.blocks.length, 1);
  const key = (await graphIdentity(f.sdk)).key;
  assert.equal(f.data.get(A + key).enabled, false); assert.ok(f.data.get(R + key));
});

test("today plus visited future journal receive work, never a visited past journal", async (t) => {
  const f = fixture(t); const past = f.page("past", 20250319), future = f.page("future", 20250322);
  f.current = future;
  await f.runtime.start(); await f.reviewAndEnable();
  // Discovery of the second target is throttled, then serviced on retry.
  await f.advance(); enabled(f);
  assert.ok(future.blocks.length > 0);
  assert.equal(future.blocks.some((b) => blockProperty(b, "routine-loaded")), false);
  assert.equal(future.blocks.some((b) => blockProperty(b, "routine-reference")), false);
  f.current = past; await f.advance(); enabled(f); assert.deepEqual(past.blocks, []);
});

test("DB storms coalesce; unchanged own-write events do not repeat exhaustive scans", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  const scans = f.scans, writes = f.writes.length;
  for (let n = 0; n < 100; n++) f.emit("db");
  assert.equal([...f.timers.values()].filter((timer) => timer.ms === 750).length, 1);
  await f.tick();
  assert.equal(f.scans, scans); assert.equal(f.writes.length, writes);
  await f.runtime.setSidebar(false);
  const key = (await graphIdentity(f.sdk)).key; assert.equal(f.data.get(A + key).sidebar, false);
  f.runtime.destroy(); await f.runtime.whenIdle();
  assert.equal(f.hooks.graph.size + f.hooks.db.size + f.hooks.route.size, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.viewDestroyed, true); assert.equal(f.closed, true);
});

test("double Enable shares one serialized operation and does not repeat additions", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.runtime.open();
  const first = f.runtime.enable(APPROVALS), second = f.runtime.enable(APPROVALS);
  assert.equal(first, second); await first; enabled(f);
  assert.equal(f.lockCalls, 1); assert.equal(f.writes.filter((kind) => kind === "createPage").length, 3);
});

test("missing native journal polling uses its indexed date, not exhaustive inventories", async (t) => {
  const f = fixture(t); f.pages.splice(f.pages.indexOf(f.native), 1);
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "waiting-native-journal");
  const scans = f.scans;
  for (let n = 0; n < 4; n++) { await f.advance(); reason(f, "waiting-native-journal"); }
  assert.equal(f.scans, scans);
  const future = f.page("future native", 20250322); f.current = future;
  await f.advance(); reason(f, "waiting-native-journal");
  assert.ok(future.blocks.length > 0, "future navigation still works while today's native creation is pending");
});

test("a mid-write Calendar day change stops before the next operation", async (t) => {
  const f = fixture(t); await f.runtime.start();
  f.afterMutation = () => { if (f.native.blocks.length) { f.day = 20250322; f.afterMutation = null; } };
  await f.reviewAndEnable(); reason(f, "writer-guard-denied");
  assert.equal(f.native.blocks.length, 1);
  await f.advance(); reason(f, "date-changed");
  assert.equal(f.native.blocks.length, 1, "recovery cannot write yesterday even with original plan");
});

test("a mid-write new indexed owner claim stops without target self-invalidation", async (t) => {
  const f = fixture(t); await f.runtime.start();
  f.afterMutation = () => {
    if (f.native.blocks.length) { f.queryExtra = [[id(9999), "other page", "monthly-1404-01"]]; f.afterMutation = null; }
  };
  await f.reviewAndEnable(); reason(f, "writer-guard-denied"); assert.equal(f.native.blocks.length, 1);
});

test("Disable during setup cancels further additions and cannot silently enable", async (t) => {
  const f = fixture(t); await f.runtime.start(); let disabling;
  f.afterMutation = () => { f.afterMutation = null; disabling = f.runtime.disable(); };
  await f.reviewAndEnable(); await disabling;
  assert.equal(f.writes.length, 1);
  const key = (await graphIdentity(f.sdk)).key;
  assert.equal(f.data.get(A + key).enabled, false);
  assert.equal(f.native.blocks.length, 0);
});

test("storage failures are sanitized and fail closed", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.runtime.open();
  f.storage.set = async () => { throw new Error("PRIVATE storage details"); };
  await f.runtime.enable(APPROVALS);
  assert.equal(f.writes.length, 0); assert.ok(!JSON.stringify(f.runtime.getStatus()).includes("PRIVATE"));
});

test("failed Disable persistence cannot be undone by Refresh in the same session", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  const save = f.storage.set, writes = f.writes.length;
  f.storage.set = async () => { throw new Error("PRIVATE storage failed"); };
  await f.runtime.disable(); reason(f, "storage-unavailable");
  await f.runtime.refresh(); reason(f, "disable-not-persisted");
  assert.equal(f.writes.length, writes); assert.equal(f.hooks.db.size, 0);
  f.storage.set = save; await f.runtime.disable();
  const key = (await graphIdentity(f.sdk)).key; assert.equal(f.data.get(A + key).enabled, false);
});

test("malformed indexed evidence cannot be treated as an empty owner index", async (t) => {
  const f = fixture(t); f.queryExtra = [[id(999), "private page", { unexpected: true }]];
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "owner-period-shape");
  assert.equal(f.writes.length, 0);
});

test("cross-window lock contention pauses without writes, then retries fresh", async (t) => {
  const f = fixture(t); await f.runtime.start(); f.held = true;
  await f.reviewAndEnable(); reason(f, "lock-busy"); assert.equal(f.writes.length, 0);
  f.held = false; await f.reviewAndEnable(); enabled(f);
});

test("empty existing routine pages are preserved, not seeded, and reported", async (t) => {
  const f = fixture(t); const week = f.page("Week Routine"), month = f.page("Month Routine");
  await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  assert.deepEqual(week.blocks, []); assert.deepEqual(month.blocks, []);
  assert.match(f.runtime.getStatus().message, /routine definition is empty/);
  assert.equal(f.native.blocks.some((b) => blockProperty(b, "routine-loaded")), false);
});

test("resume and local-midnight triggers use Calendar's new day, preserve yesterday and share monthly owner tasks", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  const yesterday = clone(f.native.blocks), monthly = f.native.blocks.find((b) => blockProperty(b, "routine-loaded") === "monthly-1404-01");
  f.day = 20250322; f.time += 86_400_000; const next = f.page("new native day", f.day);
  const midnight = [...f.timers.entries()].find(([, timer]) => timer.ms > 60_000);
  assert.ok(midnight); f.timers.delete(midnight[0]); midnight[1].fn(); await f.tick(); enabled(f);
  assert.deepEqual(f.native.blocks, yesterday);
  assert.equal(next.blocks.find((b) => blockProperty(b, "routine-loaded"))?.content.includes("weekly-20250322"), true);
  const monthlyRefs = next.blocks.find((b) => b.content.startsWith("## Monthly tasks")).children;
  assert.equal(blockProperty(monthlyRefs[0], "routine-reference"), monthly.children[0].uuid);
  const scans = f.scans;
  f.document.dispatchEvent(new Event("visibilitychange")); f.document.defaultView.dispatchEvent(new Event("focus"));
  await f.tick(); enabled(f); assert.equal(f.scans, scans);
});

test("failed setup discovery can be refreshed immediately without writes or hidden cooldown", async (t) => {
  const f = fixture(t); delete f.native["journal?"];
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "invalid-page");
  assert.match(f.runtime.getStatus().message, /\[invalid-page\]/);
  assert.equal(f.writes.length, 0);
  const scans = f.scans;
  await f.runtime.refresh(); reason(f, "invalid-page");
  assert.ok(f.scans > scans, "explicit refresh rechecks failed pre-setup discovery");
  assert.equal(f.writes.length, 0);
  f.native["journal?"] = true;
  await f.runtime.refresh();
  assert.equal(f.runtime.getStatus().status, "ready");
  assert.equal(f.writes.length, 0, "successful read-only refresh is not setup approval");
  await f.runtime.enable(APPROVALS); enabled(f);
});

test("automatic cooldown retains the real failure; explicit refresh may retry immediately", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  delete f.native["journal?"];
  await f.advance(); reason(f, "invalid-page");
  const scans = f.scans, writes = f.writes.length;
  f.emit("route"); await f.tick(); reason(f, "invalid-page");
  assert.equal(f.scans, scans, "background callbacks still respect the one-minute budget");
  await f.runtime.refresh(); reason(f, "invalid-page");
  assert.ok(f.scans > scans);
  assert.equal(f.writes.length, writes);
  f.native["journal?"] = true;
  await f.runtime.refresh(); enabled(f);
});

for (const code of ["duplicate-period-owner", "non-journal-period-owner", "scan-limit", "conflicting-properties"]) {
  test(`discovery surfaces sanitized ${code} rather than generic owner failure`, async (t) => {
    const f = fixture(t, { adapterFactory: () => ({
      inspect: async () => ({ status: "blocked", reason: code }), invalidate() {}, destroy() {},
    }) });
    await f.runtime.start(); await f.reviewAndEnable(); reason(f, code);
    assert.ok(f.runtime.getStatus().message.includes(`[${code}]`));
    assert.equal(f.writes.length, 0);
  });
}

test("unknown adapter errors never expose raw graph content", async (t) => {
  const f = fixture(t, { adapterFactory: () => ({
    inspect: async () => ({ status: "blocked", reason: "PRIVATE graph path and note text" }), invalidate() {}, destroy() {},
  }) });
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "scan-blocked");
  await f.runtime.refresh(); reason(f, "scan-blocked");
  assert.ok(!JSON.stringify(f.runtime.getStatus()).includes("PRIVATE"));
  assert.equal(f.writes.length, 0);
});

test("owner query rejection identifies the SDK operation without exposing its error", async (t) => {
  const f = fixture(t), query = f.sdk.DB.datascriptQuery;
  f.sdk.DB.datascriptQuery = async (text) => {
    if (text.includes(":routine-loaded")) throw new Error("PRIVATE path and task content");
    return query(text);
  };
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, "owner-query-failed");
  assert.match(f.runtime.getStatus().message, /DB\.datascriptQuery/);
  assert.ok(!JSON.stringify(f.runtime.getStatus()).includes("PRIVATE"));
  assert.equal(f.writes.length, 0);
});

for (const [value, code] of [
  [null, "owner-query-shape"],
  [[[id(990)]], "owner-row-shape"],
  [[[{}, "private", "weekly-20250315"]], "owner-uuid-shape"],
  [[[id(991), null, "weekly-20250315"]], "owner-name-shape"],
  [[[id(992), "private", []]], "owner-period-shape"],
]) test(`unsupported owner response reports ${code} without guessing or writing`, async (t) => {
  const f = fixture(t), query = f.sdk.DB.datascriptQuery;
  f.sdk.DB.datascriptQuery = async (text) => text.includes(":routine-loaded") ? value : query(text);
  await f.runtime.start(); await f.reviewAndEnable(); reason(f, code);
  assert.equal(f.writes.length, 0);
});

test("configuration read failures and malformed configuration are distinct", async (t) => {
  const f = fixture(t), read = f.sdk.App.getCurrentGraphConfigs;
  await f.runtime.start();
  f.sdk.App.getCurrentGraphConfigs = async (...keys) => {
    if (keys.length === 1) throw new Error("PRIVATE config path");
    return read(...keys);
  };
  await f.runtime.open(); reason(f, "configuration-read-failed");
  f.sdk.App.getCurrentGraphConfigs = async (...keys) => keys.length === 1 ? [] : read(...keys);
  await f.runtime.refresh(); reason(f, "configuration-shape");
  assert.equal(f.writes.length, 0);
});

test("native journal lookup excludes dated blocks, including nested blocks, without duplicating work", async (t) => {
  const f = fixture(t);
  const note = f.block("PRIVATE existing note", [f.block("PRIVATE nested note")]), before = clone(note);
  f.native.blocks.push(note);
  await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  assert.deepEqual(note, before);
  const writes = f.writes.length;
  await f.runtime.refresh(); enabled(f);
  assert.equal(f.writes.length, writes);
  assert.deepEqual(note, before);
});

test("existing interleaved notes survive full activation, section ordering and no-op refresh", async (t) => {
  const f = fixture(t);
  const roots = [f.block("PRIVATE root A"), f.block("PRIVATE root B", [f.block("PRIVATE child")])];
  const before = clone(roots);
  f.native.blocks.push(f.block("## Notes"), ...roots, f.block("## Tasks"), f.block("## Focus"));
  await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  assert.deepEqual(roots, before);
  assert.deepEqual(f.native.blocks.filter((b) => roots.includes(b)), roots);
  const writes = f.writes.length;
  await f.runtime.refresh(); enabled(f);
  assert.equal(f.writes.length, writes);
  assert.deepEqual(roots, before);
});

test("native journal lookup still blocks two actual pages with the same date before further writes", async (t) => {
  const f = fixture(t);
  await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  const other = f.page("second native page", f.day, [f.block("PRIVATE other journal")]);
  const before = clone(f.pages), writes = f.writes.length;
  assert.notEqual(other.uuid, f.native.uuid);
  await f.runtime.refresh(); reason(f, "duplicate-journal");
  assert.equal(f.writes.length, writes);
  assert.deepEqual(f.pages, before);
});

test("native journal lookup shape and duplicate identities are distinguished", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  const query = f.sdk.DB.datascriptQuery, writes = f.writes.length;
  let result = null;
  f.sdk.DB.datascriptQuery = async (text) => text.includes(":block/journal-day") ? result : query(text);
  await f.runtime.refresh(); reason(f, "journal-query-shape");
  result = [[{}]];
  await f.runtime.refresh(); reason(f, "journal-row-shape");
  result = [[f.native.uuid], [id(993)]];
  await f.runtime.refresh(); reason(f, "duplicate-journal");
  assert.equal(f.writes.length, writes);
});

for (const code of [
  "busy", "invalid-plan", "invalid-data", "operation-limit", "unsafe-insert", "unsafe-move", "unsafe-remove",
  "unsafe-update", "unsafe-loaded-transition", "unsafe-order", "uuid-collision", "guard-failed", "guard-denied",
  "historical-journal", "future-routine-write", "page-conflict", "block-conflict", "read-failed", "read-limit",
  "unsupported-tree", "precondition-conflict", "uncertain-outcome", "invalid-recovery-record",
  "recovery-store-failed", "recovery-store-uncertain", "recovery-plan-required",
]) {
  test(`writer failure surfaces sanitized ${code} and retains its checkpoint`, async (t) => {
    const checkpoint = { version: 1, privateSentinel: "PRIVATE checkpoint" };
    let calls = 0;
    const f = fixture(t, { writerFactory: ({ recoveryStore }) => ({
      async apply(input) {
        calls++;
        await recoveryStore.save(input.graphKey, checkpoint);
        return { status: "blocked", reason: code, operationsApplied: 0, recoveryRequired: true, error: "PRIVATE host error" };
      },
    }) });
    await f.runtime.start(); await f.reviewAndEnable();
    const expected = code === "recovery-plan-required" ? code : `writer-${code}`;
    reason(f, expected);
    if (code !== "recovery-plan-required") assert.ok(f.runtime.getStatus().message.includes(`[${expected}]`));
    assert.ok(!JSON.stringify(f.runtime.getStatus()).includes("PRIVATE"));
    assert.equal(calls, 1);
    assert.equal(f.native.blocks.length, 0);
    const key = (await graphIdentity(f.sdk)).key;
    assert.deepEqual(f.data.get(R + key), checkpoint);
  });
}

for (const code of ["PRIVATE unknown writer error", "__proto__", "page-read-failed", null]) {
  test(`unknown writer reason ${JSON.stringify(code)} falls back without leaking host data`, async (t) => {
    const f = fixture(t, { writerFactory: () => ({ apply: async () => ({ status: "blocked", reason: code }) }) });
    await f.runtime.start(); await f.reviewAndEnable(); reason(f, "writer-blocked");
    assert.ok(!JSON.stringify(f.runtime.getStatus()).includes("PRIVATE"));
    assert.equal(f.native.blocks.length, 0);
  });
}

test("unexpected internal failures do not masquerade as graph read corruption", async (t) => {
  const f = fixture(t, { setupFactory: () => ({ inspect: async () => { throw new Error("PRIVATE internal state"); } }) });
  await f.runtime.start(); await f.runtime.open(); reason(f, "runtime-unexpected");
  assert.ok(!JSON.stringify(f.runtime.getStatus()).includes("PRIVATE"));
  assert.equal(f.writes.length, 0);
});

test("cached discovery expires, but source changes before expiry never authorize stale writes", async (t) => {
  const f = fixture(t); await f.runtime.start(); await f.reviewAndEnable(); enabled(f);
  const scans = f.scans;
  f.time += 900_001; f.emit("route"); await f.tick(); enabled(f); assert.ok(f.scans > scans);
  const after = f.scans;
  f.pages.find((p) => p.name === "week routine").blocks.push(f.block("TODO changed definition"));
  f.emit("db"); await f.tick(); reason(f, "scan-throttled"); assert.equal(f.scans, after);
  await f.advance(); enabled(f);
});
