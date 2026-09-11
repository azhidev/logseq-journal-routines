import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCalendarClient } from "./calendar-client.js";
import { inspectSetup } from "./setup-preview.js";

const SECTIONS = ["Focus", "Weekly tasks", "Monthly tasks", "Tasks", "Notes", "End-of-day review"];
const NAMES = ["Templates", "Week Routine", "Month Routine"];
const UUID = "AFAFB0C1-2E3F-4A5B-8C7D-123456789ABC";
const GRAPH = { name: "Personal graph", path: "/private/host/graph", url: "logseq://private" };
const SECRET = "PRIVATE NOTE CONTENT";
const TODAY = {
  gregorian: { year: 2025, month: 3, day: 21, iso: "2025-03-21", journalDay: 20250321 },
  persian: { year: 1404, month: 1, day: 1, iso: "1404-01-01", label: "جمعه 1 فروردین 1404", weekOfYear: 1 },
  week: { start: "2025-03-15", end: "2025-03-21", key: "weekly-20250315" },
  month: { start: "2025-03-21", end: "2025-04-20", key: "monthly-1404-01", financeKey: "1404-01" },
};
const block = (content, children = []) => ({ content, children });
const templateTree = () => ({
  uuid: UUID,
  content: `${SECRET}\ntemplate:: daily-default\ntemplate-including-parent:: false`,
  properties: { id: UUID, "template-including-parent": false },
  children: SECTIONS.map((name) => block(`## ${name}`, [block(SECRET)])),
});

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function fixture(t, overrides = {}) {
  const calls = [];
  const forbidden = [];
  const tree = freeze(templateTree());
  const routine = freeze([block("# Week Routine", [block(`TODO ${SECRET}`), block("  ")])]);
  const handlers = {
    "App.getCurrentGraph": () => ({ ...GRAPH }),
    "App.getTemplate": () => ({ uuid: UUID }),
    "Editor.getPage": (name) => ({ name: name.toLowerCase(), uuid: `page-${name}`, properties: { private: SECRET } }),
    "Editor.getPageBlocksTree": (name) => name === "Week Routine" ? routine : [block(`TODO ${SECRET}`)],
    "Editor.getBlock": () => tree,
    ...overrides,
  };
  function guard(object, prefix = "") {
    return new Proxy(object, {
      get(target, key) {
        if (!Object.hasOwn(target, key)) {
          forbidden.push(`${prefix}${String(key)}`);
          throw new Error("Forbidden SDK access");
        }
        return target[key];
      },
      set() { forbidden.push("SDK mutation"); throw new Error("Forbidden SDK mutation"); },
    });
  }
  function method(name) {
    return (...args) => {
      calls.push([name, ...args]);
      return handlers[name](...args);
    };
  }
  const sdk = guard({
    App: guard({ getCurrentGraph: method("App.getCurrentGraph"), getTemplate: method("App.getTemplate") }, "App."),
    Editor: guard({ getPage: method("Editor.getPage"), getPageBlocksTree: method("Editor.getPageBlocksTree"), getBlock: method("Editor.getBlock") }, "Editor."),
  });
  const today = freeze(structuredClone(TODAY));
  const calendarCalls = [];
  const calendar = guard({ describeToday() { calendarCalls.push("describeToday"); return today; } }, "calendar.");
  t.after(() => {
    assert.deepEqual(forbidden, [], "even caught forbidden SDK accesses must fail the test");
    for (const [method, ...args] of calls) {
      if (method === "App.getCurrentGraph") assert.deepEqual(args, []);
      else if (method === "App.getTemplate") assert.deepEqual(args, ["daily-default"]);
      else if (method === "Editor.getPage") assert.ok(NAMES.includes(args[0]) && args.length === 1);
      else if (method === "Editor.getPageBlocksTree") assert.ok(NAMES.includes(args[0]) && args.length === 1);
      else if (method === "Editor.getBlock") assert.deepEqual(args, [UUID, { includeChildren: true }]);
      else assert.fail(`Unexpected method: ${method}`);
    }
  });
  return { sdk, calendar, calendarCalls, calls, tree, routine, today };
}
const check = (result, id) => result.checks.find((item) => item.id === id);
function safe(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const privateValue of [GRAPH.path, GRAPH.url, SECRET, UUID]) assert.ok(!text.includes(privateValue), text);
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("returns the exact JSON envelope using only named read APIs and preserves source data", async (t) => {
  const f = fixture(t);
  const before = JSON.stringify([f.tree, f.routine, f.today]);
  const result = await inspectSetup(f);
  assert.deepEqual(Object.keys(result), ["version", "graph", "calendar", "checks", "sections", "warnings"]);
  assert.equal(result.version, 1);
  assert.deepEqual(result.graph, { name: GRAPH.name });
  assert.deepEqual(result.calendar, { state: "available", today: TODAY });
  assert.strictEqual(result.calendar.today, f.today);
  assert.deepEqual(result.sections, SECTIONS);
  assert.equal(result.checks.length, 10);
  for (const item of result.checks) {
    assert.deepEqual(Object.keys(item), ["id", "title", "state", "detail"]);
    assert.equal(item.state, "existing");
    assert.equal(typeof item.detail, "string");
  }
  assert.match(check(result, "week-routine").detail, /1 available, 1 empty/);
  assert.match(check(result, "month-routine").detail, /1 available, 0 empty/);
  assert.match(check(result, "templates").detail, /User-owned.*no overwrite permission/);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
  assert.equal(JSON.stringify([f.tree, f.routine, f.today]), before);
  safe(result);
  assert.deepEqual(f.calendarCalls, ["describeToday"]);
  assert.deepEqual(f.calls.filter(([method]) => method === "Editor.getPage").map(([, name]) => name), NAMES);
  assert.ok(!f.calls.some(([method, name]) => method === "Editor.getPageBlocksTree" && name === "Templates"));
  assert.equal(f.calls[0][0], "App.getCurrentGraph");
  assert.equal(f.calls.at(-1)[0], "App.getCurrentGraph");
  assert.match(result.warnings.join(" "), /not a complete graph duplicate or owner scan/);
  assert.match(result.warnings.join(" "), /Active legacy automation is not detected/);
  assert.match(result.warnings.join(" "), /no apply, graph writes, or migration/);
});

