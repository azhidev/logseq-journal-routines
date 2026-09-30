import assert from "node:assert/strict";
import test from "node:test";
import { ensureRoutineHistory, HISTORY_PAGE, historyQuery } from "./routine-history.js";

// Text fixtures only: these tests do NOT execute DataScript or validate Desktop
// query rendering, page links, result-transform support, or large-result behavior.
for (const kind of ["weekly", "monthly"]) {
  test(`fixture-only native ${kind} history query uses owned metadata and newest-first page results`, () => {
    const query = historyQuery(kind);
    assert.ok(query.includes(":find (pull ?p [*])"));
    assert.ok(query.includes("[?p :block/name ?name]"));
    assert.ok(query.includes(`[(= ?kind "${kind}")]`));
    assert.ok(query.includes('#{"gregorian" "jalali"}'));
    for (const property of ["jr-period-id", "jr-calendar", "jr-kind", "jr-start", "jr-end"]) {
      assert.ok(query.includes(`:${property}`));
    }
    assert.ok(query.includes('[(str "journal-routines:" ?calendar ":" ?kind ":" ?start ":" ?end) ?expected]'));
    assert.ok(query.includes("[(= ?id ?expected)]"));
    assert.ok(query.includes("(compare b a)"));
    assert.ok(query.includes(":result-transform"));
    assert.equal(query.includes(":view"), false, "native rendering owns original-page links");
    assert.ok(query.endsWith("#+END_QUERY"));
  });
}

test("history has exactly the two supported period kinds", () => {
  assert.throws(() => historyQuery("daily"), /Unknown history kind/);
});

const clone = (value) => structuredClone(value);
const uuid = (id) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const propertyContent = (properties) => Object.entries(properties).map(([key, value]) => `${key}:: ${value}`).join("\n");

// Source-audited 0.10.15 shape: the page and property pre-block are distinct
// entities. Bootstrap text parsing mirrors properties; later checkpoint upserts
// intentionally leave the page's mutable state stale.
function fixture({ tuples = false, flag = "preBlock" } = {}) {
  let page = null, next = 10;
  const records = new Map(), calls = [];
  const entity = () => {
    if (!page) return null;
    const { blocks, ...rest } = page;
    return clone(rest);
  };
  const find = (id) => page?.blocks.find((block) => block.uuid === id);
  const editor = {
    async getPage(name) { assert.equal(name, HISTORY_PAGE); return entity(); },
    async checkEditing() { return false; },
    async createPage(name, properties, options) {
      assert.ok(properties == null || Object.keys(properties).length === 0,
        "nonempty createPage properties become an unserializable Bean on Desktop 0.10.15");
      assert.equal(properties, null);
      calls.push(["createPage"]);
      assert.equal(name, HISTORY_PAGE);
      assert.deepEqual(options, { redirect: false, createFirstBlock: false, format: "markdown" });
      assert.equal(page, null, "never recreate an existing page");
      page = { uuid: uuid(++next), id: next, name, format: "markdown", properties: {}, blocks: [] };
      return entity();
    },
    async newBlockUUID() { return uuid(++next); },
    async getPageBlocksTree(id) {
      assert.equal(id, page.uuid);
      return tuples ? page.blocks.map((block) => ["uuid", block.uuid]) : clone(page.blocks);
    },
    async getBlock(id) { return clone(find(id) ?? null); },
    async insertBlock(anchor, content, options) {
      if (options.isPageBlock) {
        calls.push(["bootstrapInsert", anchor]);
        assert.equal(anchor, HISTORY_PAGE, "bootstrap targets page NAME");
        assert.deepEqual(options, { sibling: false, isPageBlock: true, focus: false, customUUID: options.customUUID });
        assert.equal(content, "Journal & Routines metadata initialization");
        assert.equal(page.blocks.length, 0);
        assert.equal(find(options.customUUID), undefined);
        const block = { uuid: options.customUUID, id: ++next, content: `${content}\nid:: ${options.customUUID}`,
          properties: { id: options.customUUID }, children: [], page: { id: page.id }, parent: { id: page.id }, left: { id: page.id } };
        page.blocks.push(block);
        return clone(block);
      }
      calls.push(["insertBlock", anchor]);
      assert.deepEqual(options, { sibling: true, isPageBlock: false, focus: false, customUUID: options.customUUID });
      const previous = find(anchor);
      assert.ok(previous, "insert after header/previous query, never sibling to page");
      const block = { uuid: options.customUUID, id: ++next, content: `${content}\nid:: ${options.customUUID}`,
        children: [], page: { id: page.id }, parent: { id: page.id }, left: { id: previous.id } };
      const index = page.blocks.indexOf(previous) + 1;
      page.blocks.splice(index, 0, block);
      if (page.blocks[index + 1]) page.blocks[index + 1].left = { id: block.id };
      return clone(block);
    },
    async updateBlock(id, content) {
      calls.push(["bootstrapUpdate", id]);
      const block = find(id);
      assert.equal(block, page.blocks[0]);
      assert.equal(block.left.id, page.id);
      const parsed = {};
      for (const line of content.split("\n")) {
        const match = /^([^\s:]+):: (.*)$/.exec(line);
        assert.ok(match, "metadata update must contain native property text only");
        parsed[match[1]] = match[2];
      }
      block.content = content;
      block.properties = parsed;
      block[flag] = true;
      page.properties = clone(parsed);
    },
    async upsertBlockProperty(id, key, value) {
      calls.push(["property", id, key, value]);
      assert.notEqual(id, page.uuid, "page UUID is not a block property target");
      const block = find(id);
      assert.equal(block?.[flag], true, "state belongs to the header");
      block.properties[key] = value;
      block.content = propertyContent(block.properties);
    },
  };
  const storage = {
    async get(key) { return records.get(key) ?? null; },
    async set(key, value) { calls.push(["storage.set", key]); records.set(key, clone(value)); },
  };
  return { editor, calls, records, page: () => page, deletePage: () => { page = null; },
    ensure: () => ensureRoutineHistory({ sdk: { Editor: editor }, storage, graphKey: "fixture-graph", guard: async () => {} }),
  };
}

