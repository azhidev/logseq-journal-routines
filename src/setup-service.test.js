import assert from "node:assert/strict";
import test from "node:test";
import { createSetupService } from "./setup-service.js";
import { SETUP_SECTIONS } from "./setup-plan.js";

const id = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
const copy = (value) => structuredClone(value);
const WEEK = ["TODO پروژه‌های فعال را مرور کن.", "TODO کارهای ناتمام و در انتظار را مرور کن.", "TODO تمرکز اصلی هفته‌ی بعد را انتخاب کن."];
const MONTH = ["TODO تمرکز اصلی این ماه شمسی را انتخاب کن.", "TODO کارهای ناتمام و در انتظار را مرور کن.", "TODO کارهای غیرفعال را ببند یا بایگانی کن.", "TODO پیشرفت پروژه‌های فعال را مرور کن."];
const REVIEW = ["امروز چه چیزی جلو رفت؟", "آیا بررسی عادت‌های امروز را کامل کردم؟", "فردا چه چیزی باید ادامه پیدا کند؟"];
const HEADER = "یادداشت روزانه\ntemplate:: daily-default\ntemplate-including-parent:: false";
function properties(content) {
  const result = Object.fromEntries(content.split("\n").flatMap((line) => {
    const match = /^([^\s:]+)::\s*(.*)$/.exec(line);
    return match ? [[match[1], match[2] === "false" ? false : match[2]]] : [];
  }));
  // Desktop's Markdown parser adds this metadata without a heading:: line.
  const heading = /^(#{1,6})\s/.exec(content);
  if (heading) result.heading = heading[1].length;
  return result;
}
function body(block) { return block.content.split("\n").filter((line) => !line.startsWith("id:: ")).join("\n"); }
function fixture() {
  let next = 10, custom = 1000;
  const pages = new Map(), calls = [], guards = [], data = new Map();
  const f = { pages, calls, guards, data, graph: { name: "PRIVATE NAME", path: "/PRIVATE/graph" }, configured: null,
    user: { preferredFormat: "markdown", enabledJournals: true }, beforeWrite: null, afterWrite: null, onGuard: null, onStore: null };
  function block(content, children = []) { return { uuid: id(next++), content, properties: properties(content), children, format: "markdown" }; }
  function page(name, blocks = []) {
    const value = { uuid: id(next++), name: name.toLowerCase(), properties: {}, "journal?": false, format: "markdown", blocks };
    pages.set(name.toLowerCase(), value); return value;
  }
  function locate(uuid) {
    function walk(list, parent) {
      for (const b of list) {
        if (b.uuid === uuid) return { block: b, list, parent };
        const found = walk(b.children ?? [], b);
        if (found) return found;
      }
      return null;
    }
    for (const p of pages.values()) { const found = walk(p.blocks, p); if (found) return found; }
    return null;
  }
  function templates() {
    const result = [];
    function walk(list) { for (const b of list) { if (Object.hasOwn(b.properties, "template")) result.push(b); walk(b.children ?? []); } }
    for (const p of pages.values()) walk(p.blocks);
    return result;
  }
  async function write(kind, args, perform) {
    const call = { kind, args: copy(args) }; calls.push(call);
    await f.beforeWrite?.(call, calls.length);
    const result = perform();
    await f.afterWrite?.(call, calls.length);
    return result;
  }
  const sdk = {
    App: {
      getCurrentGraph: async () => copy(f.graph),
      getUserConfigs: async () => copy(f.user),
      getCurrentGraphConfigs: async (...keys) => { assert.deepEqual(keys, ["default-templates", "journals"]); return f.configured; },
      getTemplate: async (name) => { assert.equal(name, "daily-default"); return copy(templates().find((b) => b.properties.template === name) ?? null); },
    },
    DB: { datascriptQuery: async (query, ...inputs) => {
      assert.equal(query, `[:find ?uuid ?template\n :where [?b :block/uuid ?uuid] [?b :block/properties ?props]\n [(get ?props :template) ?template]]`);
      assert.deepEqual(inputs, []);
      return templates().map((b) => [b.uuid, b.properties.template]);
    } },
    Editor: {
      getPage: async (name) => {
        const p = pages.get(name.toLowerCase());
        if (!p) return null;
        const { blocks, ...metadata } = p; return copy(metadata);
      },
      getPageBlocksTree: async (name) => copy(pages.get(name.toLowerCase())?.blocks ?? null),
      getBlock: async (uuid, opts) => {
        if (opts !== undefined) assert.deepEqual(opts, { includeChildren: true });
        return copy(locate(uuid)?.block ?? null);
      },
      createPage: async (...args) => write("createPage", args, () => {
        const [name, props, opts] = args;
        assert.deepEqual(opts, { redirect: false, createFirstBlock: false, format: "markdown", journal: false });
        assert.deepEqual(Object.keys(props), ["journal-routines-setup"]);
        // Real host returns existing pages WITHOUT applying the new properties.
        let p = pages.get(name.toLowerCase());
        if (!p) {
          p = page(name, [block(`journal-routines-setup:: ${props["journal-routines-setup"]}`)]);
          p.properties = copy(props);
        }
        const { blocks, ...metadata } = p; return copy(metadata);
      }),
      insertBlock: async (...args) => write("insertBlock", args, () => {
        const [anchor, content, opts] = args;
        assert.deepEqual(Object.keys(opts).sort(), ["before", "customUUID", "focus", "sibling"]);
        assert.equal(opts.before, false); assert.equal(opts.focus, false);
        assert.match(opts.customUUID, /^[a-f0-9-]{36}$/);
        if (locate(opts.customUUID)) throw new Error("PRIVATE duplicate UUID");
        const target = locate(anchor), p = pages.get(anchor.toLowerCase());
        assert.ok(target || p, "service must create missing pages explicitly");
        const b = { uuid: opts.customUUID, content: `${content}${content ? "\n" : ""}id:: ${opts.customUUID}`,
          properties: { ...properties(content), id: opts.customUUID }, children: [], format: "markdown" };
        if (opts.sibling) {
          assert.ok(target); target.list.splice(target.list.indexOf(target.block) + 1, 0, b);
        } else if (p) p.blocks.push(b);
        else target.block.children.push(b);
        return copy(b);
      }),
    },
  };
  const store = {
    async get(key) { return copy(data.get(key) ?? null); },
    async set(key, value) { await f.onStore?.(key, value); data.set(key, copy(value)); },
  };
  const guard = async (context) => { guards.push(copy(context)); return f.onGuard ? f.onGuard(context) : true; };
  Object.assign(f, { sdk, store, guard, block, page, locate, templates,
    service: (options = {}) => createSetupService({ sdk, store, guard, createUuid: () => id(custom++), ...options }),
    root: () => templates().find((b) => b.properties.template === "daily-default"),
    routine: (name) => pages.get(name.toLowerCase()).blocks.filter((b) => !b.content.startsWith("journal-routines-setup::")),
  });
  return f;
}
function publicContract(result) {
  const s = result.summary;
  assert.deepEqual(Object.keys(s), ["version", "status", "changes", "blockers", "configuration", "limitations", "activates"]);
  assert.equal(s.version, 1); assert.equal(s.activates, false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.ok(!JSON.stringify(result).includes("12345678-1234"));
  assert.ok(!JSON.stringify(result).includes("nextJournal"));
  for (const c of s.changes) assert.deepEqual(Object.keys(c), ["kind", "title", "content"]);
  assert.match(s.limitations.join(" "), /backup.*Calendar.*owner.*legacy/);
  assert.match(s.limitations.join(" "), /not an atomic snapshot/);
}
function blocked(result, code) {
  publicContract(result);
  assert.equal(result.summary.status, "blocked");
  assert.equal(result.summary.blockers[0].code, code);
}
function complete(f) {
  assert.deepEqual(f.routine("Week Routine").map(body), WEEK);
  assert.deepEqual(f.routine("Month Routine").map(body), MONTH);
  const root = f.root();
  assert.equal(body(root), HEADER);
  assert.equal(root.properties["template-including-parent"], false);
  assert.deepEqual(root.children.map(body), SETUP_SECTIONS.map((s) => `## ${s}`));
  for (const title of ["Focus", "Tasks", "Notes"]) assert.deepEqual(root.children.find((b) => body(b) === `## ${title}`).children.map(body), [""]);
  assert.deepEqual(root.children.at(-1).children.map(body), REVIEW);
  assert.deepEqual(root.children[1].children, []); assert.deepEqual(root.children[2].children, []);
  const inserted = f.calls.filter((c) => c.kind === "insertBlock").map((c) => c.args[2].customUUID);
  assert.equal(new Set(inserted).size, inserted.length);
}

test("exact API, read-only safe review, real seeded SDK writes, root excluded, no activation or config writes", async () => {
  const f = fixture(), service = f.service();
  assert.deepEqual(Object.keys(service), ["inspect", "apply"]);
  const preview = await service.inspect();
  publicContract(preview);
  assert.equal(preview.summary.status, "ready");
  assert.equal(preview.summary.configuration, "manual-selection-required");
  assert.deepEqual(Object.keys(preview.token), []); assert.ok(Object.isFrozen(preview.token));
  assert.equal(f.calls.length, 0); assert.equal(f.data.size, 0); assert.equal(f.guards.length, 0);
  for (const content of [...WEEK, ...MONTH, ...REVIEW, HEADER]) assert.ok(preview.summary.changes.some((c) => c.content === content));
  const result = await service.apply(preview.token);
  publicContract(result); assert.equal(result.status, "complete");
  complete(f);
  assert.equal(f.calls.length, 23);
  assert.equal(f.calls.filter((c) => c.kind === "createPage").length, 3);
  assert.equal(f.guards.filter((g) => g.phase === "write").length, 69);
  assert.equal(f.configured, null);
  for (const [key, saved] of f.data) {
    assert.match(key, /^journal-routines:setup:v1:[a-f0-9]{64}$/);
    assert.equal(saved.next, 23); assert.equal(saved.pending, null);
    assert.ok(!JSON.stringify(saved).includes("PRIVATE"));
    assert.ok(!JSON.stringify(saved).includes("TODO"));
    assert.ok(!JSON.stringify(saved).includes("content"));
  }
});

test("repeat clicks serialize; completed token and new service inspection never duplicate resources", async () => {
  const f = fixture(), service = f.service(), { token } = await service.inspect();
  const results = await Promise.all([service.apply(token), service.apply(token), service.apply(token)]);
  assert.ok(results.every((r) => r.status === "complete")); complete(f);
  assert.equal(f.calls.length, 23);
  const next = f.service(), preview = await next.inspect();
  assert.equal(preview.summary.status, "complete"); assert.deepEqual(preview.summary.changes, []);
  assert.equal((await next.apply(preview.token)).status, "complete");
  assert.equal(f.calls.length, 23);
});

test("preserve existing empty and completed routine pages; never refill after deletion or restart", async () => {
  const f = fixture();
  const week = f.page("Week Routine"), month = f.page("Month Routine", [f.block("DONE PRIVATE TASK", [f.block("PRIVATE CHILD")])]);
  const before = copy([week, month]);
  const s = f.service(); assert.equal((await s.apply((await s.inspect()).token)).status, "complete");
  assert.deepEqual([week, month], before);
  month.blocks = [];
  const restart = f.service(), preview = await restart.inspect();
  assert.equal(preview.summary.status, "complete");
  assert.equal((await restart.apply(preview.token)).status, "complete");
  assert.deepEqual(month.blocks, []); assert.deepEqual(week.blocks, []);
  assert.ok(!f.calls.some((c) => c.args[0] === "Week Routine" || c.args[0] === "Month Routine"));
});

test("append only missing direct-child sections in a user template elsewhere, preserve root/order/content/properties", async () => {
  const f = fixture();
  f.page("Week Routine"); f.page("Month Routine");
  const notes = f.block("### Notes\ncustom:: PRIVATE", [f.block("PRIVATE NOTES")]);
  const tasks = f.block("## Tasks", [f.block("DONE PRIVATE TASK")]);
  const root = f.block("PRIVATE ROOT\ntemplate:: daily-default\ntemplate-including-parent:: false\ncustom:: PRIVATE", [notes, tasks]);
  f.page("My PRIVATE templates", [root]); f.configured = "daily-default";
  const before = copy(root), s = f.service(), preview = await s.inspect(); publicContract(preview);
  assert.equal((await s.apply(preview.token)).status, "complete");
  assert.equal(root.uuid, before.uuid); assert.equal(root.content, before.content); assert.deepEqual(root.properties, before.properties);
  assert.deepEqual(root.children.slice(0, 2), before.children);
  assert.deepEqual(root.children.slice(2).map(body), ["## Focus", "## Weekly tasks", "## Monthly tasks", "## End-of-day review"]);
  assert.deepEqual(root.children.at(-1).children.map(body), REVIEW);
  assert.ok(!f.pages.has("templates")); assert.ok(f.calls.every((c) => c.kind === "insertBlock"));
  const first = f.calls[0]; assert.equal(first.args[0], tasks.uuid); assert.equal(first.args[2].sibling, true);
});

test("missing daily-default appends after existing Templates content without replacing unrelated templates", async () => {
  const f = fixture(), other = f.block("PRIVATE OTHER\ntemplate:: custom"), p = f.page("Templates", [other]);
  const before = copy(other), s = f.service();
  assert.equal((await s.apply((await s.inspect()).token)).status, "complete");
  assert.deepEqual(p.blocks[0], before); assert.equal(p.blocks.length, 2);
  assert.ok(!f.calls.some((c) => c.kind === "createPage" && c.args[0] === "Templates")); complete(f);
});

for (const [name, mutate, code] of [
  ["duplicate global definition", (f, r) => f.page("Elsewhere", [f.block(HEADER)]), "template-conflict"],
  ["case-folded competing definition", (f) => f.page("Elsewhere", [f.block("template:: DAILY-DEFAULT")]), "template-conflict"],
  ["lookup silently hides definition", (f) => { f.sdk.App.getTemplate = async () => null; }, "template-conflict"],
  ["query misses lookup", (f) => { f.sdk.DB.datascriptQuery = async () => []; }, "template-conflict"],
  ["duplicate section", (f, r) => r.children.push(f.block("## Tasks"), f.block("## Tasks")), "template-conflict"],
  ["nested section", (f, r) => r.children.push(f.block("Wrapper", [f.block("## Focus")])), "template-conflict"],
  ["root section", (f, r) => { r.content = `## Tasks\n${HEADER}`; }, "template-conflict"],
  ["root included", (f, r) => { r.properties["template-including-parent"] = true; }, "template-conflict"],
  ["implicit root inclusion", (f, r) => { r.content = "template:: daily-default"; r.properties = { template: "daily-default" }; }, "template-conflict"],
  ["duplicate property", (f, r) => { r.content += "\ntemplate:: daily-default"; }, "template-conflict"],
  ["unexpanded tree", (f, r) => { r.children = [["uuid", id(900)]]; }, "read-failed"],
  ["mismatched page identity", (f) => { f.sdk.Editor.getPage = async () => ({ name: "wrong", uuid: id(1) }); }, "read-failed"],
  ["Org format", (f) => { f.user.preferredFormat = "org"; }, "unsupported-graph"],
  ["journals disabled", (f) => { f.user.enabledJournals = false; }, "unsupported-graph"],
  ["custom configuration", (f) => { f.configured = "PRIVATE custom"; }, "custom-journal-template"],
  ["invalid configuration", (f) => { f.configured = {}; }, "read-failed"],
  ["query unavailable", (f) => { delete f.sdk.DB.datascriptQuery; }, "read-failed"],
  ["query failed", (f) => { f.sdk.DB.datascriptQuery = async () => { throw new Error("PRIVATE query"); }; }, "read-failed"],
  ["query null", (f) => { f.sdk.DB.datascriptQuery = async () => null; }, "read-failed"],
  ["ref-valued template", (f) => { f.sdk.DB.datascriptQuery = async () => [[id(9), ["daily-default"]]]; }, "template-conflict"],
]) {
  test(`blocks all writes: ${name}`, async () => {
    const f = fixture(), root = f.block(HEADER); f.page("Templates", [root]); mutate(f, root);
    const result = await f.service().inspect(); blocked(result, code); assert.equal(result.token, null); assert.equal(f.calls.length, 0);
  });
}

for (let at = 1; at <= 23; at++) {
  test(`SDK failure after committed write ${at}: resume across restart without repeating any write`, async () => {
    const f = fixture(), s = f.service(), { token } = await s.inspect();
    f.afterWrite = (_, count) => { if (count === at) throw new Error("PRIVATE remote failure after commit"); };
    const result = await s.apply(token); publicContract(result);
    assert.equal(result.status, "interrupted"); assert.equal(f.calls.length, at);
    const saved = [...f.data.values()][0]; assert.equal(saved.next, at); assert.equal(saved.pending, null);
    f.afterWrite = null;
    const restart = f.service(), preview = await restart.inspect(); publicContract(preview);
    assert.equal((await restart.apply(preview.token)).status, "complete");
    complete(f); assert.equal(f.calls.length, 23);
  });
}

for (const at of [1, 2, 10, 11, 12, 20, 23]) {
  test(`durable checkpoint failure after write ${at}: reconcile pending ownership/UUID on restart`, async () => {
    const f = fixture(), s = f.service(), { token } = await s.inspect();
    f.onStore = (_, value) => { if (value.next === at && value.pending === null) throw new Error("PRIVATE storage failure"); };
    blocked(await s.apply(token), "store-unavailable"); assert.equal(f.calls.length, at);
    assert.equal([...f.data.values()][0].pending, at - 1);
    blocked(await s.apply(token), "store-unavailable"); assert.equal(f.calls.length, at);
    f.onStore = null;
    const restart = f.service(), preview = await restart.inspect();
    assert.equal(preview.summary.status, "recovery"); assert.equal(f.calls.length, at);
    assert.equal((await restart.apply(preview.token)).status, "complete");
    complete(f); assert.equal(f.calls.length, 23);
  });
}

async function pendingHeading(preset = "section-0") {
  const f = fixture(), service = f.service(), { token } = await service.inspect();
  f.onStore = (_, saved) => {
    if (saved.pending === null && saved.ops[saved.next - 1]?.preset === preset) throw new Error("PRIVATE checkpoint acknowledgement failure");
  };
  blocked(await service.apply(token), "store-unavailable");
  f.onStore = null;
  const saved = [...f.data.values()][0], op = saved.ops[saved.pending];
  assert.equal(op.preset, preset);
  const heading = f.locate(op.uuid).block;
  assert.equal(heading.properties.heading, 2);
  return { f, heading };
}

for (let section = 0; section < SETUP_SECTIONS.length; section++) {
  test(`Desktop heading metadata: recover pending section-${section} without rewriting its block or checkpoint on inspection`, async () => {
    // The durable record is the same pre-write intent left by 0.4.3 when its
    // post-write comparison rejected the host's { heading: 2 } metadata.
    const { f, heading } = await pendingHeading(`section-${section}`);
    const before = copy(heading), checkpoint = copy([...f.data]), calls = f.calls.length;
    const restart = f.service(), preview = await restart.inspect();
    publicContract(preview);
    assert.equal(preview.summary.status, "recovery");
    assert.deepEqual([...f.data], checkpoint);
    assert.equal(f.calls.length, calls);
    assert.equal((await restart.apply(preview.token)).status, "complete");
    assert.equal(heading.uuid, before.uuid);
    assert.equal(heading.content, before.content);
    assert.deepEqual(heading.properties, before.properties);
    complete(f);
    assert.equal(f.calls.length, 23);
    assert.equal(f.calls.filter((call) => call.kind === "insertBlock" && call.args[2].customUUID === heading.uuid).length, 1);
  });
}

for (const [name, edit] of [
  ["wrong heading level", (_f, b) => { b.properties.heading = 3; }],
  ["string heading level", (_f, b) => { b.properties.heading = "2"; }],
  ["extra property", (_f, b) => { b.properties.custom = "PRIVATE"; }],
  ["changed content", (_f, b) => { b.content += "\nPRIVATE edit"; }],
  ["unexpected children", (f, b) => { b.children.push(f.block("PRIVATE child")); }],
  ["changed UUID", (_f, b) => { b.uuid = id(99999); }],
  ["unrelated sampled content changed", (f) => { f.routine("Week Routine")[0].content += " PRIVATE edit"; }],
]) {
  test(`heading recovery still rejects ${name} and preserves the checkpoint`, async () => {
    const { f, heading } = await pendingHeading();
    edit(f, heading);
    const before = copy([...f.pages]), checkpoint = copy([...f.data]), calls = f.calls.length;
    blocked(await f.service().inspect(), "recovery-conflict");
    assert.deepEqual([...f.pages], before);
    assert.deepEqual([...f.data], checkpoint);
    assert.equal(f.calls.length, calls);
  });
}

test("setup still accepts heading reads without derived metadata", async () => {
  const f = fixture();
  f.afterWrite = (call) => {
    if (call.kind === "insertBlock") delete f.locate(call.args[2].customUUID).block.properties.heading;
  };
  const service = f.service();
  assert.equal((await service.apply((await service.inspect()).token)).status, "complete");
  complete(f);
});

test("derived heading metadata is not accepted on a non-heading preset", async () => {
  const f = fixture();
  f.afterWrite = (call) => {
    if (call.kind === "insertBlock") f.locate(call.args[2].customUUID).block.properties.heading = 2;
  };
  const service = f.service();
  blocked(await service.apply((await service.inspect()).token), "recovery-conflict");
  assert.equal(f.calls.length, 2);
  const checkpoint = copy([...f.data]);
  blocked(await f.service().inspect(), "recovery-conflict");
  assert.deepEqual([...f.data], checkpoint);
  assert.equal(f.calls.length, 2);
});

test("rejected write with no observed commit remains pending, never blindly retried by old/new token", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.beforeWrite = () => { throw new Error("PRIVATE rejected"); };
  blocked(await s.apply(token), "write-uncertain"); assert.equal(f.calls.length, 1);
  f.beforeWrite = null;
  blocked(await s.apply(token), "write-uncertain");
  blocked(await f.service().inspect(), "write-uncertain");
  assert.equal(f.calls.length, 1); assert.equal(f.pages.size, 0);
});

test("remote call commits late after timeout: block while absent, reconcile later without reissuing", async () => {
  const f = fixture(), s = f.service({ timeoutMs: 30 }), { token } = await s.inspect();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.beforeWrite = (_, count) => count === 1 ? gate : null;
  blocked(await s.apply(token), "write-uncertain"); assert.equal(f.calls.length, 1);
  blocked(await s.inspect(), "write-uncertain");
  release(); await new Promise((resolve) => setTimeout(resolve, 10));
  const preview = await s.inspect(); assert.equal(preview.summary.status, "recovery");
  assert.equal((await s.apply(preview.token)).status, "complete"); complete(f); assert.equal(f.calls.length, 23);
});

test("null SDK responses are reconciled from real reads, not treated as success or absence", async () => {
  const f = fixture();
  for (const method of ["createPage", "insertBlock"]) {
    const original = f.sdk.Editor[method];
    f.sdk.Editor[method] = async (...args) => { await original(...args); return null; };
  }
  const s = f.service(); assert.equal((await s.apply((await s.inspect()).token)).status, "complete"); complete(f);
});

test("storage fails before intent: no SDK writes, record can resume with healthy durable store", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.onStore = (_, v) => { if (v.pending !== null) throw new Error("PRIVATE store"); };
  blocked(await s.apply(token), "store-unavailable"); assert.equal(f.calls.length, 0);
  f.onStore = null;
  const restart = f.service(); assert.equal((await restart.apply((await restart.inspect()).token)).status, "complete"); complete(f);
});

