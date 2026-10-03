import assert from "node:assert/strict";
import test from "node:test";
import { createPageWithTextProperties } from "./page-metadata.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const copy = (value) => structuredClone(value);
const name = "Journal & Routines — Test";
const metadata = { "jr-kind": "weekly", "jr-plan": '{"version":1}', "jr-state": "initializing" };
const bootstrap = "Journal & Routines metadata initialization";

function fixture({ title = false, id = true, tuples = false, camel = false, flag = "preBlock" } = {}) {
  const f = { page: null, root: null, calls: [], before: {}, after: {}, editing: false, guarded: false };
  const props = (entity) => {
    const result = copy(entity);
    if (result && camel) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) =>
      [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
    return result;
  };
  function root(content, properties, pre = false) {
    return { id: 2, uuid: uuid(2), content, properties, [flag]: pre, format: "markdown",
      page: { id: 1 }, parent: { id: 1 }, left: { id: 1 }, children: [] };
  }
  const operations = {
    getPage: () => props(f.page),
    createPage: (pageName, properties, options) => {
      assert.equal(properties, null);
      assert.deepEqual(options, { redirect: false, createFirstBlock: false, format: "markdown" });
      f.page = { id: 1, uuid: uuid(1), name: pageName.toLowerCase(), properties: {} };
      if (title) f.root = root(`title:: ${name}`, { title: name }, true);
      return props(f.page);
    },
    getPageBlocksTree: (pageUUID) => {
      assert.equal(pageUUID, uuid(1));
      return f.root ? [tuples ? ["uuid", f.root.uuid] : props(f.root)] : [];
    },
    getBlock: (id) => id === f.root?.uuid ? props(f.root) : null,
    newBlockUUID: () => uuid(2),
    insertBlock: (anchor, content, options) => {
      assert.equal(anchor, name, "page NAME, never the page UUID");
      assert.equal(content, bootstrap);
      assert.deepEqual(options, { sibling: false, isPageBlock: true, focus: false, customUUID: uuid(2) });
      f.root = root(content + (id ? `\nid:: ${uuid(2)}` : ""), id ? { id: uuid(2) } : {});
      const ack = props(f.root);
      delete ack.id; // Native insertBlock returns the pre-transaction map.
      return ack;
    },
    checkEditing: () => f.editing,
    updateBlock: (...args) => {
      assert.equal(args.length, 2, "no properties or other options argument");
      const [id, text] = args;
      assert.equal(id, f.root.uuid);
      const properties = Object.fromEntries(text.split("\n").map((line) => line.split(/:: (.*)/s).slice(0, 2)));
      f.root.content = text;
      f.root.properties = properties;
      f.root[flag] = true;
      f.page.properties = copy(properties);
    },
  };
  f.guard = async () => { f.guards = (f.guards ?? 0) + 1; f.guarded = true; if (f.stale) throw new Error("graph changed"); };
  f.editor = Object.fromEntries(Object.entries(operations).map(([method, operation]) => [method, async (...args) => {
    assert.equal(f.guarded, true, `guard before ${method}`);
    f.guarded = false;
    f.calls.push({ method, args });
    await f.before[method]?.(args);
    let result = operation(...args);
    if (f.after[method]) result = await f.after[method](result, args);
    return result;
  }]));
  f.run = (overrides = {}) => createPageWithTextProperties({ editor: f.editor, name, properties: metadata, guard: f.guard, ...overrides });
  f.writes = () => f.calls.filter(({ method }) => ["createPage", "insertBlock", "updateBlock"].includes(method));
  return f;
}