test("global template is inspected even when Templates is absent", async (t) => {
  const result = await inspectSetup(fixture(t, { "Editor.getPage": () => null }));
  for (const id of ["templates", "week-routine", "month-routine"]) assert.equal(check(result, id).state, "missing");
  assert.equal(check(result, "daily-default").state, "existing");
  assert.equal(check(result, "section-focus").state, "existing");
});

test("missing global template does not fall back to searching Templates or another page", async (t) => {
  const f = fixture(t, { "App.getTemplate": () => null });
  const result = await inspectSetup(f);
  assert.equal(check(result, "daily-default").state, "missing");
  for (const item of result.checks.filter(({ id }) => id.startsWith("section-"))) assert.equal(item.state, "missing");
  assert.ok(!f.calls.some(([name]) => name === "Editor.getBlock"));
});

test("detects nested duplicates, numbered routine headings, missing sections, and ignores body text/properties", async (t) => {
  const tree = {
    uuid: UUID, content: `${SECRET}\nFocus`, children: [
      block("### focus", [block("Focus")]),
      block("## Weekly tasks — 1\nroutine-section:: [[Routine Weekly Section]]"),
      block("Monthly tasks — 2"),
      block("## Tasks", [block("task body\n## Notes")]),
      block("Notes are not a section"),
      block("text\nsection:: End-of-day review"),
    ],
  };
  const result = await inspectSetup(fixture(t, { "Editor.getBlock": () => tree }));
  assert.equal(check(result, "section-focus").state, "warning");
  assert.match(check(result, "section-focus").detail, /2 matching/);
  for (const id of ["section-weekly-tasks", "section-monthly-tasks", "section-tasks"]) assert.equal(check(result, id).state, "existing");
  for (const id of ["section-notes", "section-end-of-day-review"]) assert.equal(check(result, id).state, "missing");
  safe(result);
});

for (const [label, tree, available, empty] of [
  ["empty", [], 0, 0],
  ["blank", [block(" "), block("\n")], 0, 2],
  ["title only", [block("# Week Routine")], 0, 0],
  ["properties only", [block(`id:: ${UUID}\nroutine-loaded:: weekly-20250315`)], 0, 1],
  ["title wrapper and nested tasks", [block("Week Routine", [block("TODO one", [block("TODO child")])]), block("TODO two")], 2, 0],
]) {
  test(`routine counts: ${label}`, async (t) => {
    const result = await inspectSetup(fixture(t, { "Editor.getPageBlocksTree": () => tree }));
    assert.equal(check(result, "week-routine").state, available ? "existing" : "warning");
    assert.ok(check(result, "week-routine").detail.includes(`${available} available, ${empty} empty`));
  });
}

