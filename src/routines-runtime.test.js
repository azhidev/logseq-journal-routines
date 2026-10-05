import assert from "node:assert/strict";
import test from "node:test";
import { createRoutinesRuntime } from "./routines-runtime.js";
import { gregorianPeriods, makePeriod } from "./period-model.js";
import { HISTORY_PAGE, historyQuery } from "./routine-history.js";
import { DAILY_TEMPLATE, DAILY_TEMPLATE_PAGE } from "./daily-template.js";

// Recorded from Persian Calendar describeDate("2026-03-21"); no fake conversion API.
const CALENDAR_DATE = {
  gregorian: { year: 2026, month: 3, day: 21, iso: "2026-03-21", journalDay: 20260321 },
  persian: { year: 1405, month: 1, day: 1, iso: "1405-01-01", label: "شنبه 1 فروردین 1405", weekOfYear: 1 },
  week: { start: "2026-03-21", end: "2026-03-27", key: "weekly-20260321" },
  month: { start: "2026-03-21", end: "2026-04-20", key: "monthly-1405-01", financeKey: "1405-01" },
};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clone = (v) => structuredClone(v);
const isHeader = (block) => block.preBlock === true || block["pre-block?"] === true;
const headerOf = (page) => page.blocks.find(isHeader);
const contentBlocks = (page) => page.blocks.filter((block) => !isHeader(block));
const propertyContent = (properties) => Object.entries(properties).map(([key, value]) => `${key}:: ${value}`).join("\n");

function fixture() {
  const records = new Map(), graphs = new Map(), calls = [], listeners = new Set(), graphConfigs = new Map();
  let graph = "/graph/a", graphName = "Same display name", next = 10, calendarAvailable = true, afterCreate = null;
  let date = new Date(2026, 2, 21, 12), nextTimer = 0;
  const timerTasks = new Map(), documentListeners = new Map();
  const now = () => new Date(date);
  const timers = {
    setTimeout(fn, delay) { const id = ++nextTimer; timerTasks.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timerTasks.delete(id); },
  };
  const document = {
    visibilityState: "visible",
    addEventListener(event, fn) {
      if (!documentListeners.has(event)) documentListeners.set(event, new Set());
      documentListeners.get(event).add(fn);
    },
    removeEventListener(event, fn) { documentListeners.get(event)?.delete(fn); },
  };
  const pages = (path = graph) => {
    if (!graphs.has(path)) graphs.set(path, new Map());
    return graphs.get(path);
  };
  const storage = {
    async get(key) { calls.push(["storage.get", graph, key]); return clone(records.get(key) ?? null); },
    async set(key, value) { calls.push(["storage.set", graph, key]); records.set(key, clone(value)); },
  };
  const find = (id, path = graph) => {
    for (const page of pages(path).values()) {
      function walk(blocks) {
        for (const block of blocks) {
          if (block.uuid === id) return { block, blocks, page };
          const result = walk(block.children ?? []);
          if (result) return result;
        }
      }
      const match = walk(page.blocks);
      if (match) return match;
    }
  };
  const sdk = {
    provideStyle(options) { calls.push(["style", options]); },
    App: {
      async getCurrentGraph() { calls.push(["graph", graph]); return { path: graph, name: graphName }; },
      async getCurrentGraphConfigs(key) { assert.equal(key, "default-templates"); return clone(graphConfigs.get(graph) ?? {}); },
      async setCurrentGraphConfigs(value) { calls.push(["config", graph, clone(value)]); graphConfigs.set(graph, clone(value["default-templates"])); },
      async getTemplate(name) {
        for (const page of pages().values()) {
          const root = page.blocks.find((block) => block.properties?.template === name);
          if (root) return clone(root);
        }
        return null;
      },
      onCurrentGraphChanged(callback) { listeners.add(callback); return () => listeners.delete(callback); },
      registerCommandPalette(options) { calls.push(["command", options.key]); },
      pushState(...args) { calls.push(["route", ...args]); },
      async invokeExternalPlugin(target, ...args) {
        calls.push(["calendar", graph, target, ...args]);
        if (!calendarAvailable) throw new Error("plugin missing");
        if (target === "persian-calendar.models.getApiInfo") return {
          id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"],
        };
        assert.equal(target, "persian-calendar.models.describeDate");
        assert.equal(args.length, 1);
        assert.ok(["2026-03-21", "2026-03-27"].includes(args[0]));
        const result = clone(CALENDAR_DATE);
        if (args[0] === "2026-03-27") {
          result.gregorian = { year: 2026, month: 3, day: 27, iso: "2026-03-27", journalDay: 20260327 };
          result.persian = { ...result.persian, day: 7, iso: "1405-01-07", label: "جمعه 7 فروردین 1405" };
        }
        return result;
      },
    },
    Editor: {
      async getPage(name) {
        calls.push(["getPage", graph, name]);
        const page = pages().get(name);
        if (!page) return null;
        const { blocks, ...entity } = page;
        return clone(entity);
      },
      async createPage(name, properties, options) {
        const at = graph;
        calls.push(["createPage", at, name, clone(properties)]);
        assert.deepEqual(options, { redirect: false, createFirstBlock: false, format: "markdown" });
        assert.ok(properties == null || Object.keys(properties).length === 0, "Nonempty createPage properties cause the Bean regression");
        if (pages(at).has(name)) return null;
        const page = { uuid: uuid(++next), id: next, name, properties: {}, blocks: [], format: "markdown" };
        pages(at).set(name, page);
        if (afterCreate) await afterCreate(name);
        return clone(page);
      },
      async getPageBlocksTree(id) {
        calls.push(["getPageBlocksTree", graph]);
        return clone([...pages().values()].find((p) => p.uuid === id)?.blocks ?? null);
      },
      async newBlockUUID() { return uuid(++next); },
      async getBlock(id) { calls.push(["getBlock", graph, id]); return clone(find(id)?.block ?? null); },
      async insertBlock(anchor, content, options) {
        calls.push(["insertBlock", graph, anchor, content, clone(options)]);
        const page = pages().get(anchor) ?? [...pages().values()].find((p) => p.uuid === anchor);
        const target = page ? { blocks: page.blocks } : find(anchor);
        assert.ok(target);
        const list = page ? page.blocks : options.sibling ? target.blocks : (target.block.children ??= []);
        const index = options.sibling ? list.findIndex((item) => item.uuid === anchor) + 1 : list.length;
        const parentId = page ? page.id : options.sibling ? target.block.parent.id : target.block.id;
        const block = { id: ++next, uuid: options.customUUID, content, children: [],
          page: { id: (page ?? target.page).id }, parent: { id: parentId },
          left: { id: index === 0 ? parentId : list[index - 1].id } };
        if (content.startsWith("Daily journal template\n")) {
          block.properties = Object.fromEntries(content.split("\n").flatMap((line) => {
            const match = /^([a-z][a-z-]*):: (.*)$/.exec(line);
            return match ? [[match[1], match[2]]] : [];
          }));
        }
        list.splice(index, 0, block);
        if (list[index + 1]) list[index + 1].left = { id: block.id };
        return clone(block);
      },
      async checkEditing() { calls.push(["checkEditing", graph]); return false; },
      async updateBlock(id, content) {
        calls.push(["updateBlock", graph, id, content]);
        const target = find(id);
        assert.ok(target, "Metadata target must exist");
        const { block, page } = target;
        if (block.properties?.template === DAILY_TEMPLATE) {
          block.content = content;
          block.properties = Object.fromEntries(content.split("\n").flatMap((line) => {
            const match = /^([a-z][a-z-]*):: (.*)$/.exec(line);
            return match ? [[match[1], match[2]]] : [];
          }));
          return;
        }
        assert.equal(page.blocks[0], block, "Metadata must target the first page root");
        assert.equal(block.parent.id, page.id);
        assert.equal(block.left.id, page.id);
        assert.deepEqual(block.children, []);
        const properties = {};
        for (const line of content.split("\n")) {
          const match = /^([a-z][a-z0-9-]*):: (.+)$/.exec(line);
          assert.ok(match, "Metadata text must contain only property lines");
          assert.equal(Object.hasOwn(properties, match[1]), false, "Duplicate property");
          properties[match[1]] = match[2];
        }
        block.content = content;
        block.properties = properties;
        block.preBlock = true;
        page.properties = clone(properties);
      },
      async upsertBlockProperty(id, key, value) {
        calls.push(["property", graph, key, value]);
        const target = find(id)?.block;
        assert.ok(target && isHeader(target), "Checkpoint must target the header block UUID, not the page UUID");
        target.properties[key] = value;
        target.content = propertyContent(target.properties);
        // Direct SDK transactions do not reliably refresh page.properties.
        // Deliberately leave its mutable snapshot/history state stale.
      },
      openInRightSidebar(id) { calls.push(["sidebar", graph, id]); },
    },
    UI: { async showMsg(text) { calls.push(["message", text]); } },
    DB: { async datascriptQuery(query) { calls.push(["query", graph, query]); return []; } },
  };
  const newRuntime = () => createRoutinesRuntime({ sdk, storage, now, timers, document });
  const runtime = newRuntime();
  return { runtime, newRuntime, sdk, storage, records, pages, calls, listeners, now, timerTasks, documentListeners, graphConfigs,
    setDate(value) { date = value; },
    setGraphName(value) { graphName = value; },
    emit(event = "visibilitychange") { for (const listener of [...(documentListeners.get(event) ?? [])]) listener(); },
    fireTimer() { const [id, task] = [...timerTasks][0]; timerTasks.delete(id); task.fn(); },
    switchGraph(path, notify = true) { graph = path; if (notify) for (const listener of listeners) listener(); },
    setCalendarAvailable(value) { calendarAvailable = value; },
    afterCreate(fn) { afterCreate = fn; },
  };
}
const namedCalls = (f, name) => f.calls.filter((call) => call[0] === name);
const initializationKey = (graphKey) => `journal-routines:initialization:v1:${graphKey}`;
const exampleRecord = (f) => f.records.get([...f.records.keys()].find((key) => key.startsWith("journal-routines:examples:v1:")));
const graphEffects = (f) => f.calls.filter((call) => [
  "createPage", "insertBlock", "updateBlock", "property", "config", "sidebar", "route",
].includes(call[0]));

function currentPeriods(f) {
  const selected = gregorianPeriods(f.now());
  const short = (iso) => new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "short", day: "numeric" })
    .format(new Date(`${iso}T12:00:00Z`));
  const titles = {
    weekly: `Week · ${short(selected.weekly.start)}–${short(selected.weekly.end)}`,
    monthly: new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(f.now()),
  };
  return Object.fromEntries(["weekly", "monthly"].map((kind) => [kind, {
    ...selected[kind], displayTitle: titles[kind], pageName: `${titles[kind]} — ${selected[kind].start}`,
  }]));
}

async function enableEmpty(f) {
  await f.runtime.start();
  for (const [index, kind] of ["weekly", "monthly"].entries()) {
    const name = f.runtime.getStatus().definitions[kind];
    f.pages().set(name, { id: index + 1, uuid: uuid(index + 1), name, properties: {}, format: "markdown", blocks: [] });
  }
  await f.runtime.enable();
}