for (const flag of ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]) {
  for (const tuples of [false, true]) {
    test(`header-aware creation and reopen: ${flag}, tuple tree=${tuples}`, async () => {
      const f = fixture({ flag, tuples });
      assert.equal((await f.ensure()).status, "created");
      const page = f.page(), [header, weekly, monthly] = page.blocks;
      assert.equal(page.properties["jr-history-state"], "initializing", "page state is stale");
      assert.equal(header.properties["jr-history-state"], "ready");
      assert.notEqual(header.uuid, page.uuid);
      assert.notEqual(header.uuid, weekly.uuid);
      assert.notEqual(header.uuid, monthly.uuid);
      assert.deepEqual(f.calls.slice(0, 4).map(([kind]) => kind),
        ["storage.set", "createPage", "bootstrapInsert", "bootstrapUpdate"], "tombstone precedes all graph writes");
      assert.equal(header.left.id, page.id);
      assert.equal(weekly.left.id, header.id);
      assert.equal(monthly.left.id, weekly.id);
      assert.equal(weekly.parent.id, page.id);
      assert.equal(weekly.content, `${historyQuery("weekly")}\nid:: ${weekly.uuid}`);
      assert.deepEqual(f.calls.filter(([kind]) => kind === "property"), [["property", header.uuid, "jr-history-state", "ready"]]);
      const before = clone(page), writes = f.calls.length;
      assert.equal((await f.ensure()).status, "existing");
      assert.deepEqual(page, before);
      assert.equal(f.calls.length, writes);
    });
  }
}

test("fixture rejects the nonempty createPage properties Bean regression", async () => {
  const f = fixture();
  await assert.rejects(f.editor.createPage(HISTORY_PAGE, { "jr-history-version": "v1" }, {}), /unserializable Bean/);
  assert.equal(f.page(), null);
});

test("an existing unrelated history page is a collision, never a bootstrap target", async () => {
  const f = fixture();
  await f.editor.createPage(HISTORY_PAGE, null, { redirect: false, createFirstBlock: false, format: "markdown" });
  const before = clone(f.page()), writes = f.calls.length;
  await assert.rejects(f.ensure(), /ownership collision/);
  assert.deepEqual(f.page(), before);
  assert.equal(f.calls.length, writes);
  assert.equal(f.records.size, 0);
});

for (const operation of ["createPage", "insertBlock", "updateBlock"]) {
  test(`ambiguous ${operation} bootstrap acknowledgement preserves tombstone without repair`, async () => {
    const f = fixture();
    const original = f.editor[operation];
    f.editor[operation] = async (...args) => {
      await original(...args);
      throw new Error("lost bootstrap acknowledgement");
    };
    await assert.rejects(f.ensure(), /History creation outcome is ambiguous.*lost bootstrap acknowledgement/);
    assert.equal([...f.records.values()][0], true);
    const before = clone(f.page()), writes = f.calls.length;
    await assert.rejects(f.ensure(), /collision|incomplete or ambiguous/);
    assert.deepEqual(f.page(), before);
    assert.equal(f.calls.length, writes, "never retry an ambiguous bootstrap");
    assert.equal(f.calls.filter(([kind]) => kind === "insertBlock" || kind === "property").length, 0);
  });
}

test("completed history ignores stale mutable page aliases but requires matching immutable owners", async () => {
  const f = fixture(); await f.ensure();
  f.page().properties.jrHistoryState = "stale-alias";
  f.page().properties["jr-history-state"] = "even-older";
  assert.equal((await f.ensure()).status, "existing");
  f.page().properties.jrHistoryVersion = "other-owner";
  await assert.rejects(f.ensure(), /Conflicting.*aliases/);
});

