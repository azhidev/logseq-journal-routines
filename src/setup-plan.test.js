import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSetupJSON, createSetupPlan, SETUP_SECTIONS, snapshotSetupEvidence } from "./setup-plan.js";

const uuid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
const block = (n, content, children = []) => ({ uuid: uuid(n), content, properties: {}, children });
const success = (value) => ({ ok: true, value });
const slug = (value) => value.toLowerCase().replaceAll(" ", "-");
function fixture({ fresh = false, complete = false } = {}) {
  const root = block(1, "PRIVATE ROOT\ntemplate:: daily-default\ntemplate-including-parent:: false",
    (complete ? SETUP_SECTIONS : ["Tasks", "Notes"]).map((section, i) => block(i + 2, `## ${section}`, [block(i + 20, "PRIVATE NOTE")])));
  root.properties = { template: "daily-default", "template-including-parent": false, custom: "PRIVATE PROPERTY" };
  const evidence = {
    version: 1, graph: { name: "Same name", path: "/PRIVATE/graph" },
    pages: Object.fromEntries(["Templates", "Week Routine", "Month Routine"].map((name) => [name, {
      page: success(!fresh && (name === "Templates" || complete) ? { name: name.toLowerCase(), uuid: uuid(80 + name.length), properties: {} } : null),
      ...(!fresh && complete && name !== "Templates" ? { tree: success([block(50, "DONE PRIVATE ROUTINE", [block(51, "TODO PRIVATE CHILD")])]) } : {}),
    }])),
    template: fresh ? { lookup: success(null) } : { lookup: success({ uuid: root.uuid }), tree: success(root) },
  };
  const report = { version: 1, calendar: { state: "available" }, sections: [...SETUP_SECTIONS], checks: [
    ...Object.entries(evidence.pages).map(([name, entry]) => ({ id: slug(name), state: entry.page.value ? "existing" : "missing" })),
    { id: "daily-default", state: fresh ? "missing" : "existing" },
    ...SETUP_SECTIONS.map((section) => ({ id: `section-${slug(section)}`, state: !fresh && (complete || ["Tasks", "Notes"].includes(section)) ? "existing" : "missing" })),
  ] };
  return { report, evidence };
}
function contract(plan) {
  assert.deepEqual(Object.keys(plan), ["version", "id", "status", "changes", "preserve", "blockers", "requirements"]);
  assert.equal(plan.version, 1);
  assert.ok(["draft", "blocked"].includes(plan.status));
  if (plan.id !== null) assert.match(plan.id, /^[a-f0-9]{64}$/);
  for (const change of plan.changes) {
    assert.deepEqual(Object.keys(change), ["id", "kind", "title", "target", "content", "placement", "reason"]);
    assert.ok(Object.values(change).every((value) => typeof value === "string"));
  }
  for (const key of ["preserve", "blockers", "requirements"]) assert.ok(plan[key].every((value) => typeof value === "string"));
  assert.ok(!JSON.stringify(plan).includes("PRIVATE"));
  assert.match(plan.requirements.join(" "), /never execution-ready/);
  assert.match(plan.requirements.join(" "), /uniqueness.*global duplicate enumeration/);
  assert.match(plan.requirements.join(" "), /configuration.*owners.*legacy/);
  assert.match(plan.requirements.join(" "), /backup.*approval/);
  assert.match(plan.requirements.join(" "), /existing Templates contents.*not read/);
}

test("Tasks/Notes user case: two empty routine pages and four exact append-only headings", async () => {
  const input = fixture();
  const before = structuredClone(input);
  const plan = await createSetupPlan(input);
  contract(plan);
  assert.equal(plan.status, "draft");
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.changes.length, 6);
  assert.deepEqual(plan.changes.slice(0, 2).map(({ target, content, kind }) => ({ target, content, kind })), [
    { target: "page:Week Routine", content: "", kind: "create-page" },
    { target: "page:Month Routine", content: "", kind: "create-page" },
  ]);
  assert.deepEqual(plan.changes.slice(2).map((change) => change.content), ["## Focus", "## Weekly tasks", "## Monthly tasks", "## End-of-day review"]);
  for (const change of plan.changes.slice(2)) {
    assert.equal(change.target, `block:${uuid(1)}`);
    assert.match(change.placement, /last direct child.*plan order.*do not rewrite/);
  }
  assert.deepEqual(input, before);
});