test("onboarding detection and skip are persistent, graph-scoped and graph-write free", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  assert.equal(first.onboarding, "pending");
  await f.runtime.refreshStatus();
  assert.equal(f.records.size, 0, "opening setup does not persist or activate anything");
  await f.runtime.skipOnboarding(first.graphKey);
  assert.equal((await f.runtime.refreshStatus()).onboarding, "skipped");
  assert.equal(f.runtime.getStatus().enabled, false);
  assert.equal(f.pages().size, 0);
  assert.equal(namedCalls(f, "createPage").length, 0);
  const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
  assert.equal((await reloaded.start()).onboarding, "skipped");
  f.switchGraph("/graph/b", false);
  assert.equal((await f.runtime.refreshStatus()).onboarding, "pending");
  await assert.rejects(f.runtime.skipOnboarding(first.graphKey), /Graph changed/);
  assert.equal(f.runtime.getStatus().onboarding, "pending");
});

test("setup after skipping preserves existing empty definitions and repeat setup preserves edits", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const state = await f.runtime.start();
  await f.runtime.skipOnboarding(state.graphKey);
  await enableEmpty(f);
  assert.equal(f.runtime.getStatus().onboarding, "completed");
  for (const name of Object.values(state.definitions)) assert.deepEqual(f.pages().get(name).blocks, []);
  const weekly = f.pages().get(currentPeriods(f).weekly.pageName);
  contentBlocks(weekly)[0].content = "My edited routine summary";
  const before = clone([...f.pages()]);
  await f.runtime.enable(state.graphKey);
  assert.deepEqual([...f.pages()], before);
});

for (const onboarding of ["pending", "skipped", "completed"]) {
  test(`failed starter insert stays unfinished across reload and explicit retry with ${onboarding} preferences`, async (t) => {
    const f = fixture(); t.after(() => f.runtime.destroy());
    const first = await f.runtime.start();
    await f.runtime.configure({ autoOpen: false }, first.graphKey);
    const settingsKey = [...f.records.keys()].find((key) => key.includes("routines:v1:"));
    f.records.get(settingsKey).onboarding = onboarding;
    await f.runtime.refreshStatus();
    const insert = f.sdk.Editor.insertBlock;
    f.sdk.Editor.insertBlock = async (anchor, content, options) => {
      if (content.startsWith("TODO ")) {
        assert.equal(f.records.get(initializationKey(first.graphKey)).state, "pending");
        assert.equal(f.records.get(initializationKey(first.graphKey)).phase, "examples");
        assert.equal(exampleRecord(f).completed, false, "intent precedes the SDK write");
        throw new Error("starter write uncertain");
      }
      return insert(anchor, content, options);
    };
    await assert.rejects(f.runtime.enable(first.graphKey), /starter write uncertain/);
    assert.equal(f.runtime.getStatus().onboarding, onboarding);
    assert.equal(f.runtime.getStatus().enabled, true);
    assert.equal(f.runtime.getStatus().initialization, "pending");
    assert.equal(namedCalls(f, "sidebar").length, 0);
    f.sdk.Editor.insertBlock = insert;
    const before = clone([...f.pages()]);
    const record = clone(f.records.get(initializationKey(first.graphKey)));
    const effects = clone(graphEffects(f));
    await f.runtime.destroy();
    const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
    const status = await reloaded.start();
    assert.equal(status.onboarding, onboarding);
    assert.equal(status.initialization, "pending");
    assert.match(status.error, /initialization is unfinished/i);
    await reloaded.refreshStatus();
    await assert.rejects(reloaded.showCurrent(), /initialization is unfinished/i);
    assert.deepEqual(f.records.get(initializationKey(first.graphKey)), record);
    assert.deepEqual(graphEffects(f), effects, "startup/status/navigation cannot resume initialization");
    await assert.rejects(reloaded.enable(first.graphKey), /ambiguous|deleted/);
    assert.equal(reloaded.getStatus().onboarding, onboarding);
    assert.equal(reloaded.getStatus().initialization, "pending");
    assert.equal(exampleRecord(f).completed, false);
    assert.deepEqual([...f.pages()], before);
    assert.deepEqual(graphEffects(f), effects, "explicit retry must not refill a missing attempted block");
  });
}

test("skipping after failed initialization does not hide its durable pending warning", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  const insert = f.sdk.Editor.insertBlock;
  f.sdk.Editor.insertBlock = async (...args) => {
    if (args[1].startsWith("TODO ")) throw new Error("starter failed");
    return insert(...args);
  };
  await assert.rejects(f.runtime.enable(first.graphKey), /starter failed/);
  const before = clone([...f.pages()]);
  const effects = clone(graphEffects(f));
  await f.runtime.skipOnboarding(first.graphKey);
  assert.equal((await f.runtime.refreshStatus()).onboarding, "skipped");
  assert.equal(f.runtime.getStatus().initialization, "pending");
  await f.runtime.destroy();
  const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
  const status = await reloaded.start();
  assert.equal(status.onboarding, "skipped");
  assert.equal(status.initialization, "pending");
  assert.match(status.error, /initialization is unfinished/i);
  await assert.rejects(reloaded.showCurrent(), /initialization is unfinished/i);
  assert.deepEqual([...f.pages()], before);
  assert.deepEqual(graphEffects(f), effects);
});

for (const edited of [false, true]) {
  test(`lost starter acknowledgement ${edited ? "preserves edited partial pages and pauses" : "completes only on read-verified explicit retry without duplicates"}`, async (t) => {
    const f = fixture(); t.after(() => f.runtime.destroy());
    const first = await f.runtime.start();
    const insert = f.sdk.Editor.insertBlock;
    let lost = false;
    f.sdk.Editor.insertBlock = async (...args) => {
      const result = await insert(...args);
      if (!lost && args[1].startsWith("TODO ")) {
        lost = true;
        throw new Error("lost starter acknowledgement");
      }
      return result;
    };
    await assert.rejects(f.runtime.enable(first.graphKey), /lost starter acknowledgement/);
    assert.equal(exampleRecord(f).completed, false);
    assert.equal(f.runtime.getStatus().initialization, "pending");
    const weekly = f.pages().get(currentPeriods(f).weekly.pageName);
    const sample = contentBlocks(weekly)[0].children[0];
    assert.ok(sample.content.startsWith("TODO "));
    const sampleId = sample.uuid;
    if (edited) sample.content = "DONE preserved user edit";
    const before = clone([...f.pages()]);
    const effects = clone(graphEffects(f));
    const creates = namedCalls(f, "createPage").length;
    await f.runtime.destroy();
    const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
    assert.match((await reloaded.start()).error, /initialization is unfinished/i);
    await assert.rejects(reloaded.showCurrent(), /initialization is unfinished/i);
    assert.deepEqual([...f.pages()], before);
    assert.deepEqual(graphEffects(f), effects);
    if (edited) {
      await assert.rejects(reloaded.enable(first.graphKey), /content other than unchanged examples|Unexpected content/i);
      assert.deepEqual([...f.pages()], before);
      assert.deepEqual(graphEffects(f), effects);
      assert.equal(reloaded.getStatus().initialization, "pending");
      assert.equal(exampleRecord(f).completed, false);
    } else {
      const completed = await reloaded.enable(first.graphKey);
      assert.equal(completed.initialization, "verified");
      assert.equal(completed.onboarding, "completed");
      assert.equal(f.records.get(initializationKey(first.graphKey)).state, "verified");
      assert.equal(exampleRecord(f).completed, true);
      assert.equal(contentBlocks(weekly)[0].children[0].uuid, sampleId);
      for (const kind of ["weekly", "monthly"]) {
        const summary = contentBlocks(f.pages().get(currentPeriods(f)[kind].pageName))[0];
        const definition = f.pages().get(completed.definitions[kind]);
        assert.equal(summary.children.length, 2);
        assert.equal(new Set(summary.children.map((block) => block.uuid)).size, 2);
        assert.deepEqual(contentBlocks(definition).map((block) => block.content), summary.children.map((block) => block.content));
      }
      assert.equal(namedCalls(f, "createPage").length, creates);
      const completedEffects = clone(graphEffects(f));
      await reloaded.enable(first.graphKey);
      assert.deepEqual(graphEffects(f), completedEffects, "repeat Enable must not insert or navigate again");
    }
  });
}

test("new definitions preserve native title headers without metadata writes and still seed once", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  const headers = new Map();
  f.afterCreate((name) => {
    if (!Object.values(first.definitions).includes(name)) return;
    const page = f.pages().get(name);
    const header = { id: page.id + 1000, uuid: uuid(page.id + 1000), preBlock: true,
      content: `title:: ${name}`, properties: { title: name }, format: "markdown", children: [],
      page: { id: page.id }, parent: { id: page.id }, left: { id: page.id } };
    page.blocks.push(header);
    headers.set(name, clone(header));
  });
  await f.runtime.enable(first.graphKey);
  for (const [name, header] of headers) {
    const page = f.pages().get(name);
    assert.deepEqual(headerOf(page), header);
    assert.deepEqual(page.properties, {}, "native title mirror need not be populated");
    assert.equal(contentBlocks(page).length, 2);
    assert.ok(!namedCalls(f, "updateBlock").some((call) => call[2] === header.uuid));
  }
  const effects = clone(graphEffects(f));
  await f.runtime.enable(first.graphKey);
  assert.deepEqual(graphEffects(f), effects);
});

for (const defect of ["acknowledgement", "properties", "content", "tree"]) {
  test(`unverified definition ${defect} keeps intent pending and is never adopted on reload`, async (t) => {
    const f = fixture(); t.after(() => f.runtime.destroy());
    const first = await f.runtime.start();
    const create = f.sdk.Editor.createPage;
    f.sdk.Editor.createPage = async (...args) => {
      const ack = await create(...args);
      if (args[0] !== first.definitions.weekly) return ack;
      const page = f.pages().get(args[0]);
      if (defect === "acknowledgement") return { ...ack, name: "Different page" };
      if (defect === "properties") page.properties.tags = "User property";
      if (defect === "content") page.blocks.push({ id: 999, uuid: uuid(999), content: "User note", children: [],
        page: { id: page.id }, parent: { id: page.id }, left: { id: page.id } });
      return ack;
    };
    if (defect === "tree") f.sdk.Editor.getPageBlocksTree = async () => undefined;
    await assert.rejects(f.runtime.enable(first.graphKey), /Definition creation outcome is ambiguous/);
    assert.equal(f.records.get(initializationKey(first.graphKey)).phase, "definitions");
    assert.equal(f.runtime.getStatus().enabled, false);
    assert.equal(namedCalls(f, "createPage").length, 1);
    assert.equal(namedCalls(f, "insertBlock").length, 0);
    assert.equal(namedCalls(f, "updateBlock").length, 0);
    const pages = clone([...f.pages()]);
    const effects = clone(graphEffects(f));
    await f.runtime.destroy();
    const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
    await reloaded.start();
    await assert.rejects(reloaded.enable(first.graphKey), /Definition creation outcome is ambiguous/);
    assert.deepEqual([...f.pages()], pages);
    assert.deepEqual(graphEffects(f), effects);
  });
}

test("definition appearing after initial preflight is preserved rather than adopted", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  const get = f.sdk.Editor.getPage;
  let reads = 0;
  f.sdk.Editor.getPage = async (name) => {
    if (name === first.definitions.weekly && ++reads === 2) {
      f.pages().set(name, { id: 1, uuid: uuid(1), name, properties: { tags: "mine" }, blocks: [], format: "markdown" });
    }
    return get(name);
  };
  await assert.rejects(f.runtime.enable(first.graphKey), /already exists/);
  assert.deepEqual(f.pages().get(first.definitions.weekly).properties, { tags: "mine" });
  assert.equal(namedCalls(f, "createPage").length, 0);
  assert.equal(f.records.get(initializationKey(first.graphKey)).phase, "definitions");
});

