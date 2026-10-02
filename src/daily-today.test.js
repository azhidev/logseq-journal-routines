import test from "node:test";
import assert from "node:assert/strict";
import { applyDailyTemplateToToday } from "./daily-today.js";
import { DAILY_TEMPLATE, DAILY_TEMPLATE_PAGE, dailyTemplateNodes } from "./daily-template.js";

const clone = (value) => structuredClone(value);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const applyKey = (graph = "graph-a", day = 20261001, page = uuid(1)) => `journal-routines:daily-today:v1:${graph}:${day}:${page}`;
const installKey = "journal-routines:daily-template:v1:graph-a";
const withoutID = (block) => block.content.split("\n").filter((line) => line !== `id:: ${block.uuid}`).join("\n");
function fixture({ empty = false, tuples = false } = {}) {
  const calls = [], events = [], records = new Map();
  let allowed = true, editing = false, next = 500, hook = async () => {};
  const config = { enabledJournals: true, preferredFormat: "markdown" };
  const page = (id, name, day) => ({ id, uuid: uuid(id), name, format: "markdown", properties: {},
    ...(day ? { journalDay: day, "journal?": true } : {}), blocks: [] });
  const today = page(1, "native title — not a formatted date", 20261001);
  const tomorrow = page(2, "tomorrow native title", 20261002);
  const owner = page(10, DAILY_TEMPLATE_PAGE.toLowerCase());
  owner.properties["jr-daily-template-version"] = "v1";
  function block(parent, page, content, id, properties = {}) {
    const list = parent.blocks ?? parent.children;
    const result = { id, uuid: uuid(id), content, properties, children: [], page: { id: page.id },
      parent: { id: parent.id }, left: { id: list.at(-1)?.id ?? parent.id } };
    list.push(result); return result;
  }
  const header = block(owner, owner, "jr-daily-template-version:: v1\njr-daily-template-state:: ready", 11,
    { "jr-daily-template-version": "v1", "jr-daily-template-state": "ready" });
  header.preBlock = true;
  const root = block(owner, owner, `Daily journal template\ntemplate:: ${DAILY_TEMPLATE}\ntemplate-including-parent:: false`, 12,
    { template: DAILY_TEMPLATE, "template-including-parent": false });
  const source = [];
  for (const [i, node] of dailyTemplateNodes().entries()) {
    const parent = node.parent === null ? root : source[node.parent];
    source.push(block(parent, owner, node.content, 20 + i));
  }
  const anchor = empty ? null : block(today, today, "", 40);
  block(tomorrow, tomorrow, "Keep tomorrow unchanged", 41);
  records.set(installKey, { version: 1, state: "ready", pageUuid: owner.uuid, rootUuid: root.uuid, headerUuid: header.uuid });
  let rows = [[today.uuid, today.name, today.journalDay]], registered = root;
  const pages = [today, tomorrow, owner];
  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);
  const find = (id) => [...pages, ...pages.flatMap((page) => flatten(page.blocks))].find((entity) => entity.uuid === id);
  const entity = (page) => { if (!page) return null; const { blocks, ...rest } = page; return clone(rest); };
  function wire(block) {
    return { ...clone(block), children: tuples ? block.children.map((child) => ["uuid", child.uuid]) : block.children.map(wire) };
  }
  async function operation(name, args, fn) {
    assert.equal(events.at(-1), "guard", `${name} has a preceding graph guard`);
    calls.push([name, ...clone(args)]); events.push(name);
    await hook(name, "before", args);
    const result = fn();
    await hook(name, "after", args);
    return clone(result);
  }
  const sdk = {
    App: {
      getUserConfigs: () => operation("config", [], () => config),
      getTemplate: (name) => operation("getTemplate", [name], () => {
        assert.equal(name, DAILY_TEMPLATE);
        if (!registered) return null;
        const { children, ...metadata } = clone(registered);
        return metadata; // Native registration lookup does not load the subtree.
      }),
      insertTemplate: (target, name) => operation("insertTemplate", [target, name], () => {
        assert.equal(name, DAILY_TEMPLATE);
        const anchor = find(target);
        assert.ok(today.blocks.includes(anchor), "target belongs to today, not tomorrow or source");
        assert.equal(withoutID(anchor).trim(), "");
        // Audited native behavior: id:: text is not string/blank?, so retain it.
        today.blocks = anchor.content.trim() ? [anchor] : [];
        function copy(source, parent) {
          const id = ++next;
          const result = block(parent, today, `${withoutID(source)}\nid:: ${uuid(id)}`, id, { id: uuid(id) });
          for (const child of source.children) copy(child, result);
        }
        for (const section of root.children) copy(section, today);
        return null; // The native API has no insertion acknowledgement.
      }),
    },
    DB: {
      datascriptQuery: (query, input) => operation("query", [query, input], () => {
        assert.equal(input, ":today", "local civil day is resolved by native Logseq, not JS date formatting");
        for (const clause of ["[?p :block/journal-day ?today]", "[?p :block/journal? true]", "[?p :block/name ?name]"]) {
          assert.ok(query.includes(clause));
        }
        assert.ok(query.includes(":in $ ?today")); return rows;
      }),
    },
    Editor: {
      getPage: (key) => operation("getPage", [key], () => {
        assert.ok([uuid(1), today.uuid, DAILY_TEMPLATE_PAGE].includes(key), "no formatted title or graph inventory");
        return entity(key === DAILY_TEMPLATE_PAGE ? owner : pages.find((page) => page.uuid === key));
      }),
      getPageBlocksTree: (key) => operation("tree", [key], () => {
        assert.equal(key, today.uuid, "only today's exact journal tree is read");
        return tuples ? today.blocks.map((block) => ["uuid", block.uuid]) : today.blocks.map(wire);
      }),
      getBlock: (id, options) => operation("getBlock", [id, options], () => {
        if (id === root.uuid) assert.deepEqual(options, { includeChildren: true });
        const entity = find(id); return entity?.children ? wire(entity) : null;
      }),
      newBlockUUID: () => operation("uuid", [], () => uuid(++next)),
      checkEditing: () => operation("editing", [], () => editing),
      insertBlock: (name, content, options) => operation("insertBlock", [name, content, options], () => {
        assert.equal(name, today.name, "verified native name, never date formatted");
        assert.equal(content, "");
        assert.deepEqual(options, { isPageBlock: true, sibling: false, focus: false, customUUID: options.customUUID });
        assert.equal(today.blocks.length, 0);
        const result = block(today, today, `\nid:: ${options.customUUID}`, ++next, { id: options.customUUID });
        result.uuid = options.customUUID;
        return wire(result);
      }),
    },
  };
  const storage = {
    get: (key) => operation("storage.get", [key], () => records.get(key) ?? null),
    set: (key, value) => operation("storage.set", [key, value], () => { records.set(key, clone(value)); }),
  };
  const args = { sdk, storage, graphKey: "graph-a", guard: async () => {
    events.push("guard"); if (!allowed) throw new Error("Graph changed or routines disabled");
  } };
  return { sdk, storage, args, records, calls, events, today, tomorrow, owner, root, source, anchor, config,
    apply: () => applyDailyTemplateToToday(args),
    writes: () => calls.filter(([name]) => ["insertBlock", "insertTemplate"].includes(name)),
    setRows(value) { rows = value; }, setRegistered(value) { registered = value; },
    setEditing(value) { editing = value; }, stop() { allowed = false; },
    setHook(value) { hook = value; }, add: block,
  };
}