test("guard revoked between operations stops and later resumes only unfinished writes", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.onGuard = ({ operation }) => operation?.index !== 2;
  blocked(await s.apply(token), "guard-denied"); assert.equal(f.calls.length, 2);
  f.onGuard = null;
  assert.equal((await s.apply(token)).status, "complete"); complete(f); assert.equal(f.calls.length, 23);
});

test("guard revoked during durable intent storage is rechecked before the graph write", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  let enabled = true;
  f.onGuard = () => enabled;
  f.onStore = (_, v) => { if (v.pending === 0) enabled = false; };
  blocked(await s.apply(token), "guard-denied"); assert.equal(f.calls.length, 0);
  assert.equal([...f.data.values()][0].pending, null);
  f.onStore = null; enabled = true;
  assert.equal((await s.apply(token)).status, "complete"); complete(f);
});

for (const answer of [false, undefined, { ok: true }]) {
  test(`guard requires exactly true, not ${JSON.stringify(answer)}`, async () => {
    const f = fixture(), s = f.service(), { token } = await s.inspect(); f.onGuard = () => answer;
    blocked(await s.apply(token), "guard-denied"); assert.equal(f.calls.length, 0); assert.equal(f.data.size, 0);
  });
}

test("guard errors are sanitized and cannot authorize", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.onGuard = () => { throw new Error("PRIVATE backup failure"); };
  blocked(await s.apply(token), "guard-denied"); assert.equal(f.calls.length, 0);
});