test("graph switch during definition tree verification stops before further writes", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  const tree = f.sdk.Editor.getPageBlocksTree;
  f.sdk.Editor.getPageBlocksTree = async (...args) => {
    const result = await tree(...args);
    f.switchGraph("/graph/b");
    return result;
  };
  await assert.rejects(f.runtime.enable(first.graphKey), /cancelled|Graph changed/);
  assert.equal(namedCalls(f, "createPage").length, 1);
  assert.equal(namedCalls(f, "insertBlock").length, 0);
  assert.equal(namedCalls(f, "updateBlock").length, 0);
  assert.equal(f.pages("/graph/b").size, 0);
  assert.equal(f.records.get(initializationKey(first.graphKey)).phase, "definitions");
});

test("initialization intent is saved before definition writes and ambiguous definitions are never adopted on retry", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  f.afterCreate((name) => {
    if (name !== first.definitions.weekly) return;
    const record = f.records.get(initializationKey(first.graphKey));
    assert.equal(record.state, "pending");
    assert.equal(record.phase, "definitions");
    assert.deepEqual(record.definitions, first.definitions);
    assert.deepEqual(record.periods, Object.fromEntries(Object.entries(currentPeriods(f)).map(([kind, period]) => [kind, period.id])));
    throw new Error("lost definition acknowledgement");
  });
  await assert.rejects(f.runtime.enable(first.graphKey), /Definition creation outcome is ambiguous/);
  const before = clone([...f.pages()]);
  const effects = clone(graphEffects(f));
  await f.runtime.destroy();
  const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
  assert.match((await reloaded.start()).error, /initialization is unfinished/i);
  await assert.rejects(reloaded.enable(first.graphKey), /Definition creation outcome is ambiguous/);
  assert.equal(reloaded.getStatus().initialization, "pending");
  assert.deepEqual([...f.pages()], before);
  assert.deepEqual(graphEffects(f), effects);
});

for (const changed of ["calendar", "definitions", "periods"]) {
  test(`explicit initialization retry refuses changed ${changed} without new writes`, async (t) => {
    const f = fixture(); t.after(() => f.runtime.destroy());
    const first = await f.runtime.start();
    const insert = f.sdk.Editor.insertBlock;
    f.sdk.Editor.insertBlock = async (...args) => {
      if (args[1].startsWith("TODO ")) throw new Error("starter failed");
      return insert(...args);
    };
    await assert.rejects(f.runtime.enable(first.graphKey), /starter failed/);
    f.sdk.Editor.insertBlock = insert;
    const settingsKey = [...f.records.keys()].find((key) => key.includes("routines:v1:"));
    if (changed === "calendar") f.records.get(settingsKey).calendar = "jalali";
    if (changed === "definitions") f.records.get(settingsKey).definitions.weekly = "Another weekly source";
    if (changed === "periods") f.setDate(new Date(2026, 3, 1, 12));
    const before = clone([...f.pages()]);
    const record = clone(f.records.get(initializationKey(first.graphKey)));
    const effects = clone(graphEffects(f));
    await f.runtime.destroy();
    const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
    await reloaded.start();
    await assert.rejects(reloaded.enable(first.graphKey), /different settings or periods/);
    assert.deepEqual(f.records.get(initializationKey(first.graphKey)), record);
    assert.deepEqual([...f.pages()], before);
    assert.deepEqual(graphEffects(f), effects);
  });
}

test("rollover during definition creation cannot initialize different periods or verify the old attempt", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  const originalPeriods = currentPeriods(f);
  f.afterCreate((name) => {
    if (name === first.definitions.monthly) f.setDate(new Date(2026, 3, 1, 12));
  });
  await assert.rejects(f.runtime.enable(first.graphKey), /periods changed during initialization/);
  const record = f.records.get(initializationKey(first.graphKey));
  assert.equal(record.state, "pending");
  assert.deepEqual(record.periods, Object.fromEntries(Object.entries(originalPeriods).map(([kind, period]) => [kind, period.id])));
  assert.equal(f.pages().size, 2, "only approved definition creation occurred before rollover was detected");
  assert.equal(namedCalls(f, "sidebar").length, 0);
  assert.equal(exampleRecord(f), undefined);
  const before = clone([...f.pages()]);
  await assert.rejects(f.runtime.enable(first.graphKey), /different settings or periods/);
  assert.deepEqual([...f.pages()], before);
});

test("explicit retry read-verifies an interrupted period snapshot without duplicate creation", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  for (const [index, name] of Object.values(first.definitions).entries()) {
    f.pages().set(name, { id: index + 1, uuid: uuid(index + 1), name, properties: {}, format: "markdown", blocks: [] });
  }
  const insert = f.sdk.Editor.insertBlock;
  let lost = false;
  f.sdk.Editor.insertBlock = async (...args) => {
    const result = await insert(...args);
    if (!lost && args[1] === "\u200B") { lost = true; throw new Error("lost summary acknowledgement"); }
    return result;
  };
  await assert.rejects(f.runtime.enable(first.graphKey), /ambiguous|acknowledgement/);
  assert.equal(f.records.get(initializationKey(first.graphKey)).phase, "periods");
  const weekly = f.pages().get(currentPeriods(f).weekly.pageName);
  const summaryId = contentBlocks(weekly)[0].uuid;
  const effects = clone(graphEffects(f));
  await f.runtime.destroy();
  const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
  assert.match((await reloaded.start()).error, /initialization is unfinished/i);
  assert.deepEqual(graphEffects(f), effects);
  assert.equal((await reloaded.enable(first.graphKey)).initialization, "verified");
  assert.equal(contentBlocks(weekly).length, 1);
  assert.equal(contentBlocks(weekly)[0].uuid, summaryId);
  assert.equal(namedCalls(f, "createPage").filter((call) => call[2] === weekly.name).length, 1);
  assert.equal(exampleRecord(f), undefined, "existing definitions are not automatically seeded");
});

test("retry cannot confirm initialization after a verified snapshot summary is deleted", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  await f.runtime.configure({ autoOpen: false }, first.graphKey);
  for (const [index, name] of Object.values(first.definitions).entries()) {
    f.pages().set(name, { id: index + 1, uuid: uuid(index + 1), name, properties: {}, format: "markdown", blocks: [] });
  }
  const save = f.storage.set;
  f.storage.set = async (key, value) => {
    if (key === initializationKey(first.graphKey) && value.state === "verified") throw new Error("completion save failed");
    return save(key, value);
  };
  await assert.rejects(f.runtime.enable(first.graphKey), /completion save failed/);
  f.storage.set = save;
  const weekly = f.pages().get(currentPeriods(f).weekly.pageName);
  weekly.blocks.splice(1);
  const before = clone([...f.pages()]);
  const effects = clone(graphEffects(f));
  await assert.rejects(f.runtime.enable(first.graphKey), /summary block could not be verified/);
  assert.equal(f.runtime.getStatus().initialization, "pending");
  assert.equal(f.records.get(initializationKey(first.graphKey)).state, "pending");
  assert.deepEqual([...f.pages()], before);
  assert.deepEqual(graphEffects(f), effects);
});

test("previously saved alpha settings do not trigger a new welcome", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  await f.runtime.configure({ autoOpen: false });
  const key = [...f.records.keys()].find((key) => key.includes("routines:v1:"));
  delete f.records.get(key).onboarding;
  assert.equal((await f.runtime.refreshStatus()).onboarding, "completed");
  assert.equal(f.pages().size, 0);
});

test("first Enable seeds both new default definitions and current localized Gregorian pages once", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const selected = currentPeriods(f);
  assert.equal((await f.runtime.start()).enabled, false);
  assert.equal(namedCalls(f, "createPage").length, 0);
  const save = f.storage.set;
  let verified = false;
  f.storage.set = async (key, value) => {
    if (key === initializationKey(f.runtime.getStatus().graphKey) && value.state === "verified") {
      verified = true;
      assert.equal(value.phase, "examples");
      assert.equal(exampleRecord(f).completed, true, "example verification precedes initialization completion");
      for (const kind of ["weekly", "monthly"]) {
        assert.equal(contentBlocks(f.pages().get(selected[kind].pageName))[0].children.length, 2);
        assert.equal(contentBlocks(f.pages().get(value.definitions[kind])).length, 2);
      }
    }
    return save(key, value);
  };
  const state = await f.runtime.enable();
  assert.equal(verified, true);
  assert.equal(state.initialization, "verified");
  assert.equal(state.enabled, true);
  assert.equal(state.onboarding, "completed");
  assert.equal((await f.runtime.refreshStatus()).onboarding, "completed");
  assert.equal(f.pages().size, 4);
  assert.equal(selected.weekly.pageName, "Week · Mar 16–Mar 22 — 2026-03-16");
  assert.equal(selected.monthly.pageName, "March 2026 — 2026-03-01");
  assert.equal(f.pages().has(gregorianPeriods(f.now()).weekly.pageName), false);
  for (const kind of ["weekly", "monthly"]) {
    const period = f.pages().get(selected[kind].pageName);
    const definition = f.pages().get(state.definitions[kind]);
    const [summary] = contentBlocks(period);
    assert.equal(summary.content, "\u200B");
    assert.equal(JSON.parse(period.properties["jr-snapshot-plan"]).displayTitle, "\u200B");
    assert.equal(summary.children.length, 2);
    assert.deepEqual(summary.children.map((block) => block.content), kind === "weekly"
      ? ["TODO Plan the week", "TODO Review the week"] : ["TODO Set monthly goals", "TODO Review monthly progress"]);
    assert.deepEqual(contentBlocks(definition).map((block) => block.content), summary.children.map((block) => block.content));
  }
  assert.ok(namedCalls(f, "createPage").filter((call) => Object.values(selected).some((period) => period.pageName === call[2]))
    .every((call) => call[3] === null), "Period creation must not pass a properties map");
  assert.equal(namedCalls(f, "updateBlock").length, 2);
  assert.equal(namedCalls(f, "checkEditing").length, 4, "definitions and period bootstraps are guarded");
  for (const kind of ["weekly", "monthly"]) {
    assert.deepEqual(f.pages().get(state.definitions[kind]).properties, {}, "definitions gain no metadata");
    assert.equal(headerOf(f.pages().get(state.definitions[kind])), undefined, "definitions gain no bootstrap header");
  }
  assert.equal(headerOf(f.pages().get(selected.weekly.pageName)).properties["jr-snapshot-state"], "populated");
  assert.equal(f.pages().get(selected.weekly.pageName).properties["jr-snapshot-state"], "ready:0", "page mutable state stays stale");
  const sidebar = namedCalls(f, "sidebar");
  assert.equal(sidebar.length, 2);
  assert.equal(sidebar[0][2], contentBlocks(f.pages().get(selected.monthly.pageName))[0].uuid);
  assert.equal(sidebar[1][2], contentBlocks(f.pages().get(selected.weekly.pageName))[0].uuid);
  const before = namedCalls(f, "createPage").length;
  const inserts = namedCalls(f, "insertBlock").length;
  await f.runtime.showCurrent();
  await f.runtime.enable();
  assert.equal(namedCalls(f, "createPage").length, before);
  assert.equal(namedCalls(f, "insertBlock").length, inserts);
  await f.runtime.disable();
  assert.equal(f.pages().size, 4);
  assert.equal(f.listeners.size, 1);
});