for (const empty of [false, true]) {
  for (const tuples of [false, true]) {
    test(`native today application verifies ${empty ? "empty page" : "blank root"}, tuples=${tuples}`, async () => {
      const f = fixture({ empty, tuples }), tomorrow = clone(f.tomorrow), source = clone(f.owner);
      const result = await f.apply();
      assert.deepEqual(result, { pageUuid: f.today.uuid, pageName: f.today.name, journalDay: 20261001, templateName: DAILY_TEMPLATE });
      assert.deepEqual(f.tomorrow, tomorrow, "tomorrow is never targeted");
      assert.deepEqual(f.owner, source, "native source stays unchanged");
      const sections = f.today.blocks.filter((block) => withoutID(block).trim());
      assert.deepEqual(sections.map(withoutID), f.root.children.map(withoutID));
      assert.equal(sections.length, 5);
      assert.equal(f.calls.filter(([name]) => name === "insertTemplate").length, 1);
      assert.equal(f.calls.filter(([name]) => name === "insertBlock").length, Number(empty));
      const markerAt = f.calls.findIndex(([name]) => name === "storage.set");
      assert.ok(markerAt < f.calls.findIndex(([name]) => ["insertBlock", "insertTemplate"].includes(name)));
      assert.equal(f.records.get(applyKey()).state, "attempted");
      assert.equal(JSON.stringify(f.records.get(applyKey())).includes("BEGIN_QUERY"), false, "attempt stores metadata, not task text");
      for (const [i, call] of f.calls.entries()) {
        if (["insertBlock", "insertTemplate"].includes(call[0])) assert.equal(f.calls[i - 1][0], "editing");
      }
      assert.equal(f.events.at(-1), "guard", "last native read is guarded after completion");
      const writes = f.writes().length;
      await assert.rejects(f.apply(), /previously attempted/);
      f.today.blocks = [];
      await assert.rejects(f.apply(), /previously attempted/);
      assert.equal(f.writes().length, writes, "successful or deliberately emptied journals are never rebuilt");
    });
  }
}

