import test from "node:test";
import assert from "node:assert/strict";
import { DAILY_TEMPLATE, DAILY_TEMPLATE_PAGE, dailyTaskQuery, dailyTemplateNodes,
  installDailyJournalTemplate, syncDailyTemplateContext } from "./daily-template.js";

const clone = (value) => structuredClone(value);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const settings = { calendar: "gregorian", definitions: { weekly: "Weekly routines", monthly: "Monthly routines" } };
function fixture() {
  let page = null, next = 100, config = { pages: "Other default" }, editing = false;
  const records = new Map(), calls = [];
  let hook = async () => {};
  function find(id, entries = page?.blocks ?? []) {
    for (const block of entries) {
      if (block.uuid === id) return block;
      const child = find(id, block.children);
      if (child) return child;
    }
  }
  function entity() { if (!page) return null; const { blocks, ...rest } = page; return clone(rest); }
  function parsed(content) {
    let fence = null;
    return Object.fromEntries(content.split("\n").flatMap((line) => {
      if (fence) {
        if (new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
        return [];
      }
      const opening = /^\s*(`{3,}|~{3,})/.exec(line);
      if (opening) { fence = opening[1]; return []; }
      const match = /^([a-z][a-z-]*):: (.*)\r?$/.exec(line);
      return match ? [[match[1], match[2].trim()]] : [];
    }));
  }
  const editor = {
    async getPage(name) {
      await hook("getPage");
      if (name === DAILY_TEMPLATE_PAGE) return entity();
      const names = ["Weekly routines", "Monthly routines", "My Weekly", "My Monthly", "true", "false", "123"];
      assert.ok(names.includes(name));
      return { id: names.indexOf(name) + 1, uuid: uuid(names.indexOf(name) + 1), name, properties: {}, format: "markdown" };
    },
    async createPage(name, props, options) {
      assert.equal(props, null, "never reintroduce createPage's metadata Bean");
      assert.equal(page, null); assert.equal(name, DAILY_TEMPLATE_PAGE);
      assert.deepEqual(options, { redirect: false, createFirstBlock: false, format: "markdown" });
      calls.push(["createPage"]);
      page = { name, uuid: uuid(++next), id: next, properties: {}, format: "markdown", blocks: [] };
      return entity();
    },
    async getPageBlocksTree(id) { assert.equal(id, page.uuid); await hook("tree"); return clone(page.blocks); },
    async newBlockUUID() { return uuid(++next); },
    async getBlock(id) { await hook("getBlock"); return clone(find(id) ?? null); },
    async checkEditing() { return editing; },
    async insertBlock(anchor, content, opts) {
      calls.push(["insert", content]); await hook("insert");
      const previous = find(anchor);
      let list, parent;
      if (opts.isPageBlock) { assert.equal(anchor, DAILY_TEMPLATE_PAGE); list = page.blocks; parent = page; }
      else if (opts.sibling) {
        assert.ok(previous);
        parent = previous.parent.id === page.id ? page : findById(previous.parent.id);
        list = parent === page ? page.blocks : parent.children;
      } else { assert.ok(previous); parent = previous; list = parent.children; }
      const index = opts.sibling ? list.indexOf(previous) + 1 : list.length;
      const block = { uuid: opts.customUUID, id: ++next, content: `${content}\nid:: ${opts.customUUID}`,
        properties: { ...parsed(content), id: opts.customUUID }, children: [], page: { id: page.id },
        parent: { id: parent.id }, left: { id: index ? list[index - 1].id : parent.id } };
      list.splice(index, 0, block);
      if (list[index + 1]) list[index + 1].left = { id: block.id };
      return clone(block);
    },
    async updateBlock(id, content) {
      calls.push(["update", content]); const block = find(id);
      block.content = content; block.properties = parsed(content);
      if (block === page.blocks[0]) { block.preBlock = true; page.properties = clone(block.properties); }
      else assert.equal(block.page.id, page.id, "context/presentation updates only owned template blocks");
    },
    async upsertBlockProperty(id, key, value) {
      calls.push(["property", key, value]); await hook("property"); const block = find(id);
      block.properties[key] = value;
      const pattern = new RegExp(`^${key}::.*$`, "m");
      block.content = pattern.test(block.content) ? block.content.replace(pattern, `${key}:: ${value}`) : `${block.content}\n${key}:: ${value}`;
      // Keep page mirrors stale, as in real header checkpoints.
    },
  };
  function findById(id, entries = page?.blocks ?? []) {
    for (const block of entries) { if (block.id === id) return block; const result = findById(id, block.children); if (result) return result; }
  }
  const sdk = { Editor: editor, App: {
    async getTemplate(name) {
      assert.equal(name, DAILY_TEMPLATE);
      const root = page?.blocks.find((block) => block.properties.template === name);
      return clone(root ?? null);
    },
    async getCurrentGraphConfigs(key) { assert.equal(key, "default-templates"); await hook("configRead"); return clone(config); },
    async setCurrentGraphConfigs(value) { calls.push(["config", clone(value)]); await hook("configWrite"); config = clone(value["default-templates"]); },
  } };
  const storage = { async get(key) { return clone(records.get(key) ?? null); },
    async set(key, value) { calls.push(["marker", clone(value)]); records.set(key, clone(value)); } };
  let allowed = true;
  const args = { sdk, storage, graphKey: "a", settings, guard: async () => { if (!allowed) throw new Error("Graph changed"); } };
  return { calls, records, sdk, args, page: () => page, config: () => config,
    install: (options = {}) => installDailyJournalTemplate({ ...args, ...options }),
    sync: (nextSettings) => syncDailyTemplateContext({ ...args, settings: nextSettings }),
    setConfig(value) { config = clone(value); }, deletePage() { page = null; },
    setHook(fn) { hook = fn; }, stop() { allowed = false; }, editRoot() { editing = page.blocks[1].uuid; },
  };
}

test("daily native queries keep original task results, WAITING semantics and definition exclusion", () => {
  for (const kind of ["priority", "pending", "weekly"]) {
    const query = dailyTaskQuery(kind);
    assert.match(query, /:find \(pull \?b \[\*\]\)/);
    assert.match(query, /:jr-weekly-definition/); assert.match(query, /:jr-monthly-definition/);
    assert.match(query, /:breadcrumb-show\? false/);
    assert.match(query, /:group-by-page\? false/);
    assert.match(query, /:table-view\? false/);
    assert.ok(query.includes(`:data-jr-query "${kind}"`));
    assert.equal(query.includes(":view"), false);
  }
  assert.match(dailyTaskQuery("pending"), /\[\?b :block\/marker "WAITING"\]/);
  assert.match(dailyTaskQuery("priority"), /:block\/priority "A"/);
  assert.equal(dailyTaskQuery("priority").includes('"WAITING"'), false);
  const weekly = dailyTaskQuery("weekly");
  for (const attribute of ["jr-daily-calendar", "jr-period-id", "jr-start", "jr-end", "block/scheduled", "block/deadline"]) assert.ok(weekly.includes(`:${attribute}`));
  assert.match(weekly, /:inputs \[:today\]/);
  assert.match(weekly, /:in \$ \?today %/);
  assert.match(weekly, /or-join \[\?b \?week \?start \?end\]/);
  assert.match(weekly, /\(subs \?s 4 6\)/, "civil string conversion rather than invalid YYYYMMDD subtraction");
  assert.equal(weekly.includes(":start-of-week"), false);
  assert.throws(() => dailyTaskQuery("overdue"), /Unknown/);
  assert.deepEqual(dailyTemplateNodes().filter((node) => node.parent === null).map((node) => node.content),
    ["## 🎯 Focus", "## ☑️ Tasks", "## 🚩 Priority A", "## ⏳ Pending", "## 📅 This week"]);
});

test("explicit install creates a native template once, preserves config siblings and never touches journals", async () => {
  const f = fixture(); const result = await f.install();
  assert.equal(result.templateName, DAILY_TEMPLATE);
  assert.deepEqual(f.config(), { pages: "Other default", journals: DAILY_TEMPLATE });
  const [header, root] = f.page().blocks;
  assert.equal(header.properties["jr-daily-template-state"], "ready");
  assert.equal(f.page().properties["jr-daily-template-state"], "initializing", "read header, not stale page state");
  assert.equal(root.properties.template, DAILY_TEMPLATE);
  assert.equal(root.properties["template-including-parent"], "false");
  assert.equal(root.children.length, 5);
  for (const section of root.children.slice(0, 2)) {
    assert.equal(section.children.length, 2, "Focus and Tasks each have two default blocks");
    assert.ok(section.children.every((block) => block.content === `\nid:: ${block.uuid}`));
    assert.notEqual(section.children[0].uuid, section.children[1].uuid);
    assert.equal(section.children[1].left.id, section.children[0].id);
  }
  assert.equal(f.calls[0][0], "marker", "durable attempt before graph writes");
  const before = clone(f.page()), writes = f.calls.length;
  await f.install();
  assert.deepEqual(f.page(), before);
  assert.equal(f.calls.length, writes, "repeat install writes nothing");
});

test("reinstall on an existing graph preserves one-block templates, edits and graph-local markers", async () => {
  const f = fixture(); await f.install();
  const root = f.page().blocks[1];
  // Existing installed template from before the two-block default.
  for (const section of root.children.slice(0, 2)) section.children.splice(1);
  const before = clone(f.page()), records = clone(f.records), writes = f.calls.length;
  await f.install();
  assert.deepEqual(f.page(), before, "no automatic template refill or journal migration");
  assert.deepEqual(f.records, records, "existing creation evidence stays compatible");
  assert.equal(f.calls.length, writes);
  root.children[0].children[0].content = "My daily plan";
  root.children[1].children = [];
  const edited = clone(f.page());
  await f.install();
  assert.deepEqual(f.page(), edited, "edited and deliberately deleted blanks are preserved");
  assert.equal(f.calls.length, writes);
});

test("existing native default requires explicit replacement; original content and other defaults remain", async () => {
  const f = fixture(); f.setConfig({ journals: "My journal", pages: "My pages" });
  await assert.rejects(f.install(), /Explicitly approve/);
  assert.equal(f.page(), null); assert.equal(f.calls.length, 0);
  await f.install({ replaceExisting: true });
  assert.deepEqual(f.config(), { journals: DAILY_TEMPLATE, pages: "My pages" });
});

test("malformed config and ambiguous page reads fail before graph writes", async () => {
  for (const value of [[], "bad", { journals: 42 }]) {
    const f = fixture(); f.setConfig(value); await assert.rejects(f.install(), /ambiguous/); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.sdk.Editor.getPage = async () => undefined;
  await assert.rejects(f.install(), /occupied/); assert.equal(f.calls.length, 0);
});

test("deleted or edited installed templates are never rebuilt or refilled", async () => {
  const f = fixture(); await f.install(); const writes = f.calls.length;
  f.page().blocks[1].children = [];
  await f.install(); assert.equal(f.page().blocks[1].children.length, 0); assert.equal(f.calls.length, writes);
  f.deletePage(); await assert.rejects(f.install(), /missing/); assert.equal(f.calls.length, writes);
});

test("one-shot interrupted template creation pauses subsequent attempts", async () => {
  const f = fixture(); let count = 0;
  f.setHook(async (kind) => { if (kind === "insert" && ++count === 3) throw new Error("lost acknowledgment"); });
  await assert.rejects(f.install(), /lost acknowledgment/);
  f.setHook(async () => {}); const before = clone(f.page()), writes = f.calls.length;
  await assert.rejects(f.install(), /previously attempted/);
  assert.deepEqual(f.page(), before); assert.equal(f.calls.length, writes);
});

test("context follows calendar and definition changes, without rewriting template sections or tasks", async () => {
  const f = fixture(); await f.install(); const sections = clone(f.page().blocks[1].children);
  f.page().blocks[1].children[0].content = "## My focus";
  sections[0].content = "## My focus";
  await f.sync({ calendar: "jalali", definitions: { weekly: "My Weekly", monthly: "My Monthly" } });
  const root = f.page().blocks[1];
  assert.equal(root.properties["jr-daily-calendar"], "jalali");
  assert.equal(root.properties["jr-weekly-definition"], `page-uuid:${uuid(3)}`);
  assert.deepEqual(root.children, sections);
  const writes = f.calls.length;
  await f.sync({ calendar: "jalali", definitions: { weekly: "My Weekly", monthly: "My Monthly" } });
  assert.equal(f.calls.length, writes);
});

test("context updates preserve fenced metadata examples and user descendants in one text save", async () => {
  for (const [opening, closing] of [["```markdown", "```"], ["~~~~text", "~~~~~"], ["  ```", "  ```"], ["````", "````"], ["~~~", ""]]) {
    const f = fixture(); await f.install();
    const root = f.page().blocks[1];
    const example = ["User example", opening, "jr-daily-calendar:: gregorian",
      `jr-weekly-definition:: page-uuid:${uuid(1)}`, `jr-monthly-definition:: page-uuid:${uuid(2)}`,
      opening.trim().startsWith("~") ? "```" : opening.trim().startsWith("````") ? "```" : "~~~",
      "jr-daily-calendar:: example after a non-closing fence", closing].join("\n");
    root.content += `\n${example}`;
    root.children[0].children[0].content = "My user note\njr-daily-calendar:: not metadata";
    const descendants = clone(root.children), before = root.content, writes = f.calls.length;
    const next = { calendar: "jalali", definitions: { weekly: "My Weekly", monthly: "My Monthly" } };
    await f.sync(next);
    const expected = before.replace("jr-daily-calendar:: gregorian", "jr-daily-calendar:: jalali")
      .replace(`jr-weekly-definition:: page-uuid:${uuid(1)}`, `jr-weekly-definition:: page-uuid:${uuid(3)}`)
      .replace(`jr-monthly-definition:: page-uuid:${uuid(2)}`, `jr-monthly-definition:: page-uuid:${uuid(4)}`);
    assert.equal(root.content, expected);
    assert.deepEqual(root.children, descendants);
    assert.deepEqual(f.calls.slice(writes).map(([kind]) => kind), ["update"]);
    const saved = f.calls.length;
    await f.sync(next); assert.equal(f.calls.length, saved, "unchanged context remains write-free");
  }
});

test("context refuses fenced-only, mismatched or duplicated property text without changing user content", async () => {
  for (const newline of ["\n", "\r\n"]) for (const mode of ["fenced-only", "mismatch", "duplicate"]) {
    const f = fixture(); await f.install(); const root = f.page().blocks[1];
    const line = "jr-daily-calendar:: gregorian";
    if (mode === "fenced-only") root.content = root.content.replace(line, "") + `\n\`\`\`markdown\n${line}\n\`\`\``;
    if (mode === "mismatch") root.content = root.content.replace(line, "jr-daily-calendar:: user example");
    if (mode === "duplicate") root.content += `\n${line}`;
    root.content = root.content.replaceAll("\n", newline);
    // Model stale/indexed SDK properties: text must independently authorize the save.
    const before = clone(f.page()), writes = f.calls.length;
    await assert.rejects(f.sync({ ...settings, calendar: "jalali" }), /context property text/);
    assert.deepEqual(f.page(), before); assert.equal(f.calls.length, writes);
  }
});

test("context updates preserve CRLF, quoted and indented property examples", async () => {
  const f = fixture(); await f.install(); const root = f.page().blocks[1];
  const notes = "> jr-daily-calendar:: quoted\n    jr-weekly-definition:: indented\n`jr-monthly-definition:: inline`";
  root.content = `${root.content}\n${notes}`.replaceAll("\n", "\r\n");
  const before = root.content;
  await f.sync({ ...settings, calendar: "jalali" });
  assert.equal(root.content, before.replace("jr-daily-calendar:: gregorian", "jr-daily-calendar:: jalali"));
});

test("context synchronization retains alias conflict and graph guards", async () => {
  const f = fixture(); await f.install();
  f.page().blocks[1].properties.jrDailyCalendar = "jalali";
  const before = clone(f.page()), writes = f.calls.length;
  await assert.rejects(f.sync({ ...settings, calendar: "jalali" }), /Conflicting/);
  assert.deepEqual(f.page(), before); assert.equal(f.calls.length, writes);
  delete f.page().blocks[1].properties.jrDailyCalendar;
  f.setHook(async (kind) => { if (kind === "getBlock") f.stop(); });
  await assert.rejects(f.sync({ ...settings, calendar: "jalali" }), /Graph changed/);
  assert.equal(f.calls.length, writes);
});

test("context synchronization refuses a concurrent root edit before its single save", async () => {
  const f = fixture(); await f.install(); const root = f.page().blocks[1];
  const writes = f.calls.length; let reads = 0;
  f.setHook(async (kind) => {
    if (kind === "getBlock" && ++reads === 3) root.content += "\nConcurrent user note";
  });
  await assert.rejects(f.sync({ ...settings, calendar: "jalali" }), /root changed/);
  assert.ok(root.content.endsWith("Concurrent user note"));
  assert.equal(root.properties["jr-daily-calendar"], "gregorian");
  assert.equal(f.calls.length, writes);
});

test("boolean and numeric definition names use parser-stable UUID keys", async () => {
  for (const name of ["true", "false", "123"]) {
    const f = fixture();
    await f.install({ settings: { ...settings, definitions: { weekly: name, monthly: "Monthly routines" } } });
    const key = f.page().blocks[1].properties["jr-weekly-definition"];
    assert.match(key, /^page-uuid:[a-f0-9-]+$/);
    assert.notEqual(key, name);
    assert.ok(f.page().blocks[1].content.includes(`jr-weekly-definition:: ${key}`));
  }
});

test("do not update an actively edited template root", async () => {
  const f = fixture(); await f.install(); f.editRoot(); const before = clone(f.page());
  await assert.rejects(f.sync({ ...settings, calendar: "jalali" }), /Finish editing/);
  assert.deepEqual(f.page(), before);
});

test("graph guard stops installation after pending operations", async () => {
  const f = fixture(); f.setHook(async (kind) => { if (kind === "insert") f.stop(); });
  await assert.rejects(f.install(), /Graph changed/);
  assert.equal(f.calls.filter(([kind]) => kind === "insert").length, 1);
  assert.equal(f.calls.some(([kind]) => kind === "config"), false);
});

test("config changes during installation are preserved, not clobbered", async () => {
  const f = fixture(); let updated = false;
  f.setHook(async (kind) => { if (kind === "insert" && !updated) { updated = true; f.setConfig({ pages: "New pages" }); } });
  await assert.rejects(f.install(), /changed during installation/);
  assert.deepEqual(f.config(), { pages: "New pages" });
  await f.install(); assert.deepEqual(f.config(), { pages: "New pages", journals: DAILY_TEMPLATE });
});

test("explicit reinstall refreshes only untouched generated presentation and is repeat-safe", async () => {
  const f = fixture(); await f.install();
  const root = f.page().blocks[1];
  const names = ["Focus", "Tasks", "Priority A", "Pending", "This week"];
  root.children.forEach((block, index) => { block.content = `## ${names[index]}\nid:: ${block.uuid}`; });
  for (const [index, kind] of ["priority", "pending", "weekly"].entries()) {
    const query = root.children[index + 2].children[0];
    query.content = `${dailyTaskQuery(kind, { compact: false })}\nid:: ${query.uuid}`;
  }
  root.children[0].content = "## My custom focus";
  const pending = root.children[3].children[0];
  pending.content += "\nMy custom query note";
  await f.install();
  assert.equal(root.children[0].content, "## My custom focus");
  assert.ok(root.children[2].children[0].content.includes(':data-jr-query "priority"'));
  assert.ok(root.children[4].children[0].content.includes(":group-by-page? false"));
  assert.ok(pending.content.endsWith("My custom query note"));
  const before = clone(f.page()), writes = f.calls.length;
  await f.install(); assert.deepEqual(f.page(), before); assert.equal(f.calls.length, writes);
});

test("failed or unverified config write keeps the completed template for explicit retry", async () => {
  const f = fixture(); const setter = f.sdk.App.setCurrentGraphConfigs;
  f.sdk.App.setCurrentGraphConfigs = async () => {};
  await assert.rejects(f.install(), /not yet verified/);
  const before = clone(f.page()); f.sdk.App.setCurrentGraphConfigs = setter;
  await f.install(); assert.deepEqual(f.page(), before);
});