test("an unverified summary never falls back to a metadata-bearing page pane", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start(); await f.runtime.enable();
  const page = f.pages().get(currentPeriods(f).weekly.pageName);
  const summary = contentBlocks(page)[0];
  const before = clone([...f.pages()]);
  const sidebarCount = namedCalls(f, "sidebar").length;
  const original = f.sdk.Editor.getBlock;
  f.sdk.Editor.getBlock = async (id, ...options) => id === summary.uuid ? null : original(id, ...options);
  await assert.rejects(f.runtime.showCurrent(), /summary block could not be verified/);
  assert.equal(namedCalls(f, "sidebar").length, sidebarCount);
  assert.deepEqual([...f.pages()], before);
  assert.match(f.runtime.getStatus().error, /summary block could not be verified/);
});

test("nested task snapshot is not repopulated after editing or deletion; durable marker prevents page recreation", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  const definition = "Journal & Routines — Weekly definition";
  f.pages().set(definition, { id: 1, uuid: uuid(1), name: definition, properties: {}, format: "markdown", blocks: [
    { id: 2, uuid: uuid(2), page: { id: 1 }, parent: { id: 1 }, left: { id: 1 }, content: "DONE source", children: [
      { id: 3, uuid: uuid(3), page: { id: 1 }, parent: { id: 2 }, left: { id: 2 }, content: "WAITING child", children: [] },
    ] },
  ] });
  await f.runtime.enable();
  const name = currentPeriods(f).weekly.pageName;
  const page = f.pages().get(name);
  const summary = contentBlocks(page)[0], task = summary.children[0];
  assert.equal(task.content, "TODO source");
  assert.equal(summary.left.id, headerOf(page).id);
  assert.equal(task.parent.id, summary.id);
  assert.equal(task.children[0].content, "TODO child");
  task.content = "DONE changed";
  task.children = [];
  await f.runtime.showCurrent();
  assert.equal(summary.children[0].content, "DONE changed");
  assert.equal(summary.children[0].children.length, 0);
  f.pages().delete(name);
  await assert.rejects(f.runtime.showCurrent(), /Previously attempted period is unavailable/);
  assert.equal(f.pages().has(name), false);
  assert.ok([...f.records.keys()].some((key) => key.includes("period-seen")));
});

test("graph isolation, disabled graphs, and unload cleanup", async () => {
  const f = fixture();
  await f.runtime.start();
  await f.runtime.enable();
  f.switchGraph("/graph/b");
  // Wait for the queued graph-change refresh.
  await f.runtime.showCurrent();
  assert.equal(f.runtime.getStatus().enabled, false);
  assert.equal(f.pages().size, 0);
  await f.runtime.enable();
  assert.equal(f.pages().size, 4);
  f.switchGraph("/graph/a");
  await f.runtime.showCurrent();
  assert.equal(f.runtime.getStatus().enabled, true);
  await f.runtime.destroy();
  assert.equal(f.listeners.size, 0);
  await assert.rejects(f.runtime.showCurrent(), /not started/);
});

test("calendar switch cancel and unavailable dependency preserve settings and pages", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start(); await f.runtime.enable();
  const key = f.runtime.getStatus().graphKey;
  await assert.rejects(f.runtime.configure({ calendar: "jalali" }, key), /explicit UI confirmation/);
  f.setCalendarAvailable(false);
  await assert.rejects(f.runtime.configure({ calendar: "jalali" }, key, { confirmCalendarChange: true }), /Persian Calendar API unavailable/);
  assert.equal(f.runtime.getStatus().calendar, "gregorian");
  assert.equal(f.pages().size, 4);
});

test("autoOpen false verifies fresh setup and reload without writes or panes; explicit Show navigates", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  await f.runtime.configure({ autoOpen: false }, first.graphKey);
  const enabled = await f.runtime.enable(first.graphKey);
  assert.equal(enabled.initialization, "verified");
  assert.equal(enabled.onboarding, "completed");
  assert.equal(exampleRecord(f).completed, true);
  assert.equal(namedCalls(f, "sidebar").length, 0);
  const weekly = f.pages().get(currentPeriods(f).weekly.pageName);
  contentBlocks(weekly)[0].children[0].content = "DONE preserved after reload";
  const before = clone([...f.pages()]);
  const records = clone([...f.records]);
  const effects = clone(graphEffects(f));
  await f.runtime.destroy();
  const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
  const status = await reloaded.start();
  assert.equal(status.initialization, "verified");
  assert.equal(status.autoOpen, false);
  assert.equal(status.error, null);
  await reloaded.refreshStatus();
  assert.deepEqual([...f.records], records);
  assert.deepEqual([...f.pages()], before);
  assert.deepEqual(graphEffects(f), effects);
  await reloaded.showCurrent();
  assert.equal(namedCalls(f, "sidebar").length, 2);
  assert.deepEqual([...f.pages()], before);
  assert.deepEqual(graphEffects(f).filter((call) => call[0] !== "sidebar"), effects);
});

test("saved enabled graph settings reload without initialization migration or content edits", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const graphKey = f.runtime.getStatus().graphKey;
  await f.runtime.configure({ autoOpen: false }, graphKey);
  const settingsKey = [...f.records.keys()].find((key) => key.includes("routines:v1:"));
  delete f.records.get(settingsKey).onboarding;
  f.records.delete(initializationKey(graphKey));
  const weekly = f.pages().get(currentPeriods(f).weekly.pageName);
  contentBlocks(weekly)[0].content = "User-owned edited summary";
  const before = clone([...f.pages()]);
  const records = clone([...f.records]);
  const effects = clone(graphEffects(f));
  const saves = namedCalls(f, "storage.set").length;
  await f.runtime.destroy();
  const reloaded = f.newRuntime(); t.after(() => reloaded.destroy());
  const status = await reloaded.start();
  assert.equal(status.enabled, true);
  assert.equal(status.onboarding, "completed");
  assert.equal(status.initialization, null);
  assert.equal(status.error, null);
  await reloaded.refreshStatus();
  await reloaded.enable(graphKey);
  assert.deepEqual([...f.records], records);
  assert.equal(namedCalls(f, "storage.set").length, saves);
  assert.deepEqual([...f.pages()], before);
  assert.deepEqual(graphEffects(f), effects);
});

test("auto-open suppression, on-demand history, definition selection and no idle queries", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  await f.runtime.configure({ autoOpen: false, definitions: { weekly: "Selected weekly source" } }, f.runtime.getStatus().graphKey);
  await f.runtime.enable();
  assert.equal(namedCalls(f, "sidebar").length, 0);
  await f.runtime.showCurrent();
  assert.equal(namedCalls(f, "sidebar").length, 2);
  const before = namedCalls(f, "query").length;
  assert.equal(before, 0);
  assert.equal((await f.runtime.showHistory()).pageName, HISTORY_PAGE);
  assert.equal(namedCalls(f, "query").length, 0);
  assert.deepEqual(contentBlocks(f.pages().get(HISTORY_PAGE)).map((block) => block.content), [historyQuery("weekly"), historyQuery("monthly")]);
  assert.deepEqual(namedCalls(f, "route").at(-1), ["route", "page", { name: HISTORY_PAGE }]);
  await f.runtime.openDefinition("weekly");
  assert.deepEqual(namedCalls(f, "route").at(-1), ["route", "page", { name: "Selected weekly source" }]);
});

test("in-flight create does not continue writing when graph switches", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const created = new Promise((resolve) => { entered = resolve; });
  f.afterCreate(async (name) => { if (name === currentPeriods(f).weekly.pageName) { entered(); await waiting; } });
  const activation = f.runtime.enable();
  await created;
  f.switchGraph("/graph/b");
  release();
  await assert.rejects(activation, /cancelled|Graph changed/);
  assert.equal(namedCalls(f, "insertBlock").length, 0);
  assert.equal(namedCalls(f, "sidebar").length, 0);
});

test("reload reuses completed pages without resetting edits; manual closure is respected on resume", async (t) => {
  const f = fixture();
  await f.runtime.start();
  await f.runtime.enable();
  const page = f.pages().get(currentPeriods(f).weekly.pageName);
  const creationCount = namedCalls(f, "createPage").length;
  const firstSidebar = namedCalls(f, "sidebar").length;
  // A visibility/resume check sees the same period but must not reopen a closed pane.
  await f.runtime.start();
  assert.equal(namedCalls(f, "sidebar").length, firstSidebar);
  await f.runtime.destroy();
  const restarted = f.newRuntime();
  t.after(() => restarted.destroy());
  await restarted.start();
  assert.equal(namedCalls(f, "createPage").length, creationCount);
  assert.equal(headerOf(f.pages().get(page.name)).properties["jr-snapshot-state"], "populated");
});

test("a marker written before ambiguous creation prevents repeated automatic creation", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  let failed = false;
  f.afterCreate(async (name) => {
    if (!failed && name === currentPeriods(f).weekly.pageName) { failed = true; throw new Error("lost acknowledgement"); }
  });
  await assert.rejects(f.runtime.enable(), /ambiguous/);
  const name = currentPeriods(f).weekly.pageName;
  assert.ok(f.pages().has(name));
  f.pages().delete(name);
  const effects = clone(graphEffects(f));
  await assert.rejects(f.runtime.showCurrent(), /initialization is unfinished/i);
  assert.equal(f.pages().has(name), false);
  assert.deepEqual(graphEffects(f), effects);
  await assert.rejects(f.runtime.enable(), /Previously attempted period is unavailable/);
  assert.equal(f.pages().has(name), false);
  assert.deepEqual(graphEffects(f), effects);
});

test("an emptied graph path retains activation and creation evidence without claiming proven deletion", async (t) => {
  const f = fixture();
  await f.runtime.start(); await f.runtime.enable();
  const key = f.runtime.getStatus().graphKey;
  await f.runtime.destroy();
  f.pages().clear();
  const writes = namedCalls(f, "createPage").length;
  const restarted = f.newRuntime(); t.after(() => restarted.destroy());
  const status = await restarted.start();
  assert.equal(status.graphKey, key);
  assert.equal(status.enabled, true);
  assert.match(status.error, /Reusing an emptied graph folder retains this record/);
  assert.doesNotMatch(status.error, /preserved as deleted/);
  assert.equal(namedCalls(f, "createPage").length, writes);
  assert.equal(f.pages().size, 0);
});

test("queued Disable does not disable another graph", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start(); await f.runtime.enable();
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  const oldGet = f.sdk.Editor.getPage;
  f.sdk.Editor.getPage = async (...args) => {
    if (args[0] === currentPeriods(f).weekly.pageName) { entered(); await waiting; }
    return oldGet(...args);
  };
  const work = f.runtime.showCurrent();
  await reached;
  const disable = f.runtime.disable();
  f.switchGraph("/graph/b");
  release();
  await assert.rejects(work, /cancelled|Graph changed/);
  await assert.rejects(disable, /cancelled|Graph changed/);
  assert.equal(f.pages().size, 0);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function blockRead(f) {
  const entered = deferred(), release = deferred();
  const original = f.sdk.Editor.getPage;
  let once = true;
  f.sdk.Editor.getPage = async (...args) => {
    if (once) { once = false; entered.resolve(); await release.promise; }
    return original(...args);
  };
  const work = f.runtime.showCurrent();
  void work.catch(() => {});
  await entered.promise;
  return { work, release: release.resolve };
}

test("status reads actual stable graph identity and settings without writes, commands or initialization", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const first = await f.runtime.start();
  assert.equal(first.graphName, "Same display name");
  assert.equal(namedCalls(f, "command").length, 0);
  await f.runtime.configure({ autoOpen: false, definitions: { weekly: "Weekly source", monthly: "Monthly source" } }, first.graphKey);
  assert.equal(f.pages().size, 0);
  assert.equal(f.timerTasks.size, 0);
  const settingsKey = [...f.records.keys()].find((key) => key.includes("routines:v1:"));
  f.records.get(settingsKey).enabled = true;
  const writes = namedCalls(f, "storage.set").length;
  f.setGraphName("Renamed graph");
  const renamed = await f.runtime.refreshStatus();
  assert.equal(renamed.graphName, "Renamed graph");
  assert.equal(renamed.graphKey, first.graphKey);
  assert.equal(renamed.enabled, true);
  assert.equal(f.pages().size, 0);
  assert.equal(namedCalls(f, "storage.set").length, writes);
  f.switchGraph("/graph/b", false);
  const second = await f.runtime.refreshStatus();
  assert.notEqual(second.graphKey, first.graphKey);
  assert.equal(second.enabled, false);
  await assert.rejects(f.runtime.configure({ autoOpen: true }, first.graphKey), /Graph changed/);
  await assert.rejects(f.runtime.enable(first.graphKey), /Graph changed/);
  assert.equal(namedCalls(f, "storage.set").length, writes);
  assert.equal(f.pages().size, 0);
});