test("flat native template registration loads the verified subtree through getBlock", async () => {
  const f = fixture({ tuples: true });
  await f.apply();
  const rootReads = f.calls.filter(([name, id]) => name === "getBlock" && id === f.root.uuid);
  assert.equal(rootReads.length, 2, "source is loaded and revalidated separately from registration");
  assert.ok(rootReads.every(([, , options]) => options.includeChildren === true));
  assert.equal(f.today.blocks.length, 5);
});

for (const [name, change] of [
  ["UUID", (root) => { root.uuid = uuid(99); }],
  ["numeric id", (root) => { root.id = 99; }],
  ["page", (root) => { root.page.id = 99; }],
]) {
  test(`registration and fetched subtree must agree on ${name}`, async () => {
    const f = fixture(), registered = clone(f.root);
    change(registered); f.setRegistered(registered);
    await assert.rejects(f.apply(), /cannot be verified/);
    assert.equal(f.writes().length, 0);
    assert.equal(f.records.has(applyKey()), false);
  });
}

test("missing registered root subtree fails before any journal write", async () => {
  const f = fixture(), getBlock = f.sdk.Editor.getBlock;
  f.sdk.Editor.getBlock = (id, options) => id === f.root.uuid ? null : getBlock(id, options);
  await assert.rejects(f.apply(), /cannot be verified/);
  assert.equal(f.writes().length, 0);
});

test("user-edited source section content and nested query structure are copied only by native API", async () => {
  const f = fixture({ tuples: true });
  f.root.children[0].content = "## My focus";
  f.source[5].content = "#+BEGIN_QUERY\n{:title \"Custom query\"}\n#+END_QUERY";
  f.add(f.source[5], f.owner, "Nested custom note", 99);
  await f.apply();
  assert.equal(f.today.blocks[0].content.split("\n")[0], "## My focus");
  assert.equal(f.today.blocks[2].children[0].children[0].content.split("\n")[0], "Nested custom note");
  assert.equal(f.writes().length, 1, "no plugin task-cloning writes");
});

test("matching id properties/lines and explicit false header aliases are safe; native anchor may remain", async () => {
  const f = fixture();
  f.anchor.content = `  \nid:: ${f.anchor.uuid}`;
  f.anchor.properties.id = f.anchor.uuid;
  f.anchor["block/properties"] = { id: f.anchor.uuid };
  f.anchor.preBlock = false; f.anchor["preBlock?"] = false;
  f.anchor["pre-block?"] = false; f.anchor["block/pre-block?"] = false;
  f.today["journal-day"] = 20261001; f.today["block/journal-day"] = 20261001; f.today.isJournal = true;
  await f.apply();
  assert.equal(f.today.blocks.length, 6, "native id-bearing anchor is preserved, not deleted");
  assert.equal(f.today.blocks[0], f.anchor);
});