const BAD_TREES = [
  ["null", null], ["undefined", undefined], ["object", {}], ["string", SECRET],
  ["null block", [null]], ["missing content", [{}]], ["numeric content", [{ content: 2 }]],
  ["null children", [{ content: "", children: null }]],
  ["tuple child", [block("parent", [["uuid", UUID]])]],
  ["non-array children", [{ content: "", children: {} }]],
  ["duplicate identity", [{ content: "a", uuid: UUID }, { content: "b", uuid: UUID }]],
  ["empty UUID", [{ content: "", uuid: "" }]],
  ["oversize", Array.from({ length: 10001 }, () => block(""))],
];
const cycle = block(SECRET);
cycle.children.push(cycle);
BAD_TREES.push(["cycle", [cycle]]);
for (const [label, tree] of BAD_TREES) {
  test(`routine malformed tree is unavailable, not empty: ${label}`, async (t) => {
    const result = await inspectSetup(fixture(t, { "Editor.getPageBlocksTree": () => tree }));
    assert.equal(check(result, "week-routine").state, "unavailable");
    assert.equal(check(result, "month-routine").state, "unavailable");
    safe(result);
  });
  test(`template malformed children cannot imply missing sections: ${label}`, async (t) => {
    const result = await inspectSetup(fixture(t, { "Editor.getBlock": () => ({ uuid: UUID, content: "", children: tree }) }));
    // Undefined children are the SDK's valid leaf representation.
    assert.equal(check(result, "section-focus").state, tree === undefined ? "missing" : "unavailable");
    safe(result);
  });
}
for (const value of [undefined, {}, [], "bad", { name: 1 }, { name: "Other page" }]) {
  test(`malformed page response: ${JSON.stringify(value)}`, async (t) => {
    const f = fixture(t, { "Editor.getPage": () => value });
    const result = await inspectSetup(f);
    for (const id of ["templates", "week-routine", "month-routine"]) assert.equal(check(result, id).state, "unavailable");
    assert.ok(!f.calls.some(([method]) => method === "Editor.getPageBlocksTree"));
  });
}
for (const value of [undefined, {}, [], "bad", { uuid: 42 }, { uuid: " " }]) {
  test(`malformed template lookup: ${JSON.stringify(value)}`, async (t) => {
    const result = await inspectSetup(fixture(t, { "App.getTemplate": () => value }));
    assert.equal(check(result, "daily-default").state, "unavailable");
    assert.equal(check(result, "section-focus").state, "unavailable");
  });
}
for (const value of [null, undefined, {}, { uuid: "different", content: "Focus" }]) {
  test(`missing/mismatched fetched template: ${JSON.stringify(value)}`, async (t) => {
    const result = await inspectSetup(fixture(t, { "Editor.getBlock": () => value }));
    assert.equal(check(result, "daily-default").state, "existing");
    assert.equal(check(result, "section-focus").state, "unavailable");
  });
}

const READS = [
  ["Editor.getPage", "week-routine"], ["Editor.getPageBlocksTree", "week-routine"],
  ["App.getTemplate", "daily-default"], ["Editor.getBlock", "section-focus"],
];
for (const [method, id] of READS) {
  for (const mode of ["throw", "reject", "timeout"]) {
    test(`${method} ${mode} is safely unavailable and independent checks continue`, async (t) => {
      const late = deferred();
      const f = fixture(t, { [method]: () => {
        if (mode === "throw") throw new Error(GRAPH.path);
        if (mode === "reject") return Promise.reject(SECRET);
        return late.promise;
      } });
      const result = await inspectSetup({ ...f, timeoutMs: 15 });
      assert.equal(check(result, id).state, "unavailable");
      assert.equal(result.calendar.state, "available");
      const snapshot = JSON.stringify(result);
      if (mode === "timeout") late.reject(new Error(GRAPH.path));
      await nextTurn();
      assert.equal(JSON.stringify(result), snapshot);
      safe(result);
    });
  }
}

for (const [label, calendar] of [
  ["absent", undefined], ["missing method", {}], ["null description", { describeToday: () => null }],
  ["malformed description", { describeToday: () => ({}) }],
  ["throw", { describeToday() { throw new Error(GRAPH.path); } }],
  ["reject", { describeToday: () => Promise.reject(SECRET) }],
  ["timeout", { describeToday: () => new Promise(() => {}) }],
]) {
  test(`calendar ${label} still permits all named inspections without invented period data`, async (t) => {
    const result = await inspectSetup({ ...fixture(t), calendar, timeoutMs: 15 });
    assert.equal(result.calendar.state, "unavailable");
    assert.deepEqual(Object.keys(result.calendar), ["state", "reason"]);
    assert.equal(check(result, "month-routine").state, "existing");
    assert.equal(check(result, "section-focus").state, "existing");
    safe(result);
  });
}