test("configure validates all options before saving and rejects enabled definition changes", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const { graphKey } = await f.runtime.start();
  await assert.rejects(f.runtime.configure({ autoOpen: "yes" }, graphKey), /Invalid/);
  await assert.rejects(f.runtime.configure({ definitions: null }, graphKey), /weekly\/monthly/);
  await assert.rejects(f.runtime.configure({ definitions: [] }, graphKey), /weekly\/monthly/);
  await assert.rejects(f.runtime.configure({ enabled: true }, graphKey), /Expected/);
  await assert.rejects(f.runtime.configure({ definitions: { weekly: "Same", monthly: "same" } }, graphKey), /distinct/);
  assert.equal(namedCalls(f, "storage.set").length, 0);
  await f.runtime.configure({ autoOpen: false }, graphKey);
  await f.runtime.enable(graphKey);
  const before = clone([...f.pages()]);
  const sidebarCount = namedCalls(f, "sidebar").length;
  await assert.rejects(f.runtime.configure({ definitions: { weekly: "Other" } }, graphKey), /Disable before/);
  await f.runtime.configure({ autoOpen: true }, graphKey);
  assert.deepEqual([...f.pages()], before);
  assert.equal(namedCalls(f, "sidebar").length, sidebarCount);
});

test("Gregorian never invokes Calendar; confirmed Jalali switching and back reuse edited snapshots", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const { graphKey } = await f.runtime.start();
  f.setCalendarAvailable(false);
  await f.runtime.enable(graphKey);
  assert.equal(namedCalls(f, "calendar").length, 0);
  const originalName = currentPeriods(f).weekly.pageName;
  const original = f.pages().get(originalName);
  original.blocks.push({ id: 999, uuid: uuid(999), content: "DONE user task", children: [],
    page: { id: original.id }, parent: { id: original.id }, left: { id: headerOf(original).id } });
  f.setCalendarAvailable(true);
  await f.runtime.configure({ calendar: "jalali" }, graphKey, { confirmCalendarChange: true });
  assert.equal(f.pages().size, 4, "configuration does not initialize periods");
  await f.runtime.enable(graphKey);
  const jalali = makePeriod({ calendar: "jalali", kind: "weekly", ...CALENDAR_DATE.week,
    pageName: "هفتهٔ ۱ · ۱۴۰۵ — 2026-03-21" });
  assert.ok(f.pages().has(jalali.pageName));
  assert.equal(contentBlocks(f.pages().get(jalali.pageName))[0].content, "\u200B");
  const jalaliMonth = makePeriod({ calendar: "jalali", kind: "monthly", ...CALENDAR_DATE.month,
    pageName: "فروردین ۱۴۰۵ — 2026-03-21" });
  assert.equal(contentBlocks(f.pages().get(jalaliMonth.pageName))[0].content, "\u200B");
  const sidebarStyle = namedCalls(f, "style").at(-1)[1];
  assert.equal(sidebarStyle.key, "jr-sidebar-roots");
  assert.ok(sidebarStyle.style.includes('::before { content: "هفتهٔ ۱"; font-size: 1rem;'));
  assert.ok(sidebarStyle.style.includes('::before { content: "فروردین"; font-size: 1rem;'));
  assert.ok(sidebarStyle.style.includes('::after { content: "۱ فروردین – ۷ فروردین"; font-size: 0.8rem;'));
  assert.ok(sidebarStyle.style.includes('::after { content: "Mar 21 – Apr 20"; font-size: 0.8rem;'));
  assert.ok(sidebarStyle.style.includes("flex-direction: column; align-items: stretch"));
  assert.ok(sidebarStyle.style.includes("opacity: 0.75; direction: rtl;"));
  assert.ok(sidebarStyle.style.includes("opacity: 0.75; direction: ltr;"));
  assert.ok(sidebarStyle.style.includes("unicode-bidi: isolate; text-align: right"));
  assert.equal(f.pages().size, 6);
  const saved = clone([...f.pages()]);
  await f.runtime.configure({ calendar: "gregorian" }, graphKey, { confirmCalendarChange: true });
  await f.runtime.enable(graphKey);
  assert.deepEqual([...f.pages()], saved);
  await f.runtime.configure({ calendar: "jalali" }, graphKey, { confirmCalendarChange: true });
  await f.runtime.enable(graphKey);
  assert.deepEqual([...f.pages()], saved);
  f.setCalendarAvailable(false);
  const creates = namedCalls(f, "createPage").length;
  await assert.rejects(f.runtime.showCurrent(), /Persian Calendar API unavailable/);
  await assert.rejects(f.runtime.showCurrent(), /Persian Calendar API unavailable/);
  assert.equal(namedCalls(f, "message").filter((call) => call[1].includes("API unavailable")).length, 1);
  await f.runtime.showHistory();
  assert.equal(namedCalls(f, "createPage").length, creates + 1, "history works without Calendar");
  assert.equal(f.runtime.getStatus().calendar, "jalali");
});

test("day timer and visibility/resume coalesce; month rollover preserves the spanning week and missed periods are not backfilled", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  f.setDate(new Date(2026, 2, 31, 23, 59, 50));
  await f.runtime.start(); await f.runtime.enable();
  const week = currentPeriods(f).weekly.pageName;
  assert.equal([...f.timerTasks.values()][0].delay, 11000);
  const reads = namedCalls(f, "getPage").length;
  f.emit(); f.emit("resume"); f.emit();
  await f.runtime.refreshStatus();
  assert.equal(namedCalls(f, "getPage").length, reads);
  assert.equal(namedCalls(f, "sidebar").length, 2);
  f.setDate(new Date(2026, 3, 1, 0, 0, 2));
  f.fireTimer(); f.emit(); f.emit("resume");
  await f.runtime.refreshStatus();
  assert.equal(f.pages().size, 5);
  assert.ok(f.pages().has(week));
  assert.equal(namedCalls(f, "sidebar").length, 3, "only new month opens");
  assert.equal(f.timerTasks.size, 1);
  assert.equal(f.documentListeners.get("visibilitychange").size, 1);
  f.setDate(new Date(2026, 5, 15, 9));
  f.emit("resume"); f.fireTimer(); f.emit();
  await f.runtime.refreshStatus();
  assert.equal(f.pages().size, 7, "only current week/month created after long sleep");
  assert.equal(namedCalls(f, "sidebar").length, 5);
  assert.equal(namedCalls(f, "query").length, 0);
  await f.runtime.disable();
  assert.equal(f.timerTasks.size, 0);
  assert.equal(f.documentListeners.get("visibilitychange").size, 0);
  assert.equal(f.documentListeners.get("resume").size, 0);
});

for (const notify of [true, false]) {
  test(`queued actions capture graph at request, including without graph event (${notify})`, async (t) => {
    const f = fixture(); t.after(() => f.runtime.destroy());
    await f.runtime.start(); await f.runtime.enable();
    const blocked = await blockRead(f);
    const actions = [f.runtime.enable(), f.runtime.configure({ autoOpen: false }),
      f.runtime.openDefinition("weekly"), f.runtime.showHistory(), f.runtime.showCurrent()];
    const settled = Promise.allSettled([blocked.work, ...actions]);
    f.switchGraph("/graph/b", notify);
    blocked.release();
    assert.ok((await settled).every((result) => result.status === "rejected"));
    await f.runtime.refreshStatus();
    assert.equal(f.pages().size, 0);
    assert.equal(namedCalls(f, "route").length, 0);
    assert.equal(namedCalls(f, "storage.set").filter((call) => call[1] === "/graph/b").length, 0);
  });
}

test("Disable cancels immediately; failed persistence remains stopped after status refresh and graph return", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start(); await f.runtime.enable();
  const blocked = await blockRead(f);
  const oldSet = f.storage.set;
  f.storage.set = async (key, value) => {
    if (value?.enabled === false) throw new Error("disk unavailable");
    return oldSet(key, value);
  };
  const disabled = f.runtime.disable();
  const results = Promise.allSettled([blocked.work, disabled]);
  assert.equal(f.runtime.getStatus().enabled, false, "Disable is effective before any await");
  assert.equal(f.timerTasks.size, 0);
  blocked.release();
  const outcomes = await results;
  assert.match(outcomes[0].reason.message, /cancelled/);
  assert.match(outcomes[1].reason.message, /disk unavailable/);
  assert.equal((await f.runtime.refreshStatus()).enabled, false);
  assert.equal(f.runtime.getStatus().paused, true);
  const creates = namedCalls(f, "createPage").length;
  f.setDate(new Date(2026, 3, 20));
  f.emit(); f.emit("resume");
  await f.runtime.showCurrent();
  f.switchGraph("/graph/b"); await f.runtime.refreshStatus();
  f.switchGraph("/graph/a"); await f.runtime.refreshStatus();
  assert.equal(f.runtime.getStatus().enabled, false);
  assert.equal(f.timerTasks.size, 0);
  assert.equal(namedCalls(f, "createPage").length, creates);
  f.storage.set = oldSet;
  await f.runtime.enable();
  assert.equal(f.runtime.getStatus().enabled, true);
});

test("reload preserves deliberate period deletion rather than reconstructing from definitions", async (t) => {
  const f = fixture();
  await f.runtime.start(); await f.runtime.enable();
  const name = currentPeriods(f).weekly.pageName;
  f.pages().delete(name);
  await f.runtime.destroy();
  const runtime = f.newRuntime(); t.after(() => runtime.destroy());
  const writes = namedCalls(f, "createPage").length;
  assert.match((await runtime.start()).error, /Previously attempted period is unavailable/);
  assert.equal(namedCalls(f, "createPage").length, writes);
  assert.equal(f.pages().has(name), false);
});

test("history is native/on demand and preserves edited or deleted query blocks across reload", async (t) => {
  const f = fixture();
  await f.runtime.start();
  assert.equal(f.pages().size, 0);
  await f.runtime.showHistory();
  assert.equal(f.pages().size, 1, "disabled history creates no definitions or periods");
  const page = f.pages().get(HISTORY_PAGE);
  contentBlocks(page)[0].content = "My edited history query";
  page.blocks.pop();
  const snapshot = clone(page);
  const inserts = namedCalls(f, "insertBlock").length;
  await f.runtime.showHistory();
  assert.deepEqual(page, snapshot);
  await f.runtime.destroy();
  const runtime = f.newRuntime(); t.after(() => runtime.destroy());
  await runtime.start();
  await runtime.showHistory();
  assert.equal(namedCalls(f, "insertBlock").length, inserts);
  assert.deepEqual(page, snapshot);
  page.blocks = [headerOf(page)];
  await runtime.showHistory();
  assert.equal(contentBlocks(page).length, 0);
  f.pages().delete(HISTORY_PAGE);
  await assert.rejects(runtime.showHistory(), /preserved as deleted/);
  assert.equal(f.pages().has(HISTORY_PAGE), false);
  assert.equal(namedCalls(f, "query").length, 0);
});