for (const value of [undefined, null, [], "block-uuid"]) {
  test(`editing must be exactly false, not ${JSON.stringify(value)}`, async () => {
    const f = fixture(); f.setEditing(value);
    await assert.rejects(f.apply(), /Finish editing/);
    assert.equal(f.writes().length, 0);
    assert.equal(f.records.has(applyKey()), false);
  });
}
for (const [name, edit] of [
  ["journals disabled", (f) => { f.config.enabledJournals = false; }],
  ["journals ambiguous", (f) => { f.config.enabledJournals = "true"; }],
  ["Org preference", (f) => { f.config.preferredFormat = "org"; }],
]) {
  test(name, async () => {
    const f = fixture(); edit(f);
    await assert.rejects(f.apply(), /Enable native journals/);
    assert.equal(f.writes().length, 0);
  });
}

test("missing today fails actionably rather than selecting tomorrow or navigating", async () => {
  const f = fixture(); f.setRows([]);
  await assert.rejects(f.apply(), /Open today’s journal in Logseq first/);
  assert.equal(f.writes().length, 0);
  assert.deepEqual(f.calls.map(([name]) => name), ["config", "query"]);
});
for (const rows of [null, [[uuid(1), "name"]], [[uuid(1), "name", 20261001], [uuid(2), "name", 20261002]],
  [["invalid", "name", 20261001]], [[uuid(1), "", 20261001]], [[uuid(1), "name", "20261001"]],
  [[uuid(1), "name", 20261301]], [[uuid(1), "name", 20260230]]]) {
  test(`ambiguous/malformed native today lookup ${JSON.stringify(rows)}`, async () => {
    const f = fixture(); f.setRows(rows);
    await assert.rejects(f.apply(), /ambiguous|invalid/);
    assert.equal(f.writes().length, 0);
  });
}
for (const [name, edit] of [
  ["day aliases conflict", (f) => { f.today["journal-day"] = 20261002; }],
  ["raw day aliases conflict", (f) => { f.today["block/journal-day"] = "20261001"; }],
  ["journal aliases conflict", (f) => { f.today.isJournal = false; }],
  ["non-journal", (f) => { f.today["journal?"] = false; }],
  ["day missing", (f) => { delete f.today.journalDay; }],
  ["page name mismatch", (f) => { f.today.name = "different"; }],
  ["page UUID mismatch", (f) => { f.today.uuid = uuid(55); }],
  ["invalid numeric id", (f) => { f.today.id = 0; }],
  ["Org journal", (f) => { f.today.format = "org"; }],
]) {
  test(name, async () => {
    const f = fixture(); edit(f);
    await assert.rejects(f.apply(), /aliases|cannot be verified/);
    assert.equal(f.writes().length, 0);
  });
}
for (const [name, edit] of [
  ["populated journal", (f) => { f.anchor.content = "TODO Preserve me"; }],
  ["existing template section", (f) => { f.anchor.content = "## Focus"; }],
  ["multiple blank roots", (f) => { f.add(f.today, f.today, "", 42); }],
  ["blank parent with child", (f) => { f.add(f.anchor, f.today, "", 42); }],
  ["property header", (f) => { f.anchor.preBlock = true; }],
  ["raw property header", (f) => { f.anchor["block/pre-block?"] = true; }],
  ["conflicting header aliases", (f) => { f.anchor.preBlock = false; f.anchor["pre-block?"] = true; }],
  ["invalid header flag", (f) => { f.anchor.preBlock = "false"; }],
  ["user property", (f) => { f.anchor.properties.priority = "A"; }],
  ["raw user property", (f) => { f.anchor["block/properties"] = { custom: "keep" }; }],
  ["mismatched id property", (f) => { f.anchor.properties.id = uuid(100); }],
  ["mismatched id text", (f) => { f.anchor.content = `id:: ${uuid(100)}`; }],
  ["malformed property map", (f) => { f.anchor.properties = []; }],
  ["wrong page", (f) => { f.anchor.page.id = f.tomorrow.id; }],
  ["wrong parent", (f) => { f.anchor.parent.id = f.tomorrow.id; }],
  ["wrong left", (f) => { f.anchor.left.id = f.tomorrow.id; }],
  ["missing children", (f) => { f.sdk.Editor.getPageBlocksTree = async () => [{ ...f.anchor, children: undefined }]; }],
]) {
  test(`refuse ${name} without touching journal content`, async () => {
    const f = fixture(); edit(f); const before = clone(f.today);
    await assert.rejects(f.apply(), /populated|header|aliases|properties|identities|ambiguous/);
    assert.equal(f.writes().length, 0);
    assert.deepEqual(f.today, before);
    assert.equal(f.records.has(applyKey()), false);
  });
}