for (const title of [false, true]) for (const tuples of [false, true]) {
  test(`native parser materializes exact mirrored metadata: title=${title}, tuples=${tuples}`, async () => {
    const f = fixture({ title, tuples });
    const page = await f.run();
    assert.deepEqual(page.properties, { ...(title ? { title: name } : { id: uuid(2) }), ...metadata });
    assert.equal(f.root.preBlock, true);
    assert.equal(f.guards, f.calls.length * 2);
    assert.deepEqual(f.writes().map(({ method }) => method), title ? ["createPage", "updateBlock"] : ["createPage", "insertBlock", "updateBlock"]);
    assert.ok(f.root.content.startsWith(title ? `title:: ${name}\n` : `id:: ${uuid(2)}\n`));
  });
}
for (const flag of ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]) {
  test(`SDK camel properties and native ${flag} alias`, async () => {
    const f = fixture({ camel: true, flag });
    const page = await f.run();
    assert.equal(page.properties.jrKind, "weekly");
  });
}
for (const title of [false, true]) for (const tuples of [false, true]) {
  test(`property-free creation verifies without bootstrap or metadata: title=${title}, tuples=${tuples}`, async () => {
    const f = fixture({ title, tuples });
    for (const method of ["newBlockUUID", "insertBlock", "updateBlock"]) delete f.editor[method];
    const page = await f.run({ properties: {} });
    assert.deepEqual(page.properties, {});
    assert.deepEqual(f.root, title ? {
      id: 2, uuid: uuid(2), content: `title:: ${name}`, properties: { title: name }, preBlock: true,
      format: "markdown", page: { id: 1 }, parent: { id: 1 }, left: { id: 1 }, children: [],
    } : null);
    assert.deepEqual(f.writes().map(({ method }) => method), ["createPage"]);
    assert.equal(f.guards, f.calls.length * 2);
  });
}
for (const bad of [null, undefined, {}, { id: 1, uuid: uuid(9), name }, { id: 1, uuid: uuid(1), name: "Other" }]) {
  test(`property-free creation refuses ambiguous acknowledgement: ${JSON.stringify(bad)}`, async () => {
    const f = fixture(); f.after.createPage = () => bad;
    await assert.rejects(f.run({ properties: {} }), /paused/);
    assert.equal(f.writes().length, 1);
  });
}
for (const mutation of [
  (f) => { f.page.properties.tags = "mine"; },
  (f) => { f.page.format = "org"; },
  (f) => { f.page["journal?"] = true; },
  (f) => { f.root.content += "\nMy note"; },
  (f) => { f.root.properties.tags = "mine"; },
  (f) => { f.root.parent.id = 99; },
]) {
  test(`property-free creation preserves unexpected page/header content: ${mutation}`, async () => {
    const f = fixture({ title: true });
    f.after.createPage = (ack) => { mutation(f); return ack; };
    await assert.rejects(f.run({ properties: {} }), /paused/);
    assert.equal(f.writes().length, 1);
  });
}
test("property-free creation refuses a new root arriving during verification", async () => {
  const f = fixture(); let reads = 0;
  f.before.getPageBlocksTree = () => {
    if (++reads === 2) f.root = { id: 2, uuid: uuid(2), content: "User note", properties: {},
      preBlock: false, page: { id: 1 }, parent: { id: 1 }, left: { id: 1 }, children: [] };
  };
  await assert.rejects(f.run({ properties: {} }), /edited/);
  assert.equal(f.root.content, "User note");
  assert.equal(f.writes().length, 1);
});
for (const method of ["createPage", "getPageBlocksTree", "getBlock", "checkEditing"]) {
  test(`property-free graph guard stops immediately after ${method}`, async () => {
    const f = fixture({ title: true });
    f.after[method] = (result) => { f.stale = true; return result; };
    await assert.rejects(f.run({ properties: {} }), /graph changed/);
    assert.equal(f.calls.at(-1).method, method);
  });
}
test("property-free creation refuses existing pages without writes", async () => {
  const f = fixture();
  await f.run({ properties: {} });
  await assert.rejects(f.run({ properties: {} }), /already exists/);
  assert.equal(f.writes().length, 1);
});

test("bootstrap without an SDK-appended id is supported", async () => {
  const f = fixture({ id: false });
  assert.deepEqual((await f.run()).properties, metadata);
});
test("native title with matching id is preserved verbatim", async () => {
  const f = fixture({ title: true });
  f.after.createPage = (ack) => {
    f.root.properties.id = uuid(2);
    f.root.content += `\nid:: ${uuid(2)}`;
    return ack;
  };
  await f.run();
  assert.ok(f.root.content.startsWith(`title:: ${name}\nid:: ${uuid(2)}\n`));
});