for (const [name, mutate, code] of [
  ["missing page now exists", (f) => f.page("Week Routine"), "stale-plan"],
  ["template now exists", (f) => f.page("Elsewhere", [f.block(HEADER)]), "stale-plan"],
  ["configured selection changed", (f) => { f.configured = "daily-default"; }, "stale-plan"],
  ["configured custom selection", (f) => { f.configured = "PRIVATE"; }, "custom-journal-template"],
  ["same display name different path", (f) => { f.graph.path = "/PRIVATE/other"; }, "graph-changed"],
]) {
  test(`approval revalidation: ${name}`, async () => {
    const f = fixture(), s = f.service(), { token } = await s.inspect(); mutate(f);
    blocked(await s.apply(token), code); assert.equal(f.calls.length, 0);
  });
}

test("edits during the final write guard are freshly revalidated, not adopted into approval", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect(); let checks = 0;
  f.onGuard = ({ phase }) => { if (phase === "write" && ++checks === 2) f.page("Week Routine", [f.block("PRIVATE")]); return true; };
  blocked(await s.apply(token), "recovery-conflict"); assert.equal(f.calls.length, 0);
  assert.equal([...f.data.values()][0].pending, null);
});

test("page created concurrently inside createPage is not claimed or seeded", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.beforeWrite = () => f.page("Week Routine", [f.block("PRIVATE concurrent")]);
  blocked(await s.apply(token), "recovery-conflict"); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.routine("Week Routine").map(body), ["PRIVATE concurrent"]);
  blocked(await f.service().inspect(), "recovery-conflict"); assert.equal(f.calls.length, 1);
});

