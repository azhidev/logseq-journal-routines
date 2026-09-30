import assert from "node:assert/strict";
import test from "node:test";
import { createPeriodSnapshot, snapshotContent, SnapshotConflict } from "./period-snapshot.js";
import { gregorianPeriods, makePeriod, periodMetadata } from "./period-model.js";

const period = gregorianPeriods(new Date("2025-01-01T12:00:00")).weekly;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const copy = (value) => structuredClone(value);

function fixture(tree = [], { propertyStyle = "raw", tuples = false, headerStyle = "sdk", definitionHeader = true, nativeTitle = false } = {}) {
  const pages = new Map();
  const definition = { id: 1, uuid: uuid(1), name: "Weekly definition", properties: {}, blocks: copy(tree) };
  pages.set(definition.name, definition);
  const calls = [], upserts = [], insertions = [], bootstraps = [], updates = [];
  let sequence = 100, fail = null;
  function makeHeader(page, properties) {
    const header = { id: ++sequence, uuid: uuid(++sequence), "preBlock?": true, format: "markdown",
      content: Object.entries(properties).map(([key, value]) => `${key}:: ${value}`).join("\n"),
      properties: copy(properties), page: { id: page.id }, parent: { id: page.id }, left: { id: page.id }, children: [] };
    page.header = header;
    return header;
  }
  if (definitionHeader) makeHeader(definition, { title: "Weekly definition", tags: "routines" });
  const forest = (page) => [...(page.header ? [page.header] : []), ...page.blocks];
  function identify(list, page, parent = page) {
    let left = parent === page ? (page.header ?? page) : parent;
    for (const block of list) {
      block.id ??= ++sequence;
      block.page = { id: page.id };
      block.parent = { id: parent.id };
      block.left = { id: left.id };
      identify(block.children ?? [], page, block);
      left = block;
    }
  }
  identify(definition.blocks, definition);
  function propertiesEntity(entity) {
    if (propertyStyle === "camel") {
      entity.properties = Object.fromEntries(Object.entries(entity.properties ?? {}).map(([key, value]) =>
        [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
    } else if (propertyStyle === "raw-field") {
      entity["block/properties"] = entity.properties;
      delete entity.properties;
    }
    return entity;
  }
  function pageEntity(page) {
    if (!page) return null;
    const { blocks, header, ...entity } = copy(page);
    return propertiesEntity(entity);
  }
  function blockEntity(block, includeChildren = false) {
    if (!block) return null;
    const entity = propertiesEntity(copy(block));
    if (headerStyle !== "camel" && Object.hasOwn(entity, "preBlock?")) {
      entity[headerStyle === "raw" ? "pre-block?" : "preBlock"] = entity["preBlock?"];
      delete entity["preBlock?"];
    }
    entity.children = !includeChildren || tuples ? (block.children ?? []).map((child) => ["uuid", child.uuid]) :
      (block.children ?? []).map((child) => blockEntity(child, true));
    return entity;
  }
  function step(name) {
    calls.push(name);
    if (fail?.name === name && --fail.remaining === 0) {
      const behavior = fail.behavior;
      fail = null;
      if (behavior === "throw") throw new Error(`injected ${name} failure`);
      return true;
    }
    return false;
  }
  function find(id) {
    for (const page of pages.values()) {
      if (page.header?.uuid === id) return { block: page.header, list: page.blocks, page, header: true };
      const visit = (list) => {
        for (const block of list) {
          if (block.uuid === id) return { block, list, page };
          const nested = visit(block.children ?? []);
          if (nested) return nested;
        }
      };
      const result = visit(page.blocks);
      if (result) return result;
    }
    return null;
  }
  const sdk = { Editor: {
    async getPage(name) { step("getPage"); return pageEntity(pages.get(name)); },
    async getPageBlocksTree(id) {
      step("getPageBlocksTree");
      const page = [...pages.values()].find((item) => item.uuid === id || item.name === id);
      return page ? (tuples ? forest(page).map((block) => ["uuid", block.uuid]) : forest(page).map((block) => blockEntity(block, true))) : null;
    },
    async getBlock(id, options = {}) { step("getBlock"); return blockEntity(find(id)?.block, options.includeChildren); },
    async newBlockUUID() { step("newBlockUUID"); return uuid(++sequence); },
    async checkEditing() { return false; },
    async createPage(name, properties, options) {
      step("createPage");
      assert.deepEqual(options, { redirect: false, createFirstBlock: false, format: "markdown" });
      assert.equal(properties, null, "nonempty SDK createPage properties can leave unserializable Beans");
      if (pages.has(name)) return null;
      const page = { id: ++sequence, uuid: uuid(++sequence), name, properties: {}, blocks: [] };
      if (nativeTitle) {
        page.properties.title = name;
        makeHeader(page, page.properties);
      }
      pages.set(name, page);
      return pageEntity(page);
    },
    async updateBlock(id, content, options) {
      updates.push({ id, content, options: copy(options) });
      assert.equal(options, undefined);
      const target = find(id);
      assert.ok(target && (target.header || target.page.blocks[0] === target.block), "metadata parser requires the first root");
      if (step("updateBlock")) return;
      const properties = Object.fromEntries(content.split("\n").map((line) => {
        const match = /^([^\s:]+):: (.*)$/.exec(line);
        assert.ok(match, "metadata update contains only complete property lines");
        return [match[1], match[2]];
      }));
      target.block.content = content;
      target.block.properties = properties;
      target.block["preBlock?"] = true;
      if (!target.header) target.list.splice(target.list.indexOf(target.block), 1);
      target.page.header = target.block;
      target.page.properties = copy(properties); // Only the parser path mirrors into the page.
      identify(target.page.blocks, target.page);
      step("afterUpdateBlock");
    },
    async upsertBlockProperty(id, key, value) {
      upserts.push({ id, key, value });
      assert.ok(![...pages.values()].some((page) => page.uuid === id), "page UUID is never a property write target");
      const target = find(id);
      assert.ok(target?.header, "only the actual properties pre-block may be written");
      if (step(`upsert:${value}`)) return;
      setProperty(target.block, key, value);
      // Deliberately DO NOT mirror checkpoint mutations into page.properties.
    },
    async insertBlock(anchor, content, options) {
      const bootstrap = options.isPageBlock === true;
      const skip = step(bootstrap ? "bootstrapInsert" : "insertBlock");
      (bootstrap ? bootstraps : insertions).push({ anchor, content, options: copy(options) });
      if (bootstrap) {
        assert.equal(content, "Journal & Routines metadata initialization");
        assert.deepEqual(options, { sibling: false, isPageBlock: true, focus: false, customUUID: options.customUUID });
        assert.ok(pages.has(anchor), "bootstrap must target the page NAME, not its UUID");
      }
      const parent = [...pages.values()].find((page) => page.name === anchor);
      const target = parent ? { list: parent.blocks, page: parent } : find(anchor);
      assert.ok(target, `missing insertion anchor: ${anchor}`);
      const list = parent ? parent.blocks : options.sibling ? target.list : (target.block.children ??= []);
      assert.equal(find(options.customUUID), null, "customUUID must not overwrite any existing block");
      const block = { id: ++sequence, uuid: options.customUUID, format: "markdown",
        content: `${content}\nid:: ${options.customUUID}`, properties: { id: options.customUUID }, children: [] };
      const position = target.header && options.sibling ? 0 : options.sibling ? list.findIndex((item) => item.uuid === anchor) + 1 : list.length;
      list.splice(position, 0, block);
      identify(target.page.blocks, target.page);
      return skip ? null : blockEntity(block);
    },
  } };
  return {
    sdk, pages, definition, calls, find, upserts, insertions, bootstraps, updates,
    failNext(name, behavior = "throw", remaining = 1) { fail = { name, behavior, remaining }; },
    run(extra = {}) { return createPeriodSnapshot({ sdk, period, definitionPage: definition.name, guard: async () => {}, ...extra }); },
  };
}

function setProperty(block, key, value) {
  block.properties[key] = value;
  const lines = block.content.split("\n"), index = lines.findIndex((line) => line.startsWith(`${key}::`));
  if (index < 0) lines.push(`${key}:: ${value}`);
  else lines[index] = `${key}:: ${value}`;
  block.content = lines.join("\n");
}

const root = (content, id, children = []) => ({ uuid: uuid(id), content, children });
const text = (block) => block.content.replace(/\nid:: [^\n]+$/, "");

test("copy policy keeps nesting, prose and literal references but not identity/completion properties", async () => {
  const f = fixture([
    root("DONE Finish ((00000000-0000-4000-8000-000000000999))\nid:: old\ncompleted:: yes\npriority:: A\n:LOGBOOK:\nCLOCK: x\n:END:", 2, [
      root("Notes [[Project]]", 3), root("WAITING follow up\nSCHEDULED: <2025-01-02>", 4),
    ]),
    root("TODO second", 5),
  ]);
  const result = await f.run({ allowCreate: true });
  assert.deepEqual(result, { status: "created", pageName: period.pageName, empty: false });
  const page = f.pages.get(period.pageName);
  assert.deepEqual(page.blocks.map(text), ["TODO Finish ((00000000-0000-4000-8000-000000000999))", "TODO second"]);
  assert.deepEqual(page.blocks[0].children.map(text), ["Notes [[Project]]", "TODO follow up"]);
  assert.ok(![uuid(2), uuid(3), uuid(4), uuid(5)].includes(page.blocks[0].uuid));
  assert.equal(page.header.properties["jr-snapshot-state"], "populated");
  assert.equal(page.properties["jr-snapshot-state"], "ready:0", "page-map state intentionally stays stale");
  assert.deepEqual(Object.fromEntries(Object.entries(page.properties).filter(([key]) => key in periodMetadata(period))), periodMetadata(period));
  page.blocks[0].content = "DONE personally edited";
  page.blocks.splice(1, 1);
  f.definition.blocks.push(root("TODO later definition", 6));
  f.calls.length = 0;
  assert.equal((await f.run()).status, "existing");
  assert.equal(page.blocks[0].content, "DONE personally edited");
  assert.equal(page.blocks.length, 1);
  assert.deepEqual(f.calls, ["getPage", "getPageBlocksTree", "getBlock"], "completed snapshots read only their own page and header");
});

test("fresh metadata uses text parsing, preserving native titles and excluding the bootstrap from the plan", async () => {
  for (const nativeTitle of [false, true]) {
    const f = fixture([root("TODO source", 2)], { nativeTitle });
    await f.run({ allowCreate: true });
    const page = f.pages.get(period.pageName), plan = JSON.parse(page.properties["jr-snapshot-plan"]);
    assert.equal(f.bootstraps.length, nativeTitle ? 0 : 1);
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].id, page.header.uuid);
    assert.equal(plan.ids.length, 1);
    assert.ok(!plan.ids.includes(page.header.uuid));
    assert.notEqual(page.header.uuid, f.definition.uuid);
    assert.deepEqual(page.blocks.map(text), ["TODO source"]);
    assert.equal(page.properties["jr-snapshot-state"], "ready:0");
    assert.equal(page.header.properties["jr-snapshot-state"], "populated");
    if (nativeTitle) {
      assert.equal(page.properties.title, period.pageName);
      assert.equal(page.header.properties.title, period.pageName);
    }
  }
});

test("ambiguous bootstrap insertion or parsing never starts snapshot writes or repairs an unowned page", async () => {
  for (const [operation, behavior] of [["bootstrapInsert", "throw"], ["bootstrapInsert", "null"], ["updateBlock", "throw"], ["updateBlock", "noop"]]) {
    const f = fixture([root("TODO source", 2)]);
    f.failNext(operation, behavior);
    await assert.rejects(f.run({ allowCreate: true }), /creation outcome is ambiguous/);
    const before = copy(f.pages.get(period.pageName));
    assert.ok(before, "the uncertain page is never rolled back");
    assert.equal(f.insertions.length, 0);
    assert.equal(f.upserts.length, 0);
    f.calls.length = 0;
    await assert.rejects(f.run(), SnapshotConflict);
    assert.deepEqual(f.pages.get(period.pageName), before);
    assert.deepEqual(f.calls, ["getPage"]);
  }
});

test("a committed parser write with failed acknowledgement resumes without another bootstrap", async () => {
  const f = fixture([root("TODO once", 2)]);
  f.failNext("afterUpdateBlock");
  await assert.rejects(f.run({ allowCreate: true }), /creation outcome is ambiguous/);
  assert.equal(f.insertions.length, 0);
  assert.equal((await f.run()).status, "resumed");
  assert.equal(f.bootstraps.length, 1);
  assert.equal(f.updates.length, 1);
  assert.deepEqual(f.pages.get(period.pageName).blocks.map(text), ["TODO once"]);
});

test("bootstrap IDs cannot alias snapshot IDs or the definition page", async () => {
  for (const collision of [uuid(900), uuid(1)]) {
    const f = fixture([root("TODO source", 2)]);
    let allocations = 0;
    f.sdk.Editor.newBlockUUID = async () => ++allocations === 1 ? uuid(900) : collision;
    const before = copy(f.definition);
    await assert.rejects(f.run({ allowCreate: true }), /creation outcome is ambiguous/);
    assert.deepEqual(f.definition, before);
    assert.equal(f.bootstraps.length, 0);
    assert.equal(f.updates.length, 0);
    assert.equal(f.insertions.length, 0);
  }
});

test("guard cancellation after bootstrap operations stops all following writes", async () => {
  for (const operation of ["bootstrapInsert", "updateBlock"]) {
    const f = fixture([root("TODO source", 2)]);
    await assert.rejects(f.run({ allowCreate: true, guard: async () => {
      if (f.calls.includes(operation)) throw new Error("graph changed");
    } }), /graph changed/);
    assert.equal(f.insertions.length, 0);
    assert.equal(f.upserts.length, 0);
    if (operation === "bootstrapInsert") assert.equal(f.updates.length, 0);
  }
});

test("empty definitions are durably initialized and not retried", async () => {
  const f = fixture();
  assert.equal((await f.run({ allowCreate: true })).empty, true);
  assert.equal(f.pages.get(period.pageName).header.properties["jr-snapshot-state"], "empty");
  f.definition.blocks.push(root("TODO future", 7));
  assert.deepEqual(await f.run(), { status: "existing", pageName: period.pageName, empty: true });
  assert.equal(f.pages.get(period.pageName).blocks.length, 0);
});

test("same-name unowned or partly owned pages are collisions without writes", async () => {
  for (const properties of [{}, { ...periodMetadata(period), "jr-kind": "monthly" }]) {
    const f = fixture([root("TODO source", 2)]);
    f.pages.set(period.pageName, { id: 50, uuid: uuid(50), name: period.pageName, properties, blocks: [] });
    await assert.rejects(f.run({ allowCreate: true }), /ownership collision/);
    assert.deepEqual(f.calls, ["getPage"]);
  }
});

test("read failure is not absence; missing page needs explicit creation authorization", async () => {
  const f = fixture([root("TODO source", 2)]);
  f.failNext("getPage");
  await assert.rejects(f.run({ allowCreate: true }), /injected getPage failure/);
  assert.equal(f.pages.size, 1);
  await assert.rejects(f.run(), /refusing automatic recreation/);
  await f.run({ allowCreate: true });
  f.pages.delete(period.pageName);
  await assert.rejects(f.run(), /refusing automatic recreation/);
  assert.equal(f.pages.size, 1);
});

test("reconciles a verified in-flight write without duplication after ambiguous acknowledgement", async () => {
  const f = fixture([root("TODO first", 2), root("DONE second", 3)]);
  f.failNext("insertBlock", "null");
  await assert.rejects(f.run({ allowCreate: true }), /ambiguous/);
  const page = f.pages.get(period.pageName);
  assert.equal(page.header.properties["jr-snapshot-state"], "writing:0");
  assert.equal(page.blocks.length, 1);
  assert.equal((await f.run()).status, "resumed");
  assert.deepEqual(page.blocks.map(text), ["TODO first", "TODO second"]);
  assert.equal(page.header.properties["jr-snapshot-state"], "populated");
});

test("interruption before insert pauses on missing in-flight block; never blindly retries", async () => {
  const f = fixture([root("TODO first", 2)]);
  f.failNext("insertBlock");
  await assert.rejects(f.run({ allowCreate: true }), /injected/);
  const before = f.calls.length;
  await assert.rejects(f.run(), /deleted or edited/);
  assert.ok(!f.calls.slice(before).includes("insertBlock"));
});

test("cursor checkpoint failure is reconciled; deleted or edited written blocks pause", async () => {
  const f = fixture([root("TODO first", 2), root("TODO second", 3)]);
  f.failNext("upsert:ready:1");
  await assert.rejects(f.run({ allowCreate: true }), /injected/);
  assert.equal((await f.run()).status, "resumed");
  const page = f.pages.get(period.pageName);
  page.blocks[0].content = "DONE edited";
  // Simulate interruption with a committed checkpoint; no task repair is allowed.
  setProperty(page.header, "jr-snapshot-state", "ready:2");
  await assert.rejects(f.run(), /deleted or edited/);
});

test("source changes during unfinished initialization pause without copying new definition", async () => {
  const f = fixture([root("TODO first", 2), root("TODO second", 3)]);
  f.failNext("upsert:ready:1");
  await assert.rejects(f.run({ allowCreate: true }), /injected/);
  f.definition.blocks[1].content = "TODO changed";
  const before = f.calls.length;
  await assert.rejects(f.run(), /Definition changed/);
  assert.ok(!f.calls.slice(before).includes("insertBlock"));
});

test("final metadata failure resumes without rewriting tasks", async () => {
  const f = fixture([root("TODO once", 2)]);
  f.failNext("upsert:populated");
  await assert.rejects(f.run({ allowCreate: true }), /injected/);
  const page = f.pages.get(period.pageName);
  assert.equal(page.header.properties["jr-snapshot-state"], "ready:1");
  const count = f.calls.filter((name) => name === "insertBlock").length;
  assert.equal((await f.run()).status, "resumed");
  assert.equal(f.calls.filter((name) => name === "insertBlock").length, count);
  assert.equal(page.blocks.length, 1);
});

test("guard stops stale work before writes and ambiguous page creation never retries blindly", async () => {
  const f = fixture([root("TODO source", 2)]);
  const guard = async () => { if (f.calls.includes("getPage")) throw new Error("graph changed"); };
  await assert.rejects(f.run({ allowCreate: true, guard }), /graph changed/);
  assert.equal(f.pages.size, 1);
  const g = fixture();
  g.failNext("createPage");
  await assert.rejects(g.run({ allowCreate: true }), /creation outcome is ambiguous/);
  assert.equal(g.pages.size, 1);
});

test("invalid plan and malformed definition fail closed; Jalali is period-qualified", async () => {
  assert.equal(snapshotContent("DONE task\ncreated-at:: 123"), "TODO task");
  assert.throws(() => snapshotContent("id:: abc"), SnapshotConflict);
  const f = fixture([root("id:: abc", 2)]);
  await assert.rejects(f.run({ allowCreate: true }), /only properties/);
  assert.equal(f.pages.size, 1);
  f.definition.blocks = [];
  await f.run({ allowCreate: true });
  f.pages.get(period.pageName).properties["jr-snapshot-plan"] = "bad";
  await assert.rejects(f.run(), /creation plan/);
  const jalali = makePeriod({ calendar: "jalali", kind: "weekly", start: "2025-03-15", end: "2025-03-21" });
  assert.equal((await f.run({ period: jalali, allowCreate: true })).pageName, jalali.pageName);
  assert.equal(f.pages.size, 3);
});

test("fenced code is literal, including properties, scheduling and drawer-like lines", async () => {
  for (const fence of ["```", "~~~~"]) {
    const code = `${fence}text\nid:: example\ncompleted:: yes\nSCHEDULED: tomorrow\nDEADLINE: later\nCLOSED: yesterday\n:LOGBOOK:\nDONE literal\n${fence}`;
    const source = `DONE task\n${code}\n完了::yes\nid:: source\nSCHEDULED: outside`;
    assert.equal(snapshotContent(source), `TODO task\n${code}`);
    assert.equal(snapshotContent(code), code);
    const f = fixture([root(source, 2)], { tuples: true });
    f.failNext("upsert:ready:1");
    await assert.rejects(f.run({ allowCreate: true }), /injected/);
    assert.equal((await f.run()).status, "resumed");
    assert.equal(text(f.pages.get(period.pageName).blocks[0]), `TODO task\n${code}`);
  }
  assert.equal(snapshotContent("````md\n```\nid:: literal\n````\nid:: strip"), "````md\n```\nid:: literal\n````");
  assert.equal(snapshotContent("TODO task\n:LOGBOOK:\n```\n:END:\nid:: strip"), "TODO task");
  assert.throws(() => snapshotContent("TODO task\n:LOGBOOK:\nunfinished"), /Unclosed/);
  const unfinishedCode = "```text\nid:: literal\nDONE literal  \n";
  assert.equal(snapshotContent(unfinishedCode), unfinishedCode);
  assert.equal(snapshotContent("TODO task  \nuser-property:: value"), "TODO task  ");
});

test("SDK raw/camelCase property maps and tuple children round-trip on creation and resume", async () => {
  for (const propertyStyle of ["raw", "camel", "raw-field"]) for (const headerStyle of ["raw", "camel"]) {
    const f = fixture([root("DONE parent", 2, [root("Notes", 3), root("DONE child", 4)]), root("TODO sibling", 5)],
      { propertyStyle, headerStyle, tuples: true });
    f.failNext("upsert:ready:2");
    await assert.rejects(f.run({ allowCreate: true }), /injected/);
    assert.equal((await f.run()).status, "resumed");
    const page = f.pages.get(period.pageName);
    assert.deepEqual(page.blocks.map(text), ["TODO parent", "TODO sibling"]);
    assert.deepEqual(page.blocks[0].children.map(text), ["Notes", "TODO child"]);
    assert.equal(f.calls.filter((call) => call === "insertBlock").length, 4);
    assert.equal((await f.run()).status, "existing");
  }
});

test("conflicting immutable page-property aliases fail closed, including on completed pages", async () => {
  for (const [key, value] of [["jrKind", "monthly"], ["jrSnapshotPlan", "{}"], ["jrStart", [period.start]]]) {
    const f = fixture();
    await f.run({ allowCreate: true });
    const page = f.pages.get(period.pageName);
    page.properties[key] = value;
    f.calls.length = 0;
    await assert.rejects(f.run(), /Conflicting period property aliases/);
    assert.deepEqual(f.calls, ["getPage"]);
  }
  const f = fixture();
  await f.run({ allowCreate: true });
  const page = f.pages.get(period.pageName);
  page.properties.jrKind = "weekly";
  page["block/properties"] = copy(page.properties);
  assert.equal((await f.run()).status, "existing");
  page["block/properties"].jrKind = "monthly";
  await assert.rejects(f.run(), /Conflicting/);
});

test("silent checkpoint no-ops pause at every stage and never advance to the next write", async () => {
  for (const [next, prior, inserted, empty] of [
    ["writing:0", "ready:0", 0, false],
    ["ready:1", "writing:0", 1, false],
    ["populated", "ready:1", 1, false],
    ["empty", "ready:0", 0, true],
  ]) {
    const f = fixture(empty ? [] : [root("TODO once", 2)]);
    f.failNext(`upsert:${next}`, "noop");
    await assert.rejects(f.run({ allowCreate: true }), /state could not be verified/);
    const page = f.pages.get(period.pageName);
    assert.equal(page.header.properties["jr-snapshot-state"], prior);
    assert.equal(page.blocks.length, inserted);
    assert.equal(f.calls.at(-1), "getBlock");
    assert.equal((await f.run()).status, "resumed");
    assert.equal(page.blocks.length, empty ? 0 : 1);
  }
});

test("a committed checkpoint with delayed header visibility pauses without rollback", async () => {
  for (const next of ["writing:0", "ready:1", "populated", "empty"]) {
    const f = fixture(next === "empty" ? [] : [root("TODO once", 2)]);
    const upsert = f.sdk.Editor.upsertBlockProperty, getBlock = f.sdk.Editor.getBlock;
    let stale = null;
    f.sdk.Editor.upsertBlockProperty = async (id, key, value) => {
      if (value === next) stale = await getBlock(id);
      return upsert(id, key, value);
    };
    f.sdk.Editor.getBlock = async (id, options) => {
      const actual = await getBlock(id, options);
      if (stale && id === stale.uuid) { const old = stale; stale = null; return old; }
      return actual;
    };
    await assert.rejects(f.run({ allowCreate: true }), /state could not be verified/);
    const page = f.pages.get(period.pageName);
    assert.equal(page.header.properties["jr-snapshot-state"], next);
    assert.equal(page.properties["jr-snapshot-state"], "ready:0");
    f.sdk.Editor.upsertBlockProperty = upsert;
    const inserts = f.calls.filter((call) => call === "insertBlock").length;
    if (next === "writing:0") {
      await assert.rejects(f.run(), /deleted or edited/);
      assert.equal(page.blocks.length, 0);
    } else {
      assert.equal((await f.run()).status, next === "ready:1" ? "resumed" : "existing");
    }
    assert.equal(f.calls.filter((call) => call === "insertBlock").length, inserts);
  }
});

test("a successful insert acknowledgement alone cannot commit missing, edited or misplaced content", async () => {
  for (const fault of ["missing", "content", "page", "parent", "left", "identity", "duplicate-id"]) {
    const f = fixture([root("TODO once", 2)]);
    const insert = f.sdk.Editor.insertBlock;
    f.sdk.Editor.insertBlock = async (...args) => {
      const acknowledgement = await insert(...args);
      if (args[2].isPageBlock) return acknowledgement;
      const block = f.find(acknowledgement.uuid).block;
      if (fault === "missing") f.pages.get(period.pageName).blocks = [];
      if (fault === "content") block.content = block.content.replace("TODO", "DONE");
      if (["page", "parent", "left"].includes(fault)) block[fault] = { id: 999 };
      if (fault === "identity") block.content = block.content.replace(block.uuid, uuid(999));
      if (fault === "duplicate-id") block.content += `\nid:: ${block.uuid}`;
      return acknowledgement;
    };
    await assert.rejects(f.run({ allowCreate: true }), /could not be verified|Conflicting written block identity/);
    assert.equal(f.pages.get(period.pageName).header.properties["jr-snapshot-state"], "writing:0");
    assert.ok(!f.calls.includes("upsert:ready:1") && !f.calls.includes("upsert:populated"));
  }
});

test("resume ignores only the matching generated identity, never edits or extra properties", async () => {
  for (const change of [
    (block) => { block.content = block.content.replace("TODO", "DONE"); },
    (block) => { block.content += "\ncompleted:: yes"; },
    (block) => { block.content += "\nSCHEDULED: tomorrow"; },
    (block) => { block.content += `\nid:: ${block.uuid}`; },
    (block) => { block.content = block.content.replace(block.uuid, uuid(999)); },
    (block) => { block.content = block.content.replace("task", "task "); },
  ]) {
    const f = fixture([root("TODO task", 2)]);
    f.failNext("upsert:ready:1");
    await assert.rejects(f.run({ allowCreate: true }), /injected/);
    const page = f.pages.get(period.pageName);
    change(page.blocks[0]);
    const before = copy(page);
    f.calls.length = 0;
    await assert.rejects(f.run(), SnapshotConflict);
    assert.deepEqual(page, before);
    assert.ok(!f.calls.some((call) => call.startsWith("upsert:") || call === "insertBlock"));
  }
});

test("final verification catches deletions, edits, extra blocks, moves and reordering during initialization", async () => {
  for (const fault of ["delete", "edit", "extra", "move", "reorder"]) {
    const f = fixture([root("TODO first", 2), root("TODO second", 3)]);
    const upsert = f.sdk.Editor.upsertBlockProperty;
    f.sdk.Editor.upsertBlockProperty = async (id, key, value) => {
      await upsert(id, key, value);
      if (value !== "ready:2") return;
      const page = f.pages.get(period.pageName);
      if (fault === "delete") page.blocks.shift();
      if (fault === "edit") page.blocks[0].content = "DONE edited";
      if (fault === "extra") page.blocks.push(root("User note", 999));
      if (fault === "move") page.blocks[0].children.push(page.blocks.pop());
      if (fault === "reorder") page.blocks.reverse();
    };
    await assert.rejects(f.run({ allowCreate: true }), SnapshotConflict);
    assert.equal(f.pages.get(period.pageName).header.properties["jr-snapshot-state"], "ready:2");
    assert.ok(!f.calls.includes("upsert:populated"));
  }
});

test("page replacement, ownership loss or plan changes stop subsequent checkpoints", async () => {
  for (const fault of ["replace", "owner", "plan", "state", "delete"]) {
    const f = fixture([root("TODO first", 2), root("TODO second", 3)]);
    const insert = f.sdk.Editor.insertBlock;
    f.sdk.Editor.insertBlock = async (...args) => {
      const result = await insert(...args);
      if (args[2].isPageBlock) return result;
      const page = f.pages.get(period.pageName);
      if (fault === "replace") page.uuid = uuid(999);
      if (fault === "owner") page.properties["jr-calendar"] = "jalali";
      if (fault === "plan") page.properties["jr-snapshot-plan"] = "{}";
      if (fault === "state") setProperty(page.header, "jr-snapshot-state", "populated");
      if (fault === "delete") f.pages.delete(period.pageName);
      return result;
    };
    await assert.rejects(f.run({ allowCreate: true }), SnapshotConflict);
    assert.ok(!f.calls.includes("upsert:ready:1") && !f.calls.includes("upsert:writing:1"));
  }
});

test("page creation verifies its exact plan and rejects a concurrent same-name page", async () => {
  for (const fault of ["plan", "state", "acknowledgement", "race"]) {
    const f = fixture([root("TODO first", 2)]);
    const create = f.sdk.Editor.createPage;
    f.sdk.Editor.createPage = async (name, properties, options) => {
      if (fault === "race") {
        f.pages.set(name, { id: 999, uuid: uuid(999), name, properties: {}, blocks: [root("User note", 9)] });
        return null;
      }
      const result = await create(name, properties, options);
      return fault === "acknowledgement" ? null : result;
    };
    const update = f.sdk.Editor.updateBlock;
    f.sdk.Editor.updateBlock = async (...args) => {
      await update(...args);
      const page = f.pages.get(period.pageName);
      if (fault === "plan") {
        const plan = JSON.parse(page.properties["jr-snapshot-plan"]);
        plan.ids[0] = uuid(999);
        page.properties["jr-snapshot-plan"] = JSON.stringify(plan);
        setProperty(page.header, "jr-snapshot-plan", JSON.stringify(plan));
      }
      if (fault === "state") {
        page.properties["jr-snapshot-state"] = "populated";
        setProperty(page.header, "jr-snapshot-state", "populated");
      }
    };
    await assert.rejects(f.run({ allowCreate: true }), SnapshotConflict);
    assert.ok(!f.calls.some((call) => call.startsWith("upsert:") || call === "insertBlock"));
    assert.ok(f.pages.has(period.pageName), "ambiguous page is never deleted");
  }
});

test("fresh UUID collisions never write to source or external blocks", async () => {
  const f = fixture([root("TODO source", 2)]);
  const freshUUID = f.sdk.Editor.newBlockUUID;
  let first = true;
  f.sdk.Editor.newBlockUUID = async () => {
    if (first) { first = false; return uuid(2); }
    return freshUUID();
  };
  const before = copy(f.definition);
  await assert.rejects(f.run({ allowCreate: true }), /identity is occupied/);
  assert.deepEqual(f.definition, before);
  assert.ok(!f.calls.includes("insertBlock") && !f.calls.includes("upsert:writing:0"));
});

test("completed state must agree with the saved plan length", async () => {
  for (const empty of [true, false]) {
    const f = fixture(empty ? [] : [root("TODO task", 2)]);
    await f.run({ allowCreate: true });
    setProperty(f.pages.get(period.pageName).header, "jr-snapshot-state", empty ? "populated" : "empty");
    f.calls.length = 0;
    await assert.rejects(f.run(), /Invalid completed/);
    assert.deepEqual(f.calls, ["getPage", "getPageBlocksTree", "getBlock"]);
  }
});

test("guard cancellation after insertion stops verification and all subsequent writes", async () => {
  const f = fixture([root("TODO first", 2), root("TODO second", 3)]);
  await assert.rejects(f.run({ allowCreate: true, guard: async () => {
    if (f.calls.includes("insertBlock")) throw new Error("graph changed");
  } }), /graph changed/);
  assert.equal(f.calls.at(-1), "insertBlock");
  assert.equal(f.pages.get(period.pageName).header.properties["jr-snapshot-state"], "writing:0");
  assert.equal((await f.run()).status, "resumed");
});

test("delayed tree visibility cannot mark a snapshot populated, but later verification can resume", async () => {
  const f = fixture([root("TODO once", 2)]);
  const getTree = f.sdk.Editor.getPageBlocksTree;
  f.sdk.Editor.getPageBlocksTree = async (id) => {
    const tree = await getTree(id);
    return id === f.definition.uuid ? tree : tree.slice(0, 1);
  };
  await assert.rejects(f.run({ allowCreate: true }), /deleted or edited/);
  assert.equal(f.pages.get(period.pageName).header.properties["jr-snapshot-state"], "ready:1");
  assert.ok(!f.calls.includes("upsert:populated"));
  f.sdk.Editor.getPageBlocksTree = getTree;
  assert.equal((await f.run()).status, "resumed");
  assert.equal(f.calls.filter((call) => call === "insertBlock").length, 1);
});

test("failed or malformed tree reads are not empty definitions or permission to refill", async () => {
  for (const invalid of [null, undefined, {}, [["uuid", uuid(999)]]]) {
    const f = fixture([root("TODO source", 2)]);
    f.sdk.Editor.getPageBlocksTree = async () => invalid;
    await assert.rejects(f.run({ allowCreate: true }), SnapshotConflict);
    assert.equal(f.pages.size, 1);
    assert.ok(!f.calls.includes("createPage"));
  }
  const f = fixture([root("TODO once", 2)]);
  f.failNext("upsert:ready:1");
  await assert.rejects(f.run({ allowCreate: true }), /injected/);
  const getTree = f.sdk.Editor.getPageBlocksTree;
  f.sdk.Editor.getPageBlocksTree = async (id) => id === f.definition.uuid ? getTree(id) : null;
  f.calls.length = 0;
  await assert.rejects(f.run(), /Period tree read failed/);
  assert.ok(!f.calls.some((call) => call.startsWith("upsert:") || call === "insertBlock"));
});

test("actual pre-blocks are excluded from plans and copying; first root follows the period header", async () => {
  for (const definitionHeader of [true, false]) {
    const f = fixture([root("DONE parent", 2, [root("TODO child", 3)]), root("TODO sibling", 4)], { definitionHeader });
    const originalDefinition = copy(f.definition);
    await f.run({ allowCreate: true });
    const page = f.pages.get(period.pageName), header = page.header;
    assert.notEqual(header.uuid, page.uuid);
    assert.notEqual(header.id, page.id);
    assert.deepEqual(header.page, { id: page.id });
    assert.deepEqual(header.parent, { id: page.id });
    assert.deepEqual(header.left, { id: page.id });
    const tree = await f.sdk.Editor.getPageBlocksTree(page.uuid);
    assert.equal(tree.length, 3, "header plus two task roots");
    assert.equal(tree[0].preBlock, true);
    const plan = JSON.parse(page.properties["jr-snapshot-plan"]);
    assert.equal(plan.ids.length, 3, "only tasks, not headers, have planned IDs");
    assert.ok(!plan.ids.includes(header.uuid));
    assert.deepEqual(f.definition, originalDefinition, "definition properties are neither cloned nor mutated");
    assert.equal(f.insertions[0].anchor, header.uuid);
    assert.equal(f.insertions[0].options.sibling, true);
    assert.equal(f.insertions[0].options.isPageBlock, false);
    assert.equal(page.blocks[0].left.id, header.id);
    assert.equal(page.blocks[0].parent.id, page.id);
    assert.equal(page.blocks[0].children[0].left.id, page.blocks[0].id);
    assert.equal(page.blocks[1].left.id, page.blocks[0].id);
    assert.ok(f.upserts.length > 0);
    assert.ok(f.upserts.every(({ id, key }) => id === header.uuid && key === "jr-snapshot-state"));
    assert.equal(page.properties["jr-snapshot-state"], "ready:0");
    assert.equal(header.properties["jr-snapshot-state"], "populated");
  }
});

test("reload trusts completed header state, never the stale or contradictory page-state mirror", async () => {
  for (const empty of [true, false]) {
    const f = fixture(empty ? [] : [root("TODO once", 2)]);
    await f.run({ allowCreate: true });
    const page = f.pages.get(period.pageName);
    page.properties["jr-snapshot-state"] = "writing:1999";
    page.properties.jrSnapshotState = ["stale host representation"];
    page.blocks = []; // Deliberate task deletion must not be refilled on reload.
    f.pages.delete(f.definition.name); // Completed snapshots don't consult definitions.
    const before = copy(page);
    f.calls.length = 0;
    assert.deepEqual(await f.run(), { status: "existing", pageName: period.pageName, empty });
    assert.deepEqual(page, before);
    assert.deepEqual(f.calls, ["getPage", "getPageBlocksTree", "getBlock"]);
  }
});

test("missing, unmarked, duplicate, misplaced or malformed headers are never reconstructed", async () => {
  for (const complete of [true, false]) for (const fault of [
    "missing", "unmarked", "duplicate", "nested", "not-first", "page", "parent", "left", "children", "marker-conflict", "same-uuid", "same-id",
  ]) {
    const f = fixture([root("TODO task", 2)]);
    if (!complete) f.failNext("upsert:populated");
    if (complete) await f.run({ allowCreate: true });
    else await assert.rejects(f.run({ allowCreate: true }), /injected/);
    const page = f.pages.get(period.pageName), header = page.header;
    if (fault === "missing") page.header = null;
    if (fault === "unmarked") delete header["preBlock?"];
    const extra = { ...copy(header), id: 999, uuid: uuid(999) };
    if (fault === "duplicate") page.blocks.push(extra);
    if (fault === "nested") page.blocks[0].children.push(extra);
    if (fault === "not-first") { page.blocks.push(header); page.header = null; }
    if (["page", "parent", "left"].includes(fault)) header[fault] = { id: 999 };
    if (fault === "children") header.children.push(root("User note", 999));
    if (fault === "marker-conflict") header["pre-block?"] = false;
    if (fault === "same-uuid") header.uuid = page.uuid;
    if (fault === "same-id") header.id = page.id;
    const before = copy(page);
    f.calls.length = 0;
    await assert.rejects(f.run({ allowCreate: true }), SnapshotConflict, `${fault}, completed=${complete}`);
    assert.deepEqual(page, before);
    assert.ok(!f.calls.some((call) => call.startsWith("upsert:") || call === "insertBlock" || call === "createPage"));
  }
});

test("definition headers must be unique first-root leaves owned by the selected definition", async () => {
  for (const fault of ["page", "parent", "left", "children", "duplicate", "nested", "not-first"]) {
    const f = fixture([root("TODO task", 2)]);
    const header = f.definition.header;
    if (["page", "parent", "left"].includes(fault)) header[fault] = { id: 999 };
    if (fault === "children") header.children.push(root("Useful child", 999));
    if (fault === "duplicate") f.definition.blocks.push({ ...copy(header), id: 999, uuid: uuid(999) });
    if (fault === "nested") f.definition.blocks[0].children.push({ ...copy(header), id: 999, uuid: uuid(999) });
    if (fault === "not-first") { f.definition.blocks.push(header); f.definition.header = null; }
    const before = copy(f.definition);
    await assert.rejects(f.run({ allowCreate: true }), SnapshotConflict, fault);
    assert.deepEqual(f.definition, before);
    assert.equal(f.pages.size, 1);
    assert.ok(!f.calls.includes("createPage"));
  }
});

test("header state, ownership and plan aliases/text must agree, without overwriting user metadata", async () => {
  for (const fault of ["state-alias", "owner-alias", "plan-alias", "owner", "plan", "missing-state", "duplicate-text", "text-alias", "text-map-mismatch"]) {
    const f = fixture();
    await f.run({ allowCreate: true });
    const page = f.pages.get(period.pageName), header = page.header;
    if (fault === "state-alias") header.properties.jrSnapshotState = "populated";
    if (fault === "owner-alias") header.properties.jrKind = "monthly";
    if (fault === "plan-alias") header["block/properties"] = { jrSnapshotPlan: "{}" };
    if (fault === "owner") setProperty(header, "jr-kind", "monthly");
    if (fault === "plan") setProperty(header, "jr-snapshot-plan", "{}");
    if (fault === "missing-state") delete header.properties["jr-snapshot-state"];
    if (fault === "duplicate-text") header.content += "\njr-snapshot-state:: empty";
    if (fault === "text-alias") header.content = header.content.replace("jr-snapshot-state::", "jrSnapshotState::");
    if (fault === "text-map-mismatch") header.content = header.content.replace("jr-snapshot-state:: empty", "jr-snapshot-state:: ready:0");
    const before = copy(page);
    f.calls.length = 0;
    await assert.rejects(f.run(), SnapshotConflict, fault);
    assert.deepEqual(page, before);
    assert.ok(!f.calls.some((call) => call.startsWith("upsert:")));
  }
  const f = fixture([root("TODO once", 2)]);
  const upsert = f.sdk.Editor.upsertBlockProperty;
  f.sdk.Editor.upsertBlockProperty = async (...args) => {
    await upsert(...args);
    setProperty(f.pages.get(period.pageName).header, "user-note", "keep this metadata");
  };
  await f.run({ allowCreate: true });
  const page = f.pages.get(period.pageName);
  assert.equal(page.header.properties["user-note"], "keep this metadata");
  assert.match(page.header.content, /user-note:: keep this metadata/);
  page.header.properties.jrSnapshotState = "populated";
  page.header["pre-block?"] = true;
  assert.equal((await f.run()).status, "existing", "matching aliases are permitted");
});

test("a removed, replaced or moved header stops checkpoint writes even when page metadata is unchanged", async () => {
  for (const fault of ["missing", "uuid", "id", "left", "owner"]) {
    const f = fixture([root("TODO task", 2)]);
    const insert = f.sdk.Editor.insertBlock;
    f.sdk.Editor.insertBlock = async (...args) => {
      const result = await insert(...args);
      if (args[2].isPageBlock) return result;
      const page = f.pages.get(period.pageName);
      if (fault === "missing") page.header = null;
      if (fault === "uuid") page.header.uuid = uuid(999);
      if (fault === "id") page.header.id = 999;
      if (fault === "left") page.header.left.id = 999;
      if (fault === "owner") setProperty(page.header, "jr-kind", "monthly");
      return result;
    };
    await assert.rejects(f.run({ allowCreate: true }), SnapshotConflict, fault);
    assert.ok(!f.calls.includes("upsert:ready:1"));
    assert.equal(f.pages.get(period.pageName).blocks.length, 1, "ambiguous task write is not rolled back");
  }
});

test("wrong first-root left pointer cannot commit; a header is required immediately after metadata parsing", async () => {
  const f = fixture([root("TODO task", 2)]);
  const insert = f.sdk.Editor.insertBlock;
  f.sdk.Editor.insertBlock = async (...args) => {
    const result = await insert(...args);
    if (args[2].isPageBlock) return result;
    f.find(result.uuid).block.left.id = f.pages.get(period.pageName).id;
    return result;
  };
  await assert.rejects(f.run({ allowCreate: true }), /could not be verified/);
  assert.equal(f.pages.get(period.pageName).header.properties["jr-snapshot-state"], "writing:0");
  const g = fixture();
  const update = g.sdk.Editor.updateBlock;
  g.sdk.Editor.updateBlock = async (...args) => {
    await update(...args);
    g.pages.get(period.pageName).header = null;
  };
  await assert.rejects(g.run({ allowCreate: true }), /header/);
  assert.equal(g.upserts.length, 0);
  assert.equal(g.pages.size, 2, "no rollback or header reconstruction");
});

test("titled snapshots put nested task roots under an editable native summary", async () => {
  const f = fixture([root("DONE first", 2, [root("WAITING child", 3, [root("Notes", 4)])]), root("TODO second", 5)]);
  const title = "Week of 2024-12-30";
  const result = await f.run({ allowCreate: true, displayTitle: title });
  const page = f.pages.get(period.pageName), plan = JSON.parse(page.properties["jr-snapshot-plan"]);
  assert.deepEqual(result, { status: "created", pageName: period.pageName, empty: false, viewBlockId: plan.ids[0] });
  assert.equal(plan.version, 2);
  assert.equal(plan.displayTitle, title);
  assert.equal(plan.ids.length, 5);
  assert.deepEqual(page.blocks.map(text), [title]);
  assert.deepEqual(page.blocks[0].children.map(text), ["TODO first", "TODO second"]);
  assert.deepEqual(page.blocks[0].children[0].children.map(text), ["TODO child"]);
  assert.deepEqual(page.blocks[0].children[0].children[0].children.map(text), ["Notes"]);
  assert.equal(page.blocks[0].left.id, page.header.id);
  assert.equal(page.blocks[0].parent.id, page.id);
  assert.equal(page.blocks[0].children[0].parent.id, page.blocks[0].id);
  assert.equal(f.insertions[0].anchor, page.header.uuid);
  assert.equal(f.insertions[1].anchor, plan.ids[0]);
  assert.equal(f.insertions[1].options.sibling, false);
  assert.equal(f.insertions[4].options.sibling, true);
  page.blocks[0].content = "My own summary";
  page.blocks[0].children[0].content = "DONE edited task";
  f.definition.blocks = [];
  const before = copy(page);
  f.calls.length = 0;
  assert.deepEqual(await f.run({ displayTitle: "A new title" }),
    { status: "existing", pageName: period.pageName, empty: false, viewBlockId: plan.ids[0] });
  assert.deepEqual(page, before, "completed user edits are never replaced");
  assert.ok(!f.calls.includes("insertBlock"));
});

test("interrupted titled snapshots reconcile the root and nested writes without duplicates", async () => {
  for (const interrupted of ["insertBlock", "upsert:ready:1", "upsert:ready:2"]) {
    const f = fixture([root("TODO parent", 2, [root("DONE child", 3)])]);
    f.failNext(interrupted, interrupted === "insertBlock" ? "null" : "throw");
    await assert.rejects(f.run({ allowCreate: true, displayTitle: "Weekly tasks" }));
    const page = f.pages.get(period.pageName), plan = JSON.parse(page.properties["jr-snapshot-plan"]);
    const result = await f.run(); // The saved title, not a new argument, drives the fingerprint.
    assert.deepEqual(result, { status: "resumed", pageName: period.pageName, empty: false, viewBlockId: plan.ids[0] });
    assert.deepEqual(page.blocks.map(text), ["Weekly tasks"]);
    assert.deepEqual(page.blocks[0].children.map(text), ["TODO parent"]);
    assert.deepEqual(page.blocks[0].children[0].children.map(text), ["TODO child"]);
    assert.equal(page.header.properties["jr-snapshot-state"], "populated");
  }
  const f = fixture([root("TODO task", 2)]);
  f.failNext("insertBlock", "null");
  await assert.rejects(f.run({ allowCreate: true, displayTitle: "Weekly tasks" }), /ambiguous/);
  f.pages.get(period.pageName).blocks[0].content = "User changed in-flight title";
  const before = f.insertions.length;
  await assert.rejects(f.run(), /deleted or edited/);
  assert.equal(f.insertions.length, before);
});

test("completed titled pages report an unavailable summary when the planned root cannot be verified, never repairing it", async () => {
  for (const fault of ["deleted", "moved", "replaced"]) {
    const f = fixture([root("TODO once", 2)]);
    const created = await f.run({ allowCreate: true, displayTitle: "Current week" });
    const page = f.pages.get(period.pageName);
    if (fault === "deleted") page.blocks = [];
    if (fault === "moved") page.blocks[0].parent.id = page.blocks[0].children[0].id;
    if (fault === "replaced") page.blocks[0].uuid = uuid(999);
    const before = copy(page), inserts = f.insertions.length;
    assert.deepEqual(await f.run(), { status: "existing", pageName: period.pageName, empty: false, viewUnavailable: true }, fault);
    assert.deepEqual(page, before);
    assert.equal(f.insertions.length, inserts);
    assert.ok(created.viewBlockId);
  }
});

test("old completed plans remain page-only, even when a display title is later supplied", async () => {
  const f = fixture([root("TODO old", 2)]);
  const first = await f.run({ allowCreate: true });
  const page = f.pages.get(period.pageName), before = copy(page), inserts = f.insertions.length;
  assert.equal(first.viewBlockId, undefined);
  assert.deepEqual(await f.run({ displayTitle: "Current week" }),
    { status: "existing", pageName: period.pageName, empty: false });
  assert.deepEqual(page, before);
  assert.equal(f.insertions.length, inserts);
});

test("empty titled definitions still report empty and invalid titles do not create pages", async () => {
  const f = fixture();
  for (const title of ["", "  ", " title ", "a\nb", "TODO task", "id:: hidden", "```code"]) {
    await assert.rejects(f.run({ allowCreate: true, displayTitle: title }), TypeError);
  }
  assert.equal(f.pages.size, 1);
  const result = await f.run({ allowCreate: true, displayTitle: "Nothing planned" });
  assert.equal(result.empty, true);
  assert.equal(result.viewBlockId, f.pages.get(period.pageName).blocks[0].uuid);
  assert.equal(f.pages.get(period.pageName).header.properties["jr-snapshot-state"], "populated");
  assert.deepEqual(await f.run(), { ...result, status: "existing" });
});

test("verification stays local with constant tree reads rather than one per insertion", async () => {
  const small = fixture([root("TODO task", 2)]);
  const f = fixture(Array.from({ length: 20 }, (_, index) => root(`TODO task ${index}`, index + 2)));
  await small.run({ allowCreate: true });
  await f.run({ allowCreate: true });
  const count = (fixture, call) => fixture.calls.filter((name) => name === call).length;
  assert.equal(count(f, "getPageBlocksTree"), count(small, "getPageBlocksTree"), "bootstrap verification adds constant reads, not per-task tree scans");
  assert.equal(count(f, "getBlock") - count(small, "getBlock"), 19 * 6, "each additional task uses two insert checks and four checkpoint header checks");
  assert.equal(f.calls.slice(f.calls.indexOf("upsert:writing:0")).filter((call) => call === "getPageBlocksTree").length, 1, "only final verification rereads the tree after snapshot writes begin");
  f.calls.length = 0;
  await f.run();
  assert.deepEqual(f.calls, ["getPage", "getPageBlocksTree", "getBlock"]);
});