test("uses the existing client's fresh validation, unchanged descriptions/keys, and recovery", async (t) => {
  const calls = [];
  let valid = true;
  const calendar = createCalendarClient({ invoke(target) {
    calls.push(target);
    if (target.endsWith("getApiInfo")) return { id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"] };
    assert.equal(target, "persian-calendar.models.describeToday");
    return valid ? TODAY : { ...TODAY, week: { ...TODAY.week, key: "invented" } };
  } });
  t.after(() => calendar.destroy());
  const f = fixture(t);
  const first = await inspectSetup({ ...f, calendar });
  assert.deepEqual(first.calendar.today, TODAY);
  valid = false;
  assert.equal((await inspectSetup({ ...f, calendar })).calendar.state, "unavailable");
  valid = true;
  assert.deepEqual((await inspectSetup({ ...f, calendar })).calendar.today, TODAY);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ["persian-calendar.models.getApiInfo", "persian-calendar.models.describeToday"]).flat());
  first.sections.push("local UI edit");
  assert.deepEqual((await inspectSetup(f)).sections, SECTIONS);
});

for (const value of [null, undefined, {}, { name: "DB graph" }, { name: "graph", path: " " }, { path: GRAPH.path }, { name: 1, path: GRAPH.path }]) {
  test(`rejects no graph or malformed graph: ${JSON.stringify(value)}`, async (t) => {
    const f = fixture(t, { "App.getCurrentGraph": () => value });
    await assert.rejects(inspectSetup(f), (error) => {
      safe(error.message);
      assert.match(error.message, value === null ? /No graph is open/ : /file graph|invalid name/);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calendarCalls, []);
  });
}
for (const phase of ["initial", "final"]) {
  for (const mode of ["throw", "timeout", "closed", "changed"]) {
    test(`${phase} graph ${mode} rejects rather than returning a stale preview`, async (t) => {
      let end = false;
      const f = fixture(t, {
        "Editor.getBlock": () => { end = true; return templateTree(); },
        "App.getCurrentGraph": () => {
          if (phase === "final" && !end) return GRAPH;
          if (mode === "throw") throw new Error(GRAPH.path);
          if (mode === "timeout") return new Promise(() => {});
          if (mode === "closed") return null;
          return { ...GRAPH, path: "/private/other" };
        },
      });
      // An initially different valid graph is a valid baseline, not a race.
      if (phase === "initial" && mode === "changed") {
        assert.equal((await inspectSetup(f)).graph.name, GRAPH.name);
      } else {
        await assert.rejects(inspectSetup({ ...f, timeoutMs: 15 }), (error) => { safe(error.message); return true; });
      }
    });
  }
}

test("same-name graph path changes and in-place graph mutations invalidate UUID reads", async (t) => {
  const graph = { ...GRAPH };
  const f = fixture(t, {
    "App.getCurrentGraph": () => graph,
    "App.getTemplate": () => { graph.path = "/other/private/path"; return { uuid: UUID }; },
  });
  await assert.rejects(inspectSetup(f), /graph changed/);
  assert.ok(!f.calls.some(([method]) => method === "Editor.getBlock"));
});

test("graph rename with the same path is not a graph switch", async (t) => {
  let count = 0;
  const result = await inspectSetup(fixture(t, { "App.getCurrentGraph": () => ({ ...GRAPH, name: count++ ? "Renamed" : GRAPH.name }) }));
  assert.deepEqual(result.graph, { name: GRAPH.name });
});

test("pre-aborted inspection performs no reads and redacts the abort reason", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort(new Error(GRAPH.path));
  await assert.rejects(inspectSetup({ ...f, signal: controller.signal }), (error) => {
    assert.equal(error.name, "AbortError"); safe(error.message); return true;
  });
  assert.deepEqual(f.calls, []);
});
for (const method of ["App.getCurrentGraph", ...READS.map(([name]) => name), "calendar"]) {
  for (const settle of ["resolve", "reject"]) {
    test(`abort pending ${method}, late ${settle} is ignored and no further reads run`, async (t) => {
      const waiting = deferred();
      const entered = deferred();
      const controller = new AbortController();
      const wait = () => { entered.resolve(); return waiting.promise; };
      const f = fixture(t, method === "calendar" ? {} : { [method]: wait });
      const promise = inspectSetup({ ...f, signal: controller.signal, ...(method === "calendar" ? { calendar: { describeToday: wait } } : {}) });
      await entered.promise;
      const rejected = assert.rejects(promise, (error) => {
        assert.equal(error.name, "AbortError"); safe(error.message); return true;
      });
      controller.abort(new Error(GRAPH.path));
      await rejected;
      const count = f.calls.length;
      waiting[settle](settle === "reject" ? new Error(GRAPH.path) : templateTree());
      await nextTurn();
      assert.equal(f.calls.length, count);
    });
  }
}
for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, "3000", null, 2_147_483_648]) {
  test(`invalid timeout is rejected before reads: ${String(timeoutMs)}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(inspectSetup({ ...f, timeoutMs }), /timeoutMs/);
    assert.deepEqual(f.calls, []);
  });
}