test("partial page/task edits and deletions are preserved and block recovery, not refilled", async () => {
  for (const edit of [false, true]) {
    const f = fixture(), s = f.service(), { token } = await s.inspect();
    f.afterWrite = (_, n) => { if (n === 2) throw new Error("interrupted"); };
    assert.equal((await s.apply(token)).status, "interrupted"); f.afterWrite = null;
    const page = f.pages.get("week routine");
    if (edit) page.blocks.at(-1).content = "DONE PRIVATE USER EDIT";
    else page.blocks.pop();
    const before = copy(page);
    blocked(await s.apply(token), "recovery-conflict"); blocked(await f.service().inspect(), "recovery-conflict");
    assert.deepEqual(page, before); assert.equal(f.calls.length, 2);
  }
});

test("user change after uncertain insertion is not erased or accepted as the plugin's content", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.afterWrite = (_, n) => { if (n === 2) { f.routine("Week Routine")[0].content = "PRIVATE edit"; throw new Error("PRIVATE"); } };
  blocked(await s.apply(token), "recovery-conflict"); assert.equal(f.calls.length, 2);
  blocked(await f.service().inspect(), "recovery-conflict");
  assert.equal(f.routine("Week Routine")[0].content, "PRIVATE edit");
});

test("graph switch after a write prevents subsequent writes; returning to original graph reconciles", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.afterWrite = () => { f.graph.path = "/PRIVATE/other"; };
  blocked(await s.apply(token), "graph-changed"); assert.equal(f.calls.length, 1);
  f.afterWrite = null; f.graph.path = "/PRIVATE/graph";
  assert.equal((await s.apply(token)).status, "complete"); complete(f);
});