test("same-name history collision is never adopted or overwritten", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  const page = { uuid: uuid(1), id: 1, properties: {}, blocks: [{ content: "user notes" }] };
  f.pages().set(HISTORY_PAGE, page);
  await assert.rejects(f.runtime.showHistory(), /ownership collision/);
  assert.equal(namedCalls(f, "insertBlock").length, 0);
  assert.equal(namedCalls(f, "storage.set").length, 0);
  assert.equal(page.blocks[0].content, "user notes");
});

for (const phase of ["page", "bootstrap", "metadata", "block", "completion"]) {
  test(`ambiguous history ${phase} write pauses across reload without repeated population`, async (t) => {
    const f = fixture();
    await f.runtime.start();
    if (phase === "page") f.afterCreate(() => { throw new Error("lost page acknowledgement"); });
    if (phase === "bootstrap" || phase === "block") {
      const insert = f.sdk.Editor.insertBlock;
      f.sdk.Editor.insertBlock = async (...args) => {
        const block = await insert(...args);
        if (phase === "bootstrap" || args[1] === historyQuery("weekly")) throw new Error(`lost ${phase} acknowledgement`);
        return block;
      };
    }
    if (phase === "metadata") {
      const update = f.sdk.Editor.updateBlock;
      f.sdk.Editor.updateBlock = async (...args) => { await update(...args); throw new Error("lost metadata acknowledgement"); };
    }
    if (phase === "completion") f.sdk.Editor.upsertBlockProperty = async () => {};
    await assert.rejects(f.runtime.showHistory(), /ambiguous|acknowledgement/);
    const inserts = namedCalls(f, "insertBlock").length;
    assert.equal(inserts, { page: 0, bootstrap: 1, metadata: 1, block: 2, completion: 3 }[phase]);
    const updates = namedCalls(f, "updateBlock").length;
    const creates = namedCalls(f, "createPage").length;
    const page = clone(f.pages().get(HISTORY_PAGE));
    await f.runtime.destroy();
    const runtime = f.newRuntime(); t.after(() => runtime.destroy());
    await runtime.start();
    await assert.rejects(runtime.showHistory(), ["page", "bootstrap"].includes(phase) ? /ownership collision/ : /incomplete or ambiguous/);
    assert.deepEqual(f.pages().get(HISTORY_PAGE), page);
    assert.equal(namedCalls(f, "insertBlock").length, inserts);
    assert.equal(namedCalls(f, "updateBlock").length, updates);
    assert.equal(namedCalls(f, "createPage").length, creates);
    assert.equal(namedCalls(f, "route").length, 0);
  });
}

test("graph change during history creation prevents block writes and navigation in the new graph", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  const entered = deferred(), release = deferred();
  f.afterCreate(async () => { entered.resolve(); await release.promise; });
  const work = f.runtime.showHistory();
  const rejected = assert.rejects(work, /cancelled|Graph changed/);
  await entered.promise;
  f.switchGraph("/graph/b"); release.resolve();
  await rejected; await f.runtime.refreshStatus();
  assert.equal(f.pages().size, 0);
  assert.equal(namedCalls(f, "insertBlock").length, 0);
  assert.equal(namedCalls(f, "route").length, 0);
});

test("graph change during Calendar info prevents the subsequent describeDate SDK operation", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const { graphKey } = await f.runtime.start();
  const invoke = f.sdk.App.invokeExternalPlugin;
  f.sdk.App.invokeExternalPlugin = async (...args) => {
    const value = await invoke(...args);
    f.switchGraph("/graph/b", false);
    return value;
  };
  await assert.rejects(f.runtime.configure({ calendar: "jalali" }, graphKey, { confirmCalendarChange: true }), /Graph changed/);
  assert.equal(namedCalls(f, "calendar").length, 1);
  assert.equal(namedCalls(f, "storage.set").length, 0);
});

test("a burst of automatic triggers is exactly one refresh, not several queued no-op refreshes", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start(); await f.runtime.enable();
  let before = namedCalls(f, "graph").length;
  f.emit(); await f.runtime.refreshStatus();
  const single = namedCalls(f, "graph").length - before;
  before = namedCalls(f, "graph").length;
  for (let i = 0; i < 20; i++) { f.emit(); f.emit("resume"); }
  await f.runtime.refreshStatus();
  assert.equal(namedCalls(f, "graph").length - before, single);
});

test("rollover during an in-flight automatic refresh retains one trailing day check", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  f.setDate(new Date(2026, 2, 29, 12));
  await f.runtime.start(); await f.runtime.enable();
  const entered = deferred(), release = deferred();
  let once = true;
  f.afterCreate(async () => { if (once) { once = false; entered.resolve(); await release.promise; } });
  f.setDate(new Date(2026, 2, 30, 23, 59));
  f.emit();
  await entered.promise;
  f.setDate(new Date(2026, 3, 1, 1));
  f.emit("resume"); f.emit();
  release.resolve();
  // The trailing request joins after the in-flight request completes.
  await f.runtime.refreshStatus(); await f.runtime.refreshStatus();
  assert.ok(f.pages().has(currentPeriods(f).monthly.pageName));
  assert.equal(f.pages().size, 6);
  assert.equal(f.timerTasks.size, 1);
});

test("unload cancels in-flight work and queued navigation without clearing native panes", async () => {
  const f = fixture();
  await f.runtime.start(); await f.runtime.enable();
  const blocked = await blockRead(f);
  const queued = f.runtime.showHistory();
  const outcomes = Promise.allSettled([blocked.work, queued]);
  await f.runtime.destroy();
  blocked.release();
  assert.ok((await outcomes).every((item) => item.status === "rejected"));
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timerTasks.size, 0);
  assert.equal(f.documentListeners.get("visibilitychange").size, 0);
  assert.equal(namedCalls(f, "route").length, 0);
  assert.equal(f.pages().size, 4);
});

test("legacy exact page names are reused without creating localized duplicates or resetting edits", async (t) => {
  const f = fixture();
  await enableEmpty(f);
  const names = [];
  for (const period of Object.values(currentPeriods(f))) {
    const legacy = makePeriod({ calendar: period.calendar, kind: period.kind, start: period.start, end: period.end }).pageName;
    const page = f.pages().get(period.pageName);
    f.pages().delete(period.pageName);
    page.name = legacy;
    f.pages().set(legacy, page);
    const marker = [...f.records.keys()].find((key) => key.includes("period-seen") && key.endsWith(`:${period.id}`));
    assert.ok(marker);
    f.records.set(marker, true);
    names.push(legacy);
  }
  const weekly = f.pages().get(names[0]);
  contentBlocks(weekly)[0].content = "My edited legacy summary";
  const creates = namedCalls(f, "createPage").length;
  const inserts = namedCalls(f, "insertBlock").length;
  await f.runtime.showCurrent();
  assert.ok(names.every((name) => f.pages().has(name)));
  assert.ok(Object.values(currentPeriods(f)).every((period) => !f.pages().has(period.pageName)));
  assert.equal(contentBlocks(weekly)[0].content, "My edited legacy summary");
  assert.equal(namedCalls(f, "createPage").length, creates);
  assert.equal(namedCalls(f, "insertBlock").length, inserts);
  await f.runtime.destroy();
  const restarted = f.newRuntime(); t.after(() => restarted.destroy());
  await restarted.start();
  assert.equal(namedCalls(f, "createPage").length, creates);
  f.pages().delete(names[0]);
  await assert.rejects(restarted.showCurrent(), /Previously attempted period is unavailable/);
  assert.equal(f.pages().has(names[0]), false);
});

for (const [calendar, expected] of Object.entries({
  gregorian: { weekly: ["TODO Plan the week", "TODO Review the week"], monthly: ["TODO Set monthly goals", "TODO Review monthly progress"] },
  jalali: { weekly: ["TODO برنامه‌ریزی هفته", "TODO مرور کارهای هفته"], monthly: ["TODO تعیین هدف‌های ماه", "TODO مرور پیشرفت ماه"] },
})) {
  test(`fresh ${calendar} setup seeds appropriate starter content`, async (t) => {
    const f = fixture(); t.after(() => f.runtime.destroy());
    const status = await f.runtime.start();
    if (calendar === "jalali") await f.runtime.configure({ calendar }, status.graphKey, { confirmCalendarChange: true });
    await f.runtime.enable(status.graphKey);
    for (const kind of ["weekly", "monthly"]) {
      const definition = f.pages().get(f.runtime.getStatus().definitions[kind]);
      assert.deepEqual(contentBlocks(definition).map((block) => block.content), expected[kind]);
      const period = [...f.pages().values()].find((page) => page.properties["jr-kind"] === kind);
      assert.deepEqual(contentBlocks(period)[0].children.map((block) => block.content), expected[kind]);
    }
    assert.equal(namedCalls(f, "calendar").length > 0, calendar === "jalali");
  });
}

for (const [day, week, range] of [
  ["2026-07-15", 29, "Jul 13–Jul 19"], ["2026-10-05", 41, "Oct 5–Oct 11"],
  ["2021-01-01", 53, "Dec 28–Jan 3"], ["2021-01-04", 1, "Jan 4–Jan 10"],
  ["2024-12-30", 1, "Dec 30–Jan 5"],
]) {
  test(`Gregorian sidebar shows ISO Week ${week} on ${day} without changing navigation or range`, async (t) => {
    const f = fixture(); t.after(() => f.runtime.destroy());
    f.setDate(new Date(`${day}T12:00:00`));
    await enableEmpty(f);
    const period = currentPeriods(f).weekly;
    const page = f.pages().get(period.pageName);
    assert.ok(page, "existing page-name format remains unchanged");
    const summary = contentBlocks(page)[0];
    assert.ok(namedCalls(f, "sidebar").some((call) => call[2] === summary.uuid), "native summary navigation retained");
    const style = namedCalls(f, "style").filter((call) => call[1].key === "jr-sidebar-roots").at(-1)[1].style;
    assert.ok(style.includes(`::before { content: "Week ${week} · ${range}";`));
    assert.equal(page.properties["jr-start"], period.start);
    assert.equal(page.properties["jr-end"], period.end);
    assert.equal(namedCalls(f, "calendar").length, 0);
    const before = clone([...f.pages()]);
    await f.runtime.showCurrent();
    assert.deepEqual([...f.pages()], before, "caption changes never rewrite graph content");
  });
}

test("fresh default definitions do not auto-seed an existing current snapshot", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  const definitions = f.runtime.getStatus().definitions;
  for (const name of Object.values(definitions)) f.pages().delete(name);
  await f.runtime.disable(key);
  const inserts = namedCalls(f, "insertBlock").length;
  await f.runtime.enable(key);
  assert.equal(namedCalls(f, "insertBlock").length, inserts);
  for (const name of Object.values(definitions)) assert.deepEqual(contentBlocks(f.pages().get(name)), []);
  for (const period of Object.values(currentPeriods(f))) {
    assert.deepEqual(contentBlocks(f.pages().get(period.pageName))[0].children, []);
  }
});