test("fresh graph: create Templates only for missing template, with six empty headings and no sample content", async () => {
  const plan = await createSetupPlan(fixture({ fresh: true }));
  contract(plan);
  assert.equal(plan.status, "draft");
  assert.deepEqual(plan.changes.map((change) => change.id), ["create-week-routine", "create-month-routine", "create-templates", "create-daily-default"]);
  assert.equal(plan.changes[3].content, "- یادداشت روزانه\n  template:: daily-default\n  template-including-parent:: false\n  - ## Focus\n  - ## Weekly tasks\n  - ## Monthly tasks\n  - ## Tasks\n  - ## Notes\n  - ## End-of-day review");
  assert.match(plan.changes[3].placement, /top-level.*direct children/);
});

test("missing template appends under existing Templates without replacing that page", async () => {
  const input = fixture({ fresh: true });
  input.evidence.pages.Templates.page = success({ name: "templates" });
  input.report.checks[0].state = "existing";
  const plan = await createSetupPlan(input);
  assert.equal(plan.status, "draft");
  assert.ok(!plan.changes.some((change) => change.id === "create-templates"));
  assert.equal(plan.changes.at(-1).target, "page:Templates");
});

test("customized complete graph has no edits, and a template elsewhere does not require Templates", async () => {
  const input = fixture({ complete: true });
  input.evidence.pages.Templates.page = success(null);
  input.report.checks[0].state = "missing";
  input.evidence.template.tree.value.children.reverse();
  input.evidence.template.tree.value.children[1].content = "### Notes\ncustom:: PRIVATE";
  const plan = await createSetupPlan(input);
  contract(plan);
  assert.equal(plan.status, "draft");
  assert.deepEqual(plan.changes, []);
});

for (const [label, mutate] of [
  ["duplicate heading", (root) => root.children.push(block(90, "## Tasks"))],
  ["nested matching heading", (root) => root.children[0].children.push(block(90, "## Focus"))],
  ["root matches a section", (root) => { root.content = "## Focus\ntemplate:: daily-default\ntemplate-including-parent:: false"; }],
  ["duplicate template in tree", (root) => root.children.push(block(90, "Other\ntemplate:: daily-default"))],
  ["conflicting template identity", (root) => { root.properties.template = "other"; }],
  ["duplicate template property", (root) => { root.content += "\ntemplate:: daily-default"; }],
  ["conflicting root inclusion", (root) => { root.properties["template-including-parent"] = true; }],
  ["implicit root inclusion", (root) => { delete root.properties["template-including-parent"]; root.content = "template:: daily-default"; }],
]) {
  test(`ambiguous template blocks all proposals: ${label}`, async () => {
    const input = fixture();
    mutate(input.evidence.template.tree.value);
    const plan = await createSetupPlan(input);
    contract(plan);
    assert.equal(plan.status, "blocked");
    assert.ok(plan.id);
    assert.deepEqual(plan.changes, []);
    assert.ok(plan.blockers.length);
  });
}

for (const [label, mutate] of [
  ["unsupported evidence", (input) => { input.evidence.version = 2; }],
  ["unsupported report", (input) => { input.report.version = 2; }],
  ["missing report check", (input) => { input.report.checks.pop(); }],
  ["inconsistent page report", (input) => { input.report.checks[0].state = "missing"; }],
  ["unreadable page", (input) => { input.evidence.pages["Week Routine"].page = { ok: false }; }],
  ["missing routine tree", (input) => { input.evidence.pages["Week Routine"].page = success({ name: "week routine" }); }],
  ["ambiguous lookup", (input) => { input.evidence.template.lookup.value = [{ uuid: uuid(1) }, { uuid: uuid(2) }]; }],
  ["mismatched target", (input) => { input.evidence.template.lookup.value.uuid = uuid(3); }],
  ["absent block UUID", (input) => { delete input.evidence.template.tree.value.children[0].uuid; }],
  ["duplicate UUID", (input) => { input.evidence.template.tree.value.children[0].uuid = uuid(1); }],
  ["malformed properties", (input) => { input.evidence.template.tree.value.children[0].properties = []; }],
  ["unexpanded tuple", (input) => { input.evidence.template.tree.value.children = [["uuid", uuid(2)]]; }],
  ["cycle", (input) => { input.evidence.template.tree.value.children.push(input.evidence.template.tree.value); }],
  ["non-JSON property", (input) => { input.evidence.template.tree.value.properties.bad = undefined; }],
]) {
  test(`incomplete evidence has no fingerprint or proposals: ${label}`, async () => {
    const input = fixture();
    mutate(input);
    const plan = await createSetupPlan(input);
    contract(plan);
    assert.equal(plan.status, "blocked");
    assert.equal(plan.id, null);
    assert.deepEqual(plan.changes, []);
  });
}