test("new global template collision during partial setup blocks all further writes", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.afterWrite = (_, n) => { if (n === 11) f.page("Elsewhere", [f.block(HEADER)]); };
  blocked(await s.apply(token), "template-conflict"); assert.equal(f.calls.length, 11);
  blocked(await f.service().inspect(), "template-conflict"); assert.equal(f.calls.length, 11);
});

test("read failures and timeouts are bounded, sanitized, and do not establish absence", async () => {
  for (const never of [false, true]) {
    const f = fixture();
    f.sdk.Editor.getPage = () => never ? new Promise(() => {}) : Promise.reject(new Error("PRIVATE read"));
    blocked(await f.service({ timeoutMs: 10 }).inspect(), never ? "read-timeout" : "read-failed");
    assert.equal(f.calls.length, 0);
  }
});

test("tokens cannot be fabricated, serialized, copied, or used by another service", async () => {
  const f = fixture(), s = f.service(), preview = await s.inspect();
  preview.summary.changes[0].content = "PRIVATE injected";
  for (const token of [null, "fingerprint", {}, { ...preview.token }, JSON.parse(JSON.stringify(preview.token))]) {
    blocked(await s.apply(token), "invalid-token");
  }
  blocked(await f.service().apply(preview.token), "invalid-token"); assert.equal(f.calls.length, 0);
  assert.equal((await s.apply(preview.token)).status, "complete"); complete(f);
});