for (const bad of [null, undefined, false, [], {}, { id: 1, uuid: uuid(9), name }, { id: "1", uuid: uuid(1), name }]) {
  test(`malformed/ambiguous create acknowledgement: ${JSON.stringify(bad)}`, async () => {
    const f = fixture();
    f.after.createPage = () => bad;
    await assert.rejects(f.run(), /paused/);
    assert.equal(f.writes().length, 1);
  });
}
for (const bad of [null, undefined, [], { id: 2, uuid: uuid(9) }, { id: 9, uuid: uuid(2) }]) {
  test(`malformed/ambiguous insert acknowledgement: ${JSON.stringify(bad)}`, async () => {
    const f = fixture();
    f.after.insertBlock = () => bad;
    await assert.rejects(f.run(), /paused/);
    assert.ok(!f.calls.some(({ method }) => method === "updateBlock"));
  });
}
test("interrupted bootstrap is left intact and later invocation refuses adoption", async () => {
  const f = fixture();
  f.after.insertBlock = () => { throw new Error("interrupted"); };
  await assert.rejects(f.run(), /interrupted/);
  const saved = copy(f.root);
  const writes = f.writes().length;
  await assert.rejects(f.run(), /already exists/);
  assert.deepEqual(f.root, saved);
  assert.equal(f.writes().length, writes);
  assert.equal(f.guards, f.calls.length * 2);
});
for (const method of ["getPage", "createPage", "newBlockUUID", "getBlock", "insertBlock", "getPageBlocksTree", "checkEditing", "updateBlock"]) {
  test(`graph guard stops immediately after ${method}`, async () => {
    const f = fixture();
    f.after[method] = (result) => { f.stale = true; return result; };
    await assert.rejects(f.run(), /graph changed/);
    assert.equal(f.calls.at(-1).method, method);
  });
}
test("graph guard prevents the first operation", async () => {
  const f = fixture(); f.stale = true;
  await assert.rejects(f.run(), /graph changed/);
  assert.equal(f.calls.length, 0);
});
for (const mutation of [
  (f) => { f.root.content = "User note"; },
  (f) => { f.root.properties.note = "mine"; },
  (f) => { f.root.parent.id = 99; },
  (f) => { f.root.left.id = 99; },
  (f) => { f.root.page.id = 99; },
  (f) => { f.root.children = [["uuid", uuid(8)]]; },
  (f) => { f.root.id = f.page.id; },
]) {
  test(`edited/moved bootstrap preserved: ${mutation}`, async () => {
    const f = fixture();
    f.after.insertBlock = (ack) => { mutation(f); return ack; };
    await assert.rejects(f.run(), /paused/);
    assert.ok(!f.calls.some(({ method }) => method === "updateBlock"));
  });
}
test("untouched snapshot is rechecked before overwrite", async () => {
  const f = fixture(); let reads = 0;
  f.before.getPageBlocksTree = () => { if (++reads === 3) f.root.content += "\nUser note"; };
  await assert.rejects(f.run(), /edited/);
  assert.ok(!f.calls.some(({ method }) => method === "updateBlock"));
});
for (const editing of [uuid(2), uuid(1), undefined, {}, true]) {
  test(`target/ambiguous editing status rejects: ${JSON.stringify(editing)}`, async () => {
    const f = fixture(); f.editing = editing;
    await assert.rejects(f.run(), /edited|Editing/);
    assert.ok(!f.calls.some(({ method }) => method === "updateBlock"));
  });
}
test("editing another block does not prevent initialization", async () => {
  const f = fixture(); f.editing = uuid(9); await f.run();
});
test("missing editing API fails before creation", async () => {
  const f = fixture(); delete f.editor.checkEditing;
  await assert.rejects(f.run(), /checkEditing/);
  assert.equal(f.calls.length, 0);
});
for (const mutation of [
  (f) => { f.page.properties = {}; },
  (f) => { f.root.properties["jr-kind"] = ["weekly"]; },
  (f) => { f.page.properties["jr-state"] = "wrong"; },
  (f) => { f.root.properties.jrKind = "monthly"; },
  (f) => { f.root.preBlock = false; },
  (f) => { f.root["pre-block?"] = false; },
  (f) => { f.root.content += "\nextra:: user"; },
  (f) => { f.page.properties.extra = "user"; },
  (f) => { f.root.left.id = 42; },
]) {
  test(`parser semantic/structural mismatch pauses without rollback: ${mutation}`, async () => {
    const f = fixture();
    f.after.updateBlock = () => { mutation(f); };
    await assert.rejects(f.run(), /paused/);
    assert.equal(f.writes().filter(({ method }) => method === "updateBlock").length, 1);
  });
}
for (const reserved of [uuid(1), uuid(2)]) {
  test(`reserved identity collision: ${reserved}`, async () => {
    const f = fixture();
    await assert.rejects(f.run({ reservedIds: [reserved] }), /collision/);
    assert.ok(!f.calls.some(({ method }) => method === "insertBlock"));
  });
}
test("occupied fresh UUID is rejected", async () => {
  const f = fixture(); f.after.getBlock = () => ({ uuid: uuid(2), content: "user" });
  await assert.rejects(f.run(), /occupied/);
  assert.equal(f.writes().length, 1);
});
test("page UUID cannot be used as bootstrap UUID", async () => {
  const f = fixture(); f.after.newBlockUUID = () => uuid(1);
  await assert.rejects(f.run(), /collision/);
});
for (const change of [
  (f) => { f.root.content += "\nUser title note"; },
  (f) => { f.root.properties.tags = "user"; },
  (f) => { f.root.properties.id = uuid(9); },
  (f) => { f.root.preBlock = false; },
]) {
  test(`native title user content is never overwritten: ${change}`, async () => {
    const f = fixture({ title: true });
    f.after.createPage = (ack) => { change(f); return ack; };
    await assert.rejects(f.run(), /paused/);
    assert.equal(f.writes().length, 1);
  });
}
test("extra roots are preserved", async () => {
  const f = fixture({ title: true });
  f.after.getPageBlocksTree = (tree) => [...tree, { uuid: uuid(9), content: "user" }];
  await assert.rejects(f.run(), /user content/);
  assert.equal(f.writes().length, 1);
});
test("native title id already mirrored on the page is retained", async () => {
  const f = fixture({ title: true });
  f.after.createPage = (ack) => {
    f.root.content += `\nid:: ${uuid(2)}`;
    f.root.properties.id = uuid(2);
    f.page.properties.id = uuid(2);
    ack.properties.id = uuid(2);
    return ack;
  };
  assert.equal((await f.run()).properties.id, uuid(2));
});
test("raw block/properties maps are supported", async () => {
  const f = fixture();
  const raw = (entity) => {
    if (entity) { entity["block/properties"] = entity.properties; delete entity.properties; }
    return entity;
  };
  for (const method of ["getPage", "createPage", "getBlock", "insertBlock"]) f.after[method] = raw;
  f.after.getPageBlocksTree = (tree) => tree.map(raw);
  assert.equal((await f.run())["block/properties"]["jr-kind"], "weekly");
});
test("conflicting raw and SDK properties pause", async () => {
  const f = fixture();
  f.after.updateBlock = () => { f.root["block/properties"] = { ...f.root.properties, "jr-kind": "monthly" }; };
  await assert.rejects(f.run(), /Conflicting properties maps/);
});
test("ambiguous absence is not permission to create", async () => {
  const f = fixture(); f.after.getPage = () => undefined;
  await assert.rejects(f.run(), /ambiguous/);
  assert.equal(f.writes().length, 0);
});
for (const properties of [{ "Jr-kind": "weekly" }, { "jr-kind": "weekly\nextra:: yes" }, { "jr-kind": [] },
  { "jr-kind": { nested: "x" } }, { "jr-kind": "weekly\rtitle:: no" }, { title: "x" }, { id: uuid(1) },
  { "jr-kind": "x\u2028y" }, { "jr-kind": " x " }, null, undefined]) {
  test(`invalid flat metadata rejects before SDK calls: ${JSON.stringify(properties)}`, async () => {
    const f = fixture(); await assert.rejects(f.run({ properties }), TypeError); assert.equal(f.calls.length, 0);
  });
}