for (const [name, edit] of [
  ["not installed", (f) => { f.records.delete(installKey); }],
  ["installation incomplete", (f) => { f.records.get(installKey).state = "attempted"; }],
  ["wrong installed page", (f) => { f.records.get(installKey).pageUuid = uuid(55); }],
  ["wrong installed root", (f) => { f.records.get(installKey).rootUuid = uuid(55); }],
  ["missing registration", (f) => { f.setRegistered(null); }],
  ["owner missing", (f) => { delete f.owner.properties["jr-daily-template-version"]; }],
  ["conflicting owner properties", (f) => { f.owner["block/properties"] = { "jr-daily-template-version": "other" }; }],
  ["wrong root page", (f) => { f.root.page.id = f.today.id; }],
  ["root includes parent", (f) => { f.root.properties["template-including-parent"] = true; }],
  ["root text disagrees", (f) => { f.root.content = f.root.content.replace("parent:: false", "parent:: true"); }],
  ["root text duplicates", (f) => { f.root.content += "\ntemplate-including-parent:: false"; }],
  ["not five sections", (f) => { f.root.children.pop(); }],
  ["source wrong page", (f) => { f.source[0].page.id = f.today.id; }],
  ["source duplicate UUID", (f) => { f.source[1].uuid = f.source[0].uuid; }],
]) {
  test(`refuse unverified template: ${name}`, async () => {
    const f = fixture(); edit(f);
    await assert.rejects(f.apply(), /Install|verified|Conflicting|disagree|five|identities/);
    assert.equal(f.writes().length, 0);
    assert.equal(f.records.has(applyKey()), false);
  });
}

test("template expansion is bounded to 100 blocks including root", async () => {
  const f = fixture();
  for (let i = 0; i < 90; i++) f.add(f.source[5], f.owner, `note ${i}`, 100 + i);
  await assert.rejects(f.apply(), /100 blocks/);
  assert.equal(f.writes().length, 0);
});

for (const entry of [["wrong", uuid(40)], ["uuid", "invalid"], ["uuid", uuid(40), "extra"], ["uuid", uuid(999)]]) {
  test(`malformed/missing SDK tuple ${JSON.stringify(entry)} fails closed`, async () => {
    const f = fixture(); f.sdk.Editor.getPageBlocksTree = async () => [entry];
    await assert.rejects(f.apply(), /tuple|lookup changed/);
    assert.equal(f.writes().length, 0);
  });
}

for (const name of ["config", "query", "getPage", "getTemplate", "tree", "editing", "storage.set", "insertBlock", "insertTemplate"]) {
  test(`graph/disable guard halts subsequent operations after ${name}`, async () => {
    const f = fixture({ empty: name === "insertBlock" });
    f.setHook((kind, phase) => { if (kind === name && phase === "after") f.stop(); });
    await assert.rejects(f.apply(), /Graph changed or routines disabled/);
    assert.equal(f.calls.at(-1)[0], name, "no subsequent SDK/storage operation after invalidation");
    assert.equal(f.writes().length, ["insertBlock", "insertTemplate"].includes(name) ? 1 : 0);
  });
}

test("durable marker write failure prevents all journal writes", async () => {
  const f = fixture();
  f.setHook((name, phase) => { if (name === "storage.set" && phase === "before") throw new Error("Storage unavailable"); });
  await assert.rejects(f.apply(), /Storage unavailable/);
  assert.equal(f.writes().length, 0);
});