test("old completed token never refills deleted template sections; fresh review is required", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  assert.equal((await s.apply(token)).status, "complete");
  f.root().children.pop();
  blocked(await s.apply(token), "stale-plan"); assert.equal(f.calls.length, 23);
  const preview = await s.inspect(); assert.equal(preview.summary.status, "ready");
  assert.equal((await s.apply(preview.token)).status, "complete"); assert.equal(f.calls.length, 27);
});

test("missing guard/store/write APIs block rather than silently falling back to unsafe execution", async () => {
  for (const [options, code] of [[{ store: null }, "store-unavailable"], [{ guard: null }, "guard-denied"]]) {
    const f = fixture(); blocked(await f.service(options).inspect(), code); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); delete f.sdk.Editor.insertBlock;
  blocked(await f.service().inspect(), "write-api-unavailable");
});

test("malformed recovery records fail closed and cannot become an executable plan", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  f.onGuard = ({ phase }) => phase !== "write";
  blocked(await s.apply(token), "guard-denied");
  const [key, saved] = [...f.data.entries()][0]; saved.ops[1].preset = "PRIVATE malicious content"; f.data.set(key, saved);
  f.onGuard = null; blocked(await f.service().inspect(), "recovery-conflict"); assert.equal(f.calls.length, 0);
});