test("a localized name collision never overwrites an unrelated page or seeds it", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  const name = currentPeriods(f).weekly.pageName;
  const unrelated = { uuid: uuid(999), id: 999, name, properties: {}, format: "markdown", blocks: [
    { uuid: uuid(998), id: 998, content: "User note", children: [] },
  ] };
  f.pages().set(name, unrelated);
  await assert.rejects(f.runtime.enable(), /ownership collision/);
  assert.equal(f.pages().get(name), unrelated);
  assert.equal(unrelated.blocks[0].content, "User note");
  assert.equal(namedCalls(f, "insertBlock").length, 0);
});

test("a changed provider label reuses the stored civil-period page, not a duplicate", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  const key = f.runtime.getStatus().graphKey;
  await f.runtime.configure({ calendar: "jalali" }, key, { confirmCalendarChange: true });
  await f.runtime.enable(key);
  const weekly = [...f.pages().values()].find((page) => page.properties["jr-kind"] === "weekly");
  assert.ok(weekly.name.startsWith("هفتهٔ ۱"));
  const original = f.sdk.App.invokeExternalPlugin;
  f.sdk.App.invokeExternalPlugin = async (...args) => {
    const response = await original(...args);
    if (args[0] === "persian-calendar.models.describeDate") response.persian.weekOfYear = 2;
    return response;
  };
  const before = namedCalls(f, "createPage").length;
  await f.runtime.showCurrent(key);
  assert.equal(namedCalls(f, "createPage").length, before);
  assert.equal([...f.pages().values()].filter((page) => page.properties["jr-kind"] === "weekly").length, 1);
  assert.equal(contentBlocks(weekly)[0].children.length, 2);
});

// Model v1 snapshot plans on otherwise empty current pages.
async function oldEmptyPeriods(f) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[]"));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  for (const period of Object.values(currentPeriods(f))) {
    const page = f.pages().get(period.pageName);
    page.blocks.splice(1);
    page.properties["jr-snapshot-plan"] = JSON.stringify({ version: 1, hash, ids: [] });
    const header = headerOf(page);
    header.properties["jr-snapshot-plan"] = page.properties["jr-snapshot-plan"];
    header.properties["jr-snapshot-state"] = "empty";
    header.content = propertyContent(header.properties);
  }
}

test("existing empty default definitions are not auto-seeded; explicit examples stay graph-pinned and repeat-safe", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  const periods = currentPeriods(f);
  const snapshotInserts = namedCalls(f, "insertBlock").length;
  assert.equal(snapshotInserts, 4, "Two metadata bootstraps plus two planned summary roots");
  assert.equal(namedCalls(f, "updateBlock").length, 2, "Each bootstrap becomes a metadata header");
  assert.ok(Object.values(periods).every((period) => contentBlocks(f.pages().get(period.pageName)).length === 1));
  assert.ok(["weekly", "monthly"].every((kind) => contentBlocks(f.pages().get(f.runtime.getStatus().definitions[kind])).length === 0));
  await assert.rejects(f.runtime.addExamples(), /graph key/);
  await assert.rejects(f.runtime.addExamples("wrong graph"), /Graph changed since setup/);
  assert.equal(namedCalls(f, "insertBlock").length, snapshotInserts);
  const seeded = await f.runtime.addExamples(key);
  assert.equal(seeded.graphKey, key);
  assert.equal(seeded.inserted, 8);
  for (const kind of ["weekly", "monthly"]) {
    const period = f.pages().get(periods[kind].pageName);
    const definition = f.pages().get(f.runtime.getStatus().definitions[kind]);
    assert.equal(headerOf(period).properties["jr-snapshot-state"], "populated");
    const plan = JSON.parse(period.properties["jr-snapshot-plan"]);
    const [summary] = contentBlocks(period);
    assert.deepEqual(plan.ids, [summary.uuid]);
    assert.equal(summary.content, plan.displayTitle);
    assert.equal(seeded.viewBlockIds[kind], summary.uuid);
    const sample = summary.children.map((block) => block.content);
    assert.equal(sample.length, 2);
    assert.deepEqual(sample, kind === "weekly"
      ? ["TODO Plan the week", "TODO Review the week"] : ["TODO Set monthly goals", "TODO Review monthly progress"]);
    assert.deepEqual(contentBlocks(definition).map((block) => block.content), sample);
    assert.notDeepEqual(summary.children.map((block) => block.uuid), contentBlocks(definition).map((block) => block.uuid));
  }
  const inserts = namedCalls(f, "insertBlock").length;
  assert.deepEqual(await f.runtime.addExamples(key), { ...seeded, inserted: 0 });
  assert.equal(namedCalls(f, "insertBlock").length, inserts);
  await f.runtime.destroy();
  const restarted = f.newRuntime(); t.after(() => restarted.destroy());
  await restarted.start();
  assert.equal((await restarted.addExamples(key)).inserted, 0);
  assert.equal(namedCalls(f, "insertBlock").length, inserts);
});

test("v1 empty periods get a marker-discoverable summary and nested examples only on explicit request", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  await oldEmptyPeriods(f);
  const key = f.runtime.getStatus().graphKey;
  const before = namedCalls(f, "insertBlock").length;
  const result = await f.runtime.addExamples(key);
  assert.equal(result.inserted, 10);
  assert.equal(namedCalls(f, "insertBlock").length, before + 10);
  const markerKey = [...f.records.keys()].find((item) => item.startsWith("journal-routines:examples:v1:"));
  const marker = f.records.get(markerKey);
  for (const [index, kind] of ["weekly", "monthly"].entries()) {
    const page = f.pages().get(currentPeriods(f)[kind].pageName);
    const [root] = contentBlocks(page);
    assert.equal(marker.pages[index].viewBlockId, root.uuid);
    assert.equal(result.viewBlockIds[kind], root.uuid);
    assert.equal(marker.attempted[index], 3);
    assert.deepEqual(marker.pages[index].ids, [root.uuid, ...root.children.map((block) => block.uuid)]);
    assert.equal(root.parent.id, page.id);
    assert.equal(root.left.id, headerOf(page).id);
    assert.equal(root.children.length, 2);
    assert.ok(root.children.every((block) => block.parent.id === root.id && block.content.startsWith("TODO ")));
    assert.deepEqual(JSON.parse(page.properties["jr-snapshot-plan"]).ids, []);
    assert.equal(headerOf(page).properties["jr-snapshot-state"], "empty");
  }
  assert.equal((await f.runtime.addExamples(key)).inserted, 0);
  await f.runtime.showCurrent();
  assert.deepEqual(namedCalls(f, "sidebar").slice(-2).map((call) => call[2]),
    [result.viewBlockIds.monthly, result.viewBlockIds.weekly], "old pages open summary blocks in weekly-first display order");
  await f.runtime.destroy();
  const restarted = f.newRuntime(); t.after(() => restarted.destroy());
  await restarted.start();
  assert.deepEqual(await restarted.addExamples(key), { ...result, inserted: 0 });
  assert.equal(namedCalls(f, "insertBlock").length, before + 10);
});

test("v1 interrupted root retries only unchanged roots and never recreates deleted summaries", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f); await oldEmptyPeriods(f);
  const key = f.runtime.getStatus().graphKey, before = namedCalls(f, "insertBlock").length;
  const insert = f.sdk.Editor.insertBlock;
  let lost = true;
  f.sdk.Editor.insertBlock = async (...args) => {
    const block = await insert(...args);
    if (lost) { lost = false; throw new Error("lost root acknowledgement"); }
    return block;
  };
  await assert.rejects(f.runtime.addExamples(key), /lost root acknowledgement/);
  assert.equal(contentBlocks(f.pages().get(currentPeriods(f).weekly.pageName)).length, 1);
  assert.equal((await f.runtime.addExamples(key)).inserted, 9);
  assert.equal(namedCalls(f, "insertBlock").length, before + 10);
  f.pages().get(currentPeriods(f).weekly.pageName).blocks.splice(1);
  await assert.rejects(f.runtime.addExamples(key), /deleted or its write is ambiguous/);
  assert.equal(namedCalls(f, "insertBlock").length, before + 10);
});

test("both snapshot versions persist example intent and summary view ID before their first SDK write", async (t) => {
  for (const version of [1, 2]) {
    const f = fixture(); t.after(() => f.runtime.destroy());
    await enableEmpty(f);
    if (version === 1) await oldEmptyPeriods(f);
    const insert = f.sdk.Editor.insertBlock;
    let observed = false;
    f.sdk.Editor.insertBlock = async (...args) => {
      if (!observed) {
        observed = true;
        const key = [...f.records.keys()].find((item) => item.startsWith("journal-routines:examples:v1:"));
        const marker = f.records.get(key);
        assert.deepEqual(marker.attempted, [1, 0, 0, 0]);
        assert.equal(marker.completed, false);
        assert.equal(marker.pages[0].viewBlockId, version === 1 ? args[2].customUUID :
          contentBlocks(f.pages().get(currentPeriods(f).weekly.pageName))[0].uuid);
      }
      return insert(...args);
    };
    assert.equal((await f.runtime.addExamples(f.runtime.getStatus().graphKey)).inserted, version === 1 ? 10 : 8);
    assert.equal(observed, true);
    assert.equal(exampleRecord(f).completed, true);
  }
});

test("v2 planned summaries must be intact and match an empty-definition fingerprint before any writes", async (t) => {
  for (const fault of ["root-id", "root-title", "root-child", "root-missing", "hash", "plan-count", "state"]) {
    const f = fixture(); t.after(() => f.runtime.destroy());
    await enableEmpty(f);
    const page = f.pages().get(currentPeriods(f).monthly.pageName);
    const root = contentBlocks(page)[0];
    const plan = JSON.parse(page.properties["jr-snapshot-plan"]);
    if (fault === "root-id") root.uuid = uuid(997);
    if (fault === "root-title") root.content = "User-edited summary";
    if (fault === "root-child") root.children.push({ uuid: uuid(997), content: "TODO user" });
    if (fault === "root-missing") page.blocks.splice(1);
    if (fault === "hash") { plan.hash = "a".repeat(64); page.properties["jr-snapshot-plan"] = JSON.stringify(plan);
      headerOf(page).properties["jr-snapshot-plan"] = page.properties["jr-snapshot-plan"];
      headerOf(page).content = propertyContent(headerOf(page).properties); }
    if (fault === "plan-count") { plan.ids.push(uuid(997)); page.properties["jr-snapshot-plan"] = JSON.stringify(plan);
      headerOf(page).properties["jr-snapshot-plan"] = page.properties["jr-snapshot-plan"];
      headerOf(page).content = propertyContent(headerOf(page).properties); }
    if (fault === "state") { headerOf(page).properties["jr-snapshot-state"] = "empty";
      headerOf(page).content = propertyContent(headerOf(page).properties); }
    const before = namedCalls(f, "insertBlock").length;
    await assert.rejects(f.runtime.addExamples(f.runtime.getStatus().graphKey));
    assert.equal(namedCalls(f, "insertBlock").length, before, fault);
  }
});

test("examples use selected definition pages, not the default names", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  const key = f.runtime.getStatus().graphKey;
  await f.runtime.configure({ definitions: { weekly: "Custom weekly", monthly: "Custom monthly" } }, key);
  await f.runtime.enable(key);
  assert.equal(namedCalls(f, "insertBlock").length, 4, "Only two metadata bootstraps and two summary roots; custom definitions are not auto-seeded");
  assert.equal(contentBlocks(f.pages().get("Custom weekly")).length, 0);
  assert.equal(contentBlocks(f.pages().get("Custom monthly")).length, 0);
  assert.equal((await f.runtime.addExamples(key)).inserted, 8);
  assert.equal(contentBlocks(f.pages().get("Custom weekly")).length, 2);
  assert.equal(contentBlocks(f.pages().get("Custom monthly")).length, 2);
  assert.equal(f.pages().has("Journal & Routines — Weekly definition"), false);
});