test("native journals disabled after durable approval stop before insertion", async () => {
  const f = fixture();
  f.setHook((name, phase) => { if (name === "storage.set" && phase === "after") f.config.enabledJournals = false; });
  await assert.rejects(f.apply(), /Enable native journals/);
  assert.equal(f.writes().length, 0);
  assert.equal(f.records.has(applyKey()), true, "uncertain attempt remains protected");
});

for (const name of ["insertBlock", "insertTemplate"]) {
  test(`lost native ${name} acknowledgement never authorizes retry`, async () => {
    const f = fixture({ empty: name === "insertBlock" });
    f.setHook((kind, phase) => { if (kind === name && phase === "after") throw new Error("Lost native acknowledgement"); });
    await assert.rejects(f.apply(), /Lost native acknowledgement/);
    assert.equal(f.records.get(applyKey()).state, "attempted");
    f.setHook(async () => {});
    const writes = f.writes().length, before = clone(f.today);
    await assert.rejects(f.apply(), /previously attempted/);
    assert.equal(f.writes().length, writes);
    assert.deepEqual(f.today, before);
  });
}

for (const candidate of ["invalid", uuid(1), uuid(10), uuid(12)]) {
  test(`empty-journal blank identity must be fresh: ${candidate}`, async () => {
    const f = fixture({ empty: true }); f.sdk.Editor.newBlockUUID = async () => candidate;
    await assert.rejects(f.apply(), /occupied or ambiguous/);
    assert.equal(f.writes().length, 0);
    assert.equal(f.records.has(applyKey()), false);
  });
}

test("UUID-only blank insertion acknowledgement is verified by native tree read-back", async () => {
  const f = fixture({ empty: true, tuples: true }), insert = f.sdk.Editor.insertBlock;
  f.sdk.Editor.insertBlock = async (...args) => ({ uuid: (await insert(...args)).uuid });
  await f.apply();
  assert.equal(f.writes().filter(([name]) => name === "insertBlock").length, 1);
  assert.equal(f.writes().filter(([name]) => name === "insertTemplate").length, 1);
  const at = f.calls.findIndex(([name]) => name === "insertBlock");
  assert.deepEqual(f.calls.slice(at + 1, at + 5).map(([name]) => name), ["query", "getPage", "tree", "getBlock"]);
});

test("UUID-only acknowledgement without an actual blank block is not success", async () => {
  const f = fixture({ empty: true });
  f.sdk.Editor.insertBlock = async (name, content, options) => ({ uuid: options.customUUID });
  await assert.rejects(f.apply(), /blank block disappeared/);
  assert.equal(f.calls.some(([name]) => name === "insertTemplate"), false);
  assert.equal(f.records.has(applyKey()), true);
  await assert.rejects(f.apply(), /previously attempted/);
});

test("UUID-only acknowledgement cannot hide a populated inserted block", async () => {
  const f = fixture({ empty: true }), insert = f.sdk.Editor.insertBlock;
  f.sdk.Editor.insertBlock = async (...args) => {
    const result = await insert(...args);
    f.today.blocks[0].content = "Preserve a concurrent user edit";
    return { uuid: result.uuid };
  };
  await assert.rejects(f.apply(), /populated or changed/);
  assert.equal(f.calls.some(([name]) => name === "insertTemplate"), false);
  assert.equal(f.today.blocks[0].content, "Preserve a concurrent user edit");
});

test("blank-block insert with missing acknowledgement pauses before template insertion", async () => {
  const f = fixture({ empty: true }); f.sdk.Editor.insertBlock = async () => null;
  await assert.rejects(f.apply(), /insertion is uncertain/);
  assert.equal(f.calls.some(([name]) => name === "insertTemplate"), false);
  assert.equal(f.records.has(applyKey()), true);
});

test("editing starts after blank creation: no template insertion", async () => {
  const f = fixture({ empty: true });
  f.setHook((name, phase) => { if (name === "insertBlock" && phase === "after") f.setEditing(uuid(501)); });
  await assert.rejects(f.apply(), /Finish editing/);
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0][0], "insertBlock");
});