test("one template block cannot represent two section identities", async () => {
  const f = fixture();
  f.page("Templates", [f.block(HEADER, [f.block("## Tasks\nroutine-section:: [[Routine Weekly Section]]")])]);
  blocked(await f.service().inspect(), "template-conflict"); assert.equal(f.calls.length, 0);
});

test("indexed query bounds and source depth/content bounds fail closed", async () => {
  const f = fixture();
  f.sdk.DB.datascriptQuery = async () => Array.from({ length: 10001 }, (_, i) => [id(i), "other"]);
  blocked(await f.service().inspect(), "read-failed");
  for (const deep of [false, true]) {
    const g = fixture(); let root = g.block(deep ? "leaf" : "x".repeat(4_000_001));
    if (deep) for (let i = 0; i < 40; i++) root = g.block("nested", [root]);
    g.page("Week Routine", [root]);
    blocked(await g.service().inspect(), "read-failed"); assert.equal(g.calls.length, 0);
  }
});

test("guard revocation during final SDK reads is observed immediately before issuance", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  let checks = 0, allowed = true;
  f.onGuard = ({ phase }) => { if (phase === "write") checks++; return allowed; };
  const getPage = f.sdk.Editor.getPage;
  f.sdk.Editor.getPage = async (...args) => { if (checks === 2) allowed = false; return getPage(...args); };
  blocked(await s.apply(token), "guard-denied"); assert.equal(f.calls.length, 0);
  assert.equal([...f.data.values()][0].pending, null);
});