test("native SHA-256 fingerprint is deterministic, canonical, source-sensitive, and not date-dependent", async () => {
  const input = fixture({ complete: true });
  const initial = await createSetupPlan(input);
  assert.equal(initial.id, (await createSetupPlan(structuredClone(input))).id);
  const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  assert.equal(initial.id, (await createSetupPlan(reorder(input))).id);
  for (const mutate of [
    (copy) => { copy.evidence.graph.path += "-other"; },
    (copy) => { copy.evidence.template.lookup.value.extra = "lookup change"; },
    (copy) => { copy.evidence.template.tree.value.content += "\nPRIVATE changed"; },
    (copy) => { copy.evidence.template.tree.value.properties.custom += "changed"; },
    (copy) => { copy.evidence.template.tree.value.children[0].uuid = uuid(99); },
    (copy) => { copy.evidence.template.tree.value.children.reverse(); },
    (copy) => { copy.evidence.pages["Week Routine"].tree.value[0].content = "TODO PRIVATE ROUTINE"; },
    (copy) => { copy.evidence.pages["Month Routine"].tree.value[0].children.push(block(90, "PRIVATE")); },
    (copy) => { copy.evidence.pages.Templates.page.value.properties.changed = true; },
  ]) {
    const copy = structuredClone(input);
    mutate(copy);
    const changed = await createSetupPlan(copy);
    assert.ok(changed.id);
    assert.notEqual(changed.id, initial.id);
    contract(changed);
  }
  input.report.calendar.today = { arbitraryDate: "tomorrow" };
  assert.equal((await createSetupPlan(input)).id, initial.id);
  const { id, ...publicPlan } = initial;
  const data = canonicalSetupJSON({ evidence: input.evidence, plan: { ...publicPlan, id: null } });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  assert.equal(id, Buffer.from(digest).toString("hex"));
  assert.notEqual(canonicalSetupJSON({ version: 1 }), canonicalSetupJSON({ version: 2 }));
});

test("unavailable dependency blocks proposals without dropping source fingerprint", async () => {
  const input = fixture();
  input.report.calendar.state = "unavailable";
  const plan = await createSetupPlan(input);
  contract(plan);
  assert.equal(plan.status, "blocked");
  assert.ok(plan.id);
  assert.deepEqual(plan.changes, []);
});

test("canonical snapshot rejects unsafe values, accessors, sparse arrays, excessive depth, and cycles without invoking code", () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { invoked = true; return "PRIVATE"; } });
  const cyclic = {}; cyclic.self = cyclic;
  let deep = {}; for (let i = 0; i < 110; i++) deep = { child: deep };
  for (const value of [undefined, NaN, Infinity, -0, 1n, new Date(), new Map(), () => {}, Symbol(), accessor, cyclic, deep, Array(2), { [Symbol()]: 1 }, { toJSON() { invoked = true; } }]) {
    assert.throws(() => snapshotSetupEvidence(value), /Unsupported setup evidence/);
  }
  assert.equal(invoked, false);
  assert.equal(canonicalSetupJSON({ b: 2, a: [2, 1] }), '{"a":[2,1],"b":2}');
  assert.notEqual(canonicalSetupJSON({ a: [2, 1] }), canonicalSetupJSON({ a: [1, 2] }));
  const source = { nested: { note: "before" } };
  const snapshot = snapshotSetupEvidence(source);
  source.nested.note = "after";
  assert.equal(snapshot.nested.note, "before");
});

test("native crypto failure or absence blocks without exposing host error contents", async (t) => {
  for (const crypto of [undefined, { subtle: { digest() { throw new Error("PRIVATE"); } } }, { subtle: { digest: async () => new ArrayBuffer(0) } }]) {
    t.mock.getter(globalThis, "crypto", () => crypto);
    const plan = await createSetupPlan(fixture());
    assert.equal(plan.status, "blocked");
    assert.equal(plan.id, null);
    assert.deepEqual(plan.changes, []);
    contract(plan);
    t.mock.restoreAll();
  }
});