test("today rollover after an attempt does not write to yesterday or tomorrow", async () => {
  const f = fixture();
  f.setHook((name, phase) => {
    if (name === "storage.set" && phase === "after") {
      f.today.journalDay = 20261002;
      f.setRows([[f.today.uuid, f.today.name, 20261002]]);
    }
  });
  await assert.rejects(f.apply(), /changed during application/);
  assert.equal(f.writes().length, 0);
});

test("user journal edit during template revalidation is preserved and prevents native insertion", async () => {
  const f = fixture(); let reads = 0;
  f.setHook((name, phase) => {
    if (name === "getTemplate" && phase === "after" && ++reads === 2) f.anchor.content = "User added a task";
  });
  await assert.rejects(f.apply(), /populated or changed/);
  assert.equal(f.anchor.content, "User added a task");
  assert.equal(f.writes().length, 0);
});

test("source section edit after approval is not applied from a stale snapshot", async () => {
  const f = fixture();
  f.setHook((name, phase) => { if (name === "storage.set" && phase === "after") f.source[0].content = "Changed source"; });
  await assert.rejects(f.apply(), /source changed/);
  assert.equal(f.writes().length, 0);
});

for (const [name, corrupt] of [
  ["section content", (f) => { f.today.blocks[0].content = "Wrong section"; }],
  ["nested query", (f) => { f.today.blocks[2].children[0].content = "Wrong query"; }],
  ["missing section", (f) => { f.today.blocks.pop(); }],
  ["extra blank section", (f) => { f.add(f.today, f.today, "", 900); }],
  ["reused source UUID", (f) => { f.today.blocks[0].uuid = f.source[0].uuid; }],
  ["wrong page identity", (f) => { f.today.blocks[0].page.id = f.owner.id; }],
  ["wrong hierarchy", (f) => { f.today.blocks[2].children[0].parent.id = f.today.id; }],
]) {
  test(`read-back rejects ${name} without retry or cleanup`, async () => {
    const f = fixture();
    f.setHook((kind, phase) => { if (kind === "insertTemplate" && phase === "after") corrupt(f); });
    await assert.rejects(f.apply(), /could not be verified|identities/);
    const before = clone(f.today), writes = f.writes().length;
    f.setHook(async () => {});
    await assert.rejects(f.apply(), /previously attempted/);
    assert.equal(f.writes().length, writes);
    assert.deepEqual(f.today, before);
  });
}

test("native nil return without actual insertion fails read-back, never retries", async () => {
  const f = fixture(); f.sdk.App.insertTemplate = async () => null;
  await assert.rejects(f.apply(), /could not be verified/);
  assert.equal(f.today.blocks.length, 1);
  await assert.rejects(f.apply(), /previously attempted/);
});

test("existing unknown or malformed attempt markers block all journal writes", async () => {
  for (const marker of [{ state: "attempted" }, {}, "uncertain", false]) {
    const f = fixture(); f.records.set(applyKey(), marker);
    await assert.rejects(f.apply(), /previously attempted/);
    assert.equal(f.writes().length, 0);
  }
});

test("attempt markers are isolated by graph, native day and page UUID", async () => {
  const f = fixture();
  for (const key of [applyKey("graph-b"), applyKey("graph-a", 20261002), applyKey("graph-a", 20261001, uuid(99))]) {
    f.records.set(key, { state: "attempted" });
  }
  await f.apply();
  assert.equal(f.calls.filter(([name]) => name === "insertTemplate").length, 1);
  assert.equal(f.records.has(applyKey()), true);
});

test("overlapping applications to the same native journal are refused", async () => {
  const f = fixture(); let release, entered;
  const pending = new Promise((done) => { release = done; });
  const started = new Promise((done) => { entered = done; });
  f.setHook(async (name, phase) => {
    if (name === "storage.set" && phase === "before") { entered(); await pending; }
  });
  const first = f.apply();
  await started;
  await assert.rejects(f.apply(), /already in progress/);
  release(); await first;
  assert.equal(f.calls.filter(([name]) => name === "insertTemplate").length, 1);
});