test("examples preflight all four pages before any write and reject non-sample content", async (t) => {
  for (const kind of ["weekly", "monthly"]) {
    for (const type of ["period", "definition"]) {
      const f = fixture(); t.after(() => f.runtime.destroy());
      await enableEmpty(f);
      const key = f.runtime.getStatus().graphKey;
      const name = type === "period" ? currentPeriods(f)[kind].pageName : f.runtime.getStatus().definitions[kind];
      const page = f.pages().get(name);
      page.blocks.push({ id: 999, uuid: uuid(999), page: { id: page.id }, parent: { id: page.id },
        left: { id: headerOf(page)?.id ?? page.id }, content: "TODO existing user task", children: [] });
      const before = namedCalls(f, "insertBlock").length;
      await assert.rejects(f.runtime.addExamples(key), /content other than unchanged examples|Unexpected content/);
      assert.equal(namedCalls(f, "insertBlock").length, before, `${type} ${kind} was not overwritten`);
    }
  }
});

test("examples reject incomplete snapshots, malformed plans, missing definitions and edited retries", async (t) => {
  for (const change of ["state", "plan", "missing", "edit", "delete", "child", "reorder"]) {
    const f = fixture(); t.after(() => f.runtime.destroy());
    await enableEmpty(f);
    const key = f.runtime.getStatus().graphKey;
    const weekly = f.pages().get(currentPeriods(f).weekly.pageName);
    const definition = f.pages().get(f.runtime.getStatus().definitions.weekly);
    if (change === "state") {
      headerOf(weekly).properties["jr-snapshot-state"] = "ready:0";
      headerOf(weekly).content = propertyContent(headerOf(weekly).properties);
    } else if (change === "plan") {
      weekly.properties["jr-snapshot-plan"] = JSON.stringify({ version: 1, hash: "a".repeat(64), ids: [uuid(800)] });
    } else if (change === "missing") f.pages().delete(definition.name);
    else {
      await f.runtime.addExamples(key);
      const block = change === "reorder" ? contentBlocks(definition)[0] : contentBlocks(weekly)[0].children[0];
      if (change === "edit") block.content = "DONE changed by user";
      if (change === "delete") contentBlocks(weekly)[0].children.splice(0, 1);
      if (change === "child") block.children.push({ uuid: uuid(801), content: "user child" });
      if (change === "reorder") definition.blocks.reverse();
    }
    const inserts = namedCalls(f, "insertBlock").length;
    await assert.rejects(f.runtime.addExamples(key), /empty snapshot|plan changed|missing or unsupported|content other than unchanged examples|Unexpected content|header|summary|Unexpected planned block/i);
    assert.equal(namedCalls(f, "insertBlock").length, inserts, change);
  }
});

test("examples resume only an exact deterministic prefix after an ambiguous SDK insert", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  const before = namedCalls(f, "insertBlock").length;
  const original = f.sdk.Editor.insertBlock;
  let fail = true;
  f.sdk.Editor.insertBlock = async (...args) => {
    const block = await original(...args);
    if (fail) { fail = false; throw new Error("lost acknowledgement"); }
    return block;
  };
  await assert.rejects(f.runtime.addExamples(key), /lost acknowledgement/);
  assert.equal(namedCalls(f, "insertBlock").length, before + 1);
  assert.equal((await f.runtime.addExamples(key)).inserted, 7);
  assert.equal(namedCalls(f, "insertBlock").length, before + 8);
  const changed = contentBlocks(f.pages().get(currentPeriods(f).weekly.pageName))[0].children[0];
  changed.content = "DONE edited";
  await assert.rejects(f.runtime.addExamples(key), /content other than unchanged examples/);
  assert.equal(namedCalls(f, "insertBlock").length, before + 8);
});

test("examples do not refill deliberately deleted sample blocks, including an entirely cleared page", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  await f.runtime.addExamples(key);
  const page = f.pages().get(currentPeriods(f).weekly.pageName);
  contentBlocks(page)[0].children.splice(0);
  const before = namedCalls(f, "insertBlock").length;
  await assert.rejects(f.runtime.addExamples(key), /deleted or its write is ambiguous/);
  assert.equal(namedCalls(f, "insertBlock").length, before);
  assert.deepEqual(contentBlocks(page)[0].children, []);
});

test("examples refuse to guess after an insert fails before writing", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  const before = namedCalls(f, "insertBlock").length;
  f.sdk.Editor.insertBlock = async () => { throw new Error("host did not insert"); };
  await assert.rejects(f.runtime.addExamples(key), /host did not insert/);
  assert.equal(namedCalls(f, "insertBlock").length, before);
  await assert.rejects(f.runtime.addExamples(key), /deleted or its write is ambiguous/);
});

test("examples never continue after a partial write if any other selected page changed", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  const original = f.sdk.Editor.insertBlock;
  let fail = true;
  f.sdk.Editor.insertBlock = async (...args) => {
    const block = await original(...args);
    if (fail) { fail = false; throw new Error("lost acknowledgement"); }
    return block;
  };
  await assert.rejects(f.runtime.addExamples(key), /lost acknowledgement/);
  const before = namedCalls(f, "insertBlock").length;
  const monthly = f.pages().get(f.runtime.getStatus().definitions.monthly);
  monthly.blocks.push({ id: 901, uuid: uuid(901), page: { id: monthly.id }, parent: { id: monthly.id },
    left: { id: monthly.id }, content: "TODO user content", children: [] });
  await assert.rejects(f.runtime.addExamples(key), /content other than unchanged examples/);
  assert.equal(namedCalls(f, "insertBlock").length, before);
});

test("examples stop on graph change during preflight without writing into either graph", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  const before = namedCalls(f, "insertBlock").length;
  const entered = deferred(), release = deferred();
  const read = f.sdk.Editor.getPageBlocksTree;
  f.sdk.Editor.getPageBlocksTree = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
  const action = f.runtime.addExamples(key);
  await entered.promise;
  f.switchGraph("/graph/b");
  release.resolve();
  await assert.rejects(action, /cancelled|Graph changed/);
  assert.equal(namedCalls(f, "insertBlock").length, before);
});

test("examples accept an otherwise empty selected definition with a properties pre-block", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await enableEmpty(f);
  const key = f.runtime.getStatus().graphKey;
  const definition = f.pages().get(f.runtime.getStatus().definitions.monthly);
  definition.properties = { category: "personal" };
  definition.blocks.unshift({ id: 990, uuid: uuid(990), preBlock: true,
    content: propertyContent(definition.properties), properties: clone(definition.properties), children: [],
    page: { id: definition.id }, parent: { id: definition.id }, left: { id: definition.id } });
  assert.equal((await f.runtime.addExamples(key)).inserted, 8);
  assert.equal(contentBlocks(definition)[0].left.id, 990);
  const count = namedCalls(f, "insertBlock").length;
  assert.equal((await f.runtime.addExamples(key)).inserted, 0);
  assert.equal(namedCalls(f, "insertBlock").length, count);
});

test("history writes reject malformed block location and never retry the ambiguous insert", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  await f.runtime.start();
  const insert = f.sdk.Editor.insertBlock;
  f.sdk.Editor.insertBlock = async (...args) => {
    const result = await insert(...args);
    if (args[1] === historyQuery("weekly")) contentBlocks(f.pages().get(HISTORY_PAGE))[0].left = { id: 999999 };
    return result;
  };
  await assert.rejects(f.runtime.showHistory(), /write is ambiguous/);
  await assert.rejects(f.runtime.showHistory(), /incomplete or ambiguous/);
  assert.equal(namedCalls(f, "insertBlock").length, 2, "One metadata bootstrap and one ambiguous query insert");
});

test("daily template installation is explicit, enabled and graph-pinned; Enable alone does not change defaults", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const { graphKey } = await f.runtime.start();
  await assert.rejects(f.runtime.installDailyTemplate(), /selected graph/);
  await assert.rejects(f.runtime.installDailyTemplate(graphKey), /Enable routines/);
  await f.runtime.enable(graphKey);
  assert.equal(f.pages().has(DAILY_TEMPLATE_PAGE), false);
  assert.equal(namedCalls(f, "config").length, 0);
  const periodTasks = clone([...f.pages()]);
  await f.runtime.installDailyTemplate(graphKey);
  assert.equal(f.graphConfigs.get("/graph/a").journals, DAILY_TEMPLATE);
  assert.deepEqual([...f.pages()].filter(([name]) => name !== DAILY_TEMPLATE_PAGE), periodTasks);
  const before = clone([...f.pages()]), writes = namedCalls(f, "insertBlock").length;
  await f.runtime.installDailyTemplate(graphKey);
  assert.deepEqual([...f.pages()], before); assert.equal(namedCalls(f, "insertBlock").length, writes);
  f.switchGraph("/graph/b", false);
  await assert.rejects(f.runtime.installDailyTemplate(graphKey), /Graph changed/);
  assert.equal(f.pages().size, 0); assert.equal(f.graphConfigs.has("/graph/b"), false);
});

test("optional daily context failures do not block core settings; startup retries after editing finishes", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const { graphKey } = await f.runtime.start(); await f.runtime.enable(graphKey);
  await f.runtime.installDailyTemplate(graphKey);
  const root = contentBlocks(f.pages().get(DAILY_TEMPLATE_PAGE))[0];
  const sections = clone(root.children);
  f.sdk.Editor.checkEditing = async () => root.uuid;
  const changed = await f.runtime.configure({ calendar: "jalali" }, graphKey, { confirmCalendarChange: true });
  assert.equal(changed.calendar, "jalali"); assert.match(changed.dailyTemplateWarning, /may be outdated/);
  assert.equal(root.properties["jr-daily-calendar"], "gregorian");
  await f.runtime.configure({ autoOpen: false }, graphKey);
  assert.equal(f.runtime.getStatus().autoOpen, false, "unrelated settings save independently");
  f.sdk.Editor.checkEditing = async () => false;
  await f.runtime.destroy();
  const reloaded = f.newRuntime(); t.after(() => reloaded.destroy()); await reloaded.start();
  assert.equal(root.properties["jr-daily-calendar"], "jalali");
  assert.equal(reloaded.getStatus().dailyTemplateWarning, null);
  assert.deepEqual(root.children, sections, "startup updates context only, never daily sections");
});

test("interrupted optional daily installation cannot prevent later routine settings saves", async (t) => {
  const f = fixture(); t.after(() => f.runtime.destroy());
  const { graphKey } = await f.runtime.start(); await f.runtime.enable(graphKey);
  const insert = f.sdk.Editor.insertBlock;
  f.sdk.Editor.insertBlock = async (...args) => {
    if (args[1] === "## 🎯 Focus") throw new Error("interrupted template");
    return insert(...args);
  };
  await assert.rejects(f.runtime.installDailyTemplate(graphKey), /interrupted template/);
  const before = clone(f.pages().get(DAILY_TEMPLATE_PAGE));
  await f.runtime.configure({ autoOpen: false }, graphKey);
  const result = await f.runtime.configure({ calendar: "jalali" }, graphKey, { confirmCalendarChange: true });
  assert.equal(result.calendar, "jalali"); assert.match(result.dailyTemplateWarning, /incomplete/);
  assert.deepEqual(f.pages().get(DAILY_TEMPLATE_PAGE), before);
});