test("header raw/camelCase properties agree independently of stale page state", async () => {
  const f = fixture(); await f.ensure();
  const header = f.page().blocks[0];
  header["block/properties"] = { jrHistoryVersion: "v1", jrHistoryState: "ready" };
  assert.equal((await f.ensure()).status, "existing");
  header["block/properties"].jrHistoryState = "initializing";
  await assert.rejects(f.ensure(), /Conflicting.*aliases/);
});

const malformedHeaders = {
  missing: (page) => { page.blocks = []; },
  unmarked: (page) => { delete page.blocks[0].preBlock; },
  duplicate: (page) => { page.blocks.push(clone(page.blocks[0])); },
  "missing uuid": (page) => { delete page.blocks[0].uuid; },
  "page uuid": (page) => { page.blocks[0].uuid = page.uuid; },
  "missing id": (page) => { delete page.blocks[0].id; },
  "page id": (page) => { page.blocks[0].id = page.id; },
  "missing page": (page) => { delete page.blocks[0].page; },
  "wrong page": (page) => { page.blocks[0].page.id++; },
  "wrong parent": (page) => { page.blocks[0].parent.id++; },
  "wrong left": (page) => { page.blocks[0].left.id++; },
  "missing parent": (page) => { delete page.blocks[0].parent; },
  "missing left": (page) => { delete page.blocks[0].left; },
  "header children": (page) => { page.blocks[0].children.push({ content: "user note" }); },
  "owner disagreement": (page) => { page.blocks[0].properties["jr-history-version"] = "other"; },
  "missing owner": (page) => { delete page.blocks[0].properties["jr-history-version"]; },
  "conflicting pre-block flags": (page) => { page.blocks[0]["pre-block?"] = false; },
};
for (const [name, mutate] of Object.entries(malformedHeaders)) {
  test(`ambiguous header ${name} prevents population and is never repaired`, async () => {
    const f = fixture();
    const update = f.editor.updateBlock;
    f.editor.updateBlock = async (...args) => { const result = await update(...args); mutate(f.page()); return result; };
    await assert.rejects(f.ensure(), /creation outcome is ambiguous/i);
    const before = clone(f.page());
    await assert.rejects(f.ensure(), /header|aliases/i);
    assert.deepEqual(f.page(), before);
    assert.equal(f.calls.filter(([kind]) => kind === "createPage").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "insertBlock" || kind === "property").length, 0);
  });
}

test("a replaced header during initialization prevents later query/checkpoint writes", async () => {
  const f = fixture();
  const insert = f.editor.insertBlock;
  f.editor.insertBlock = async (...args) => {
    const result = await insert(...args);
    if (!args[2].isPageBlock) f.page().blocks[0].uuid = uuid(999);
    return result;
  };
  await assert.rejects(f.ensure(), /header identity changed/);
  assert.equal(f.calls.filter(([kind]) => kind === "insertBlock").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "property").length, 0);
  await assert.rejects(f.ensure(), /incomplete or ambiguous/);
});

test("a no-op header checkpoint cannot complete history using page properties", async () => {
  const f = fixture();
  f.editor.upsertBlockProperty = async () => { f.page().properties["jr-history-state"] = "ready"; };
  await assert.rejects(f.ensure(), /incomplete or ambiguous/);
  const before = clone(f.page());
  await assert.rejects(f.ensure(), /incomplete or ambiguous/);
  assert.deepEqual(f.page(), before);
  assert.equal(f.calls.filter(([kind]) => kind === "insertBlock").length, 2);
});

test("header getBlock/tree read disagreement pauses without falling back to page state", async () => {
  const f = fixture(); await f.ensure();
  const getBlock = f.editor.getBlock;
  f.editor.getBlock = async (...args) => {
    const block = await getBlock(...args);
    if (block?.preBlock) block.properties["jr-history-state"] = "initializing";
    return block;
  };
  await assert.rejects(f.ensure(), /incomplete or ambiguous/);
});

test("edited/deleted query blocks stay deleted; deleted headers/pages are not rebuilt", async () => {
  const f = fixture(); await f.ensure();
  const page = f.page();
  page.blocks[1].content = "user replacement";
  page.blocks.pop();
  const before = clone(page), writes = f.calls.length;
  await f.ensure(); assert.deepEqual(page, before);
  page.blocks.splice(1);
  await f.ensure(); assert.equal(page.blocks.length, 1, "header alone is a deliberately empty completed page");
  page.blocks = [];
  await assert.rejects(f.ensure(), /header is missing/);
  assert.equal(page.blocks.length, 0);
  assert.equal(f.calls.length, writes);
  f.deletePage();
  await assert.rejects(f.ensure(), /preserved as deleted/);
  assert.equal(f.page(), null);
  assert.equal(f.calls.length, writes);
});