test("guard timeout does not authorize a late true response", async () => {
  const f = fixture(), s = f.service({ timeoutMs: 10 }), { token } = await s.inspect();
  f.onGuard = () => new Promise((resolve) => setTimeout(() => resolve(true), 25));
  blocked(await s.apply(token), "guard-denied");
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.calls.length, 0);
});

test("storage timeout quarantines the instance so a late checkpoint cannot race another apply", async () => {
  const f = fixture(), s = f.service({ timeoutMs: 10 }), { token } = await s.inspect();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  f.onStore = () => gate;
  blocked(await s.apply(token), "store-unavailable");
  blocked(await s.apply(token), "store-unavailable"); assert.equal(f.calls.length, 0);
  release(); await new Promise((resolve) => setTimeout(resolve, 5));
  blocked(await s.inspect(), "store-unavailable"); assert.equal(f.calls.length, 0);
});

test("case/camel SDK property keys normalize without rewriting template properties", async () => {
  const f = fixture(), root = f.block(HEADER);
  root.properties = { template: "daily-default", templateIncludingParent: false, customUser: "PRIVATE" };
  f.page("Elsewhere", [root]); const before = copy(root.properties), s = f.service();
  assert.equal((await s.apply((await s.inspect()).token)).status, "complete");
  assert.deepEqual(root.properties, before);
});

test("secure identities are checked against existing blocks outside the sampled pages before insertion", async () => {
  const f = fixture(), s = f.service(), { token } = await s.inspect();
  // First generated identity is page ownership; second is the first task UUID.
  const other = f.block("PRIVATE UUID collision"); other.uuid = id(1001); f.page("Unrelated", [other]);
  blocked(await s.apply(token), "recovery-conflict"); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.routine("Week Routine"), []); assert.equal(other.content, "PRIVATE UUID collision");
});

test("invalid UUID generators and timeout options fail safely", async () => {
  const f = fixture();
  blocked(await f.service({ createUuid: () => "PRIVATE" }).inspect(), "identity-unavailable");
  blocked(await f.service({ createUuid: () => id(1) }).inspect(), "identity-unavailable");
  for (const timeoutMs of [0, -1, 0.1, Infinity, 2147483648]) assert.throws(() => f.service({ timeoutMs }), /Invalid setup timeoutMs/);
  assert.equal(f.calls.length, 0);
});
