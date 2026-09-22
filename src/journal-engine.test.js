import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createJournalEngine, resolveJournalSections } from "./journal-engine.js";
import { blockProperty } from "./journal-model.js";

const uuid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
const block = (n, content, children = []) => ({ uuid: uuid(n), content, children });
const page = (day, blocks = []) => ({ name: `journal-${day}`, journalDay: day, blocks });
const INFO = { id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"] };
// Fixed provider wire fixtures, not a second Persian calendar implementation.
const DATES = {
  "2025-03-20": description("2025-03-20", "1403-12-30", 53, "2025-03-15", "2025-03-21", "2025-02-19", "2025-03-20"),
  "2025-03-21": description("2025-03-21", "1404-01-01", 1, "2025-03-15", "2025-03-21", "2025-03-21", "2025-04-20"),
  "2025-03-22": description("2025-03-22", "1404-01-02", 2, "2025-03-22", "2025-03-28", "2025-03-21", "2025-04-20"),
  "2025-03-23": description("2025-03-23", "1404-01-03", 2, "2025-03-22", "2025-03-28", "2025-03-21", "2025-04-20"),
  "2025-04-21": description("2025-04-21", "1404-02-01", 6, "2025-04-19", "2025-04-25", "2025-04-21", "2025-05-21"),
};
function description(iso, persianIso, weekOfYear, weekStart, weekEnd, monthStart, monthEnd) {
  const [year, month, day] = iso.split("-").map(Number);
  const [py, pm, pd] = persianIso.split("-").map(Number);
  return {
    gregorian: { year, month, day, iso, journalDay: Number(iso.replaceAll("-", "")) },
    persian: { year: py, month: pm, day: pd, iso: persianIso, label: `تاریخ ${persianIso}`, weekOfYear },
    week: { start: weekStart, end: weekEnd, key: `weekly-${weekStart.replaceAll("-", "")}` },
    month: { start: monthStart, end: monthEnd, key: `monthly-${persianIso.slice(0, 7)}`, financeKey: persianIso.slice(0, 7) },
  };
}
function fixture() {
  return { version: 1, graphId: "private-graph-A", journalDay: 20250321, ownerScanComplete: true,
    pages: [page(20250321)], routines: {
      weekly: [block(100, "# Week Routine", [block(101, "TODO weekly\nid:: source-id\ncustom:: keep", [block(102, "DONE nested")])])],
      monthly: [block(110, "# Month Routine", [block(111, "TODO monthly")])],
    } };
}
function harness(t, options = {}) {
  let nextId = 10000;
  const state = { today: "2025-03-21", fail: false, calls: [], gate: null };
  async function invoke(target, ...args) {
    state.calls.push({ target, args });
    if (state.fail) throw new Error("PRIVATE host path and note");
    const method = target.replace("persian-calendar.models.", "");
    if (state.gate && method === "describeDate") await state.gate;
    if (method === "getApiInfo") return structuredClone(INFO);
    if (method === "fromJournalDay") {
      const raw = String(args[0]);
      return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    }
    if (method === "describeDate") return structuredClone(DATES[args[0]]);
    if (method === "describeToday") return structuredClone(DATES[state.today]);
    throw new Error("Unexpected model call");
  }
  const engine = createJournalEngine({ invoke, createUuid: () => uuid(nextId++), ...options });
  t.after(() => engine.destroy());
  return { engine, state };
}
function section(result, title) {
  return result.nextJournal.blocks.find((entry) => entry.uuid === result.sections[title]);
}
function project(source, result) {
  assert.equal(result.status, "planned", result.reason);
  const next = structuredClone(source);
  next.pages = next.pages.map((entry) => entry.journalDay === result.nextJournal.journalDay ? structuredClone(result.nextJournal) : entry);
  return next;
}
async function seed(t) {
  const h = harness(t), source = fixture();
  const result = await h.engine.plan(source);
  return { ...h, source: project(source, result), result };
}
function addDay(source, day) {
  const next = structuredClone(source);
  next.journalDay = day;
  next.pages.push(page(day));
  return next;
}

test("empty today: daily structure, Calendar labels/keys, new task identities, no input mutation", async (t) => {
  const { engine, state } = harness(t), source = fixture(), saved = structuredClone(source);
  const result = await engine.plan(source);
  assert.equal(result.status, "planned", result.reason);
  assert.deepEqual(source, saved);
  assert.equal(result.graphId, source.graphId);
  assert.deepEqual(result.nextJournal.blocks.map((entry) => entry.content.split("\n")[0]), [
    "## تاریخ 1404-01-01", "## Focus", "## Weekly tasks — 1", "## Monthly tasks — 1", "## Tasks", "## Notes", "## End-of-day review",
  ]);
  assert.match(result.nextJournal.blocks[0].content, /jalali-date:: 1404-01-01\njalali-section:: \[\[Jalali Date Section\]\]/);
  assert.equal(section(result, "Focus").children[0].content, "");
  assert.equal(section(result, "Tasks").children[0].content, "");
  const weekly = section(result, "Weekly tasks");
  assert.equal(blockProperty(weekly, "routine-loaded"), "weekly-20250315");
  assert.equal(weekly.children[0].content, "TODO weekly\ncustom:: keep");
  assert.notEqual(weekly.children[0].uuid, uuid(101));
  assert.equal(weekly.children[0].children[0].content, "DONE nested");
  assert.equal(result.owners.monthly.key, "monthly-1404-01");
  assert.ok(state.calls.every(({ target }) => target.startsWith("persian-calendar.models.")));
  assert.ok(state.calls.filter(({ target }) => target.endsWith("getApiInfo")).length >= 4);
});

test("repeat projection is a no-op; loaded tasks/completions survive changed defaults", async (t) => {
  const { engine, source, result } = await seed(t);
  const weekly = source.pages[0].blocks.find((entry) => entry.uuid === result.owners.weekly.uuid);
  weekly.children[0].content = "DONE finished task";
  source.routines.weekly[0].children.push(block(103, "TODO new default for next week"));
  const repeated = await engine.plan(source);
  assert.equal(repeated.status, "planned", repeated.reason);
  assert.deepEqual(repeated.changes, []);
  assert.deepEqual(structuredClone(repeated.nextJournal), source.pages[0]);
  assert.equal(repeated.owners.weekly.uuid, result.owners.weekly.uuid);
});

test("Saturday rollover creates only weekly owner, monthly references retain original task IDs", async (t) => {
  const { engine, state, source, result } = await seed(t);
  const next = addDay(source, 20250322);
  state.today = "2025-03-22";
  const saturday = await engine.plan(next);
  assert.equal(saturday.status, "planned", saturday.reason);
  assert.equal(saturday.owners.weekly.key, "weekly-20250322");
  assert.notEqual(saturday.owners.weekly.uuid, result.owners.weekly.uuid);
  assert.equal(saturday.owners.monthly.uuid, result.owners.monthly.uuid);
  const ownerTask = section(result, "Monthly tasks").children[0];
  assert.equal(section(saturday, "Monthly tasks").children[0].content,
    `((${ownerTask.uuid}))\nroutine-reference:: ${ownerTask.uuid}`);
  assert.deepEqual(next.pages[0], source.pages[0], "prior journal remains read-only");
  const repeated = await engine.plan(project(next, saturday));
  assert.deepEqual(repeated.changes, []);
});

test("next day in the same periods reuses both owners, including completed task identities", async (t) => {
  const { engine, state, source } = await seed(t);
  state.today = "2025-03-22";
  const saturdaySource = addDay(source, 20250322);
  const saturday = await engine.plan(saturdaySource);
  const sundaySource = addDay(project(saturdaySource, saturday), 20250323);
  const weeklyOwner = sundaySource.pages[1].blocks.find((entry) => entry.uuid === saturday.owners.weekly.uuid);
  weeklyOwner.children[0].content = "DONE completed Saturday task";
  state.today = "2025-03-23";
  const sunday = await engine.plan(sundaySource);
  assert.equal(sunday.status, "planned", sunday.reason);
  assert.deepEqual(sunday.owners, saturday.owners);
  assert.equal(blockProperty(section(sunday, "Weekly tasks").children[0], "routine-reference"), weeklyOwner.children[0].uuid);
  assert.equal(blockProperty(section(sunday, "Weekly tasks").children[0].children[0], "routine-reference"), weeklyOwner.children[0].children[0].uuid);
  assert.equal(blockProperty(section(sunday, "Weekly tasks"), "routine-loaded"), null);
  assert.deepEqual((await engine.plan(project(sundaySource, sunday))).changes, []);
});

test("Jalali month rollover copies a new monthly snapshot without altering prior owners", async (t) => {
  const { engine, state, source, result } = await seed(t);
  const next = addDay(source, 20250421);
  state.today = "2025-04-21";
  const april = await engine.plan(next);
  assert.equal(april.status, "planned", april.reason);
  assert.equal(april.owners.monthly.key, "monthly-1404-02");
  assert.notEqual(april.owners.monthly.uuid, result.owners.monthly.uuid);
  assert.deepEqual(next.pages[0], source.pages[0]);
});

test("Nowruz uses shared Gregorian week but a new Jalali monthly owner", async (t) => {
  const { engine, state } = harness(t), source = fixture();
  source.journalDay = 20250320;
  source.pages = [page(20250320)];
  state.today = "2025-03-20";
  const esfand = await engine.plan(source);
  const next = addDay(project(source, esfand), 20250321);
  state.today = "2025-03-21";
  const nowruz = await engine.plan(next);
  assert.equal(nowruz.status, "planned", nowruz.reason);
  assert.equal(nowruz.owners.weekly.uuid, esfand.owners.weekly.uuid);
  assert.notEqual(nowruz.owners.monthly.uuid, esfand.owners.monthly.uuid);
  assert.equal(nowruz.owners.monthly.key, "monthly-1404-01");
});

test("recursive references keep UUIDs across owner reorder/reparent, preserve local notes, remove only stale generated refs", async (t) => {
  const { engine, state, source, result } = await seed(t);
  state.today = "2025-03-22";
  let next = addDay(source, 20250322);
  // Make the month owner recursive with a second task before creating references.
  const owner = next.pages[0].blocks.find((entry) => entry.uuid === result.owners.monthly.uuid);
  owner.children[0].children.push(block(500, "TODO nested monthly"));
  owner.children.push(block(501, "TODO second monthly"));
  const first = await engine.plan(next);
  next = project(next, first);
  const refs = section(first, "Monthly tasks").children;
  const parentRef = refs[0].uuid, nestedRef = refs[0].children[0].uuid, removedRef = refs[1].uuid;
  const nextOwner = next.pages[0].blocks.find((entry) => entry.uuid === owner.uuid);
  const child = nextOwner.children[0].children.pop();
  nextOwner.children = [child, nextOwner.children[0]];
  const target = next.pages[1].blocks.find((entry) => entry.uuid === first.sections["Monthly tasks"]);
  target.children.unshift(block(502, "PRIVATE local note", [block(503, "keep child")]));
  const updated = await engine.plan(next);
  assert.equal(updated.status, "planned", updated.reason);
  const updatedRefs = section(updated, "Monthly tasks").children;
  assert.equal(updatedRefs[0].uuid, uuid(502));
  assert.equal(updatedRefs[0].children[0].uuid, uuid(503));
  assert.equal(updatedRefs[1].uuid, nestedRef);
  assert.equal(updatedRefs[2].uuid, parentRef);
  assert.ok(updated.changes.some((change) => change.kind === "remove" && change.uuid === removedRef));
  assert.deepEqual((await engine.plan(project(next, updated))).changes, []);
});

test("canonical legacy embed is replaced; customized references/embeds fail closed", async (t) => {
  const { engine, state, source, result } = await seed(t);
  state.today = "2025-03-22";
  const next = addDay(source, 20250322);
  next.pages[1].blocks = [block(600, "## Monthly tasks", [block(601, `{{embed ((${result.owners.monthly.uuid}))}}`)])];
  const migrated = await engine.plan(next);
  assert.equal(migrated.status, "planned", migrated.reason);
  assert.ok(migrated.changes.some((change) => change.kind === "remove" && change.uuid === uuid(601)));
  const custom = project(next, migrated);
  const ref = custom.pages[1].blocks.find((entry) => entry.uuid === uuid(600)).children[0];
  ref.content += "\nPRIVATE extra note";
  const blocked = await engine.plan(custom);
  assert.equal(blocked.reason, "customized-reference");
  assert.equal(blocked.nextJournal, null);
  next.pages[1].blocks[0].children[0].children.push(block(602, "attached note"));
  assert.equal((await engine.plan(next)).reason, "customized-reference");
});

test("existing structure preserves UUIDs, custom text, unknown roots, Habits, Notes and review", async (t) => {
  const { engine } = harness(t), source = fixture();
  source.pages[0].blocks = [
    block(1, "## Notes", [block(2, "PRIVATE note")]),
    block(3, "unknown root", [block(4, "keep")]),
    block(5, "## Tasks\ncustom:: keep", [block(6, "TODO real task")]),
    block(7, "## Habits\nhabit-section:: [[Habit Section]]", [block(8, "DONE habit")]),
    block(9, "## End-of-day review", [block(10, "custom review question")]),
    block(11, "## Focus", [block(12, "What would make today successful?"), block(13, "TODO Choose one important task.", [block(14, "attached note")])]),
  ];
  const before = structuredClone(source);
  const result = await engine.plan(source);
  assert.equal(result.status, "planned", result.reason);
  assert.deepEqual(source, before);
  assert.deepEqual(structuredClone(section(result, "Notes")), before.pages[0].blocks[0]);
  assert.deepEqual(structuredClone(section(result, "End-of-day review")), before.pages[0].blocks[4]);
  assert.equal(result.sections.Tasks, uuid(5));
  assert.equal(section(result, "Tasks").content, "## Tasks\ncustom:: keep");
  assert.equal(result.nextJournal.blocks[2].uuid, uuid(3), "unknown root keeps slot after prepended date");
  assert.deepEqual(structuredClone(result.nextJournal.blocks.find((entry) => entry.uuid === uuid(7))), before.pages[0].blocks[3]);
  assert.deepEqual(section(result, "Focus").children.map((entry) => entry.uuid), [uuid(13)]);
  assert.ok(result.warnings.includes("placeholder-with-children-preserved"));
  assert.deepEqual((await engine.plan(project(source, result))).changes, []);
});

for (const mode of ["missing", "empty"]) {
  test(`${mode} routines leave owner unset for later retry`, async (t) => {
    const { engine } = harness(t), source = fixture();
    source.routines.weekly = mode === "missing" ? null : [];
    const result = await engine.plan(source);
    assert.equal(result.status, "planned", result.reason);
    assert.equal(result.owners.weekly, null);
    assert.equal(blockProperty(section(result, "Weekly tasks"), "routine-loaded"), null);
    assert.ok(result.warnings.includes(`weekly-routine-page-${mode}`));
    const retry = project(source, result);
    retry.routines.weekly = [block(700, "TODO later default")];
    const loaded = await engine.plan(retry);
    assert.ok(loaded.owners.weekly);
  });
}

test("future journal gets structure only, past journal is skipped, missing native page waits", async (t) => {
  const { engine, state } = harness(t), source = fixture();
  state.today = "2025-03-20";
  const future = await engine.plan(source);
  assert.equal(future.status, "planned", future.reason);
  assert.equal(blockProperty(section(future, "Weekly tasks"), "routine-loaded"), null);
  assert.deepEqual(future.owners, {});
  state.today = "2025-03-22";
  const past = await engine.plan(source);
  assert.equal(past.status, "skipped");
  assert.equal(past.nextJournal, null);
  source.pages = [];
  assert.equal((await engine.plan(source)).status, "waiting");
});

for (const [name, mutate, reason] of [
  ["incomplete owner scan", (s) => { s.ownerScanComplete = false; }, "incomplete-owner-scan"],
  ["duplicate journal day", (s) => { s.pages.push(page(20250321)); }, "duplicate-journal"],
  ["duplicate section", (s) => { s.pages[0].blocks = [block(1, "## Tasks"), block(2, "## Tasks")]; }, "duplicate-section"],
  ["conflicting section identity", (s) => { s.pages[0].blocks = [block(1, "## Weekly tasks\nroutine-section:: [[Routine Monthly Section]]")]; }, "conflicting-section"],
  ["nested managed date", (s) => { s.pages[0].blocks = [block(1, "parent", [block(2, "date\njalali-section:: [[Jalali Date Section]]")])]; }, "nested-managed-section"],
  ["nested title-only period", (s) => { s.pages[0].blocks = [block(1, "parent", [block(2, "## Weekly tasks")])]; }, "nested-managed-section"],
  ["unmarked populated routine", (s) => { s.pages[0].blocks = [block(1, "## Weekly tasks", [block(2, "TODO possibly already copied")])]; }, "unmarked-routine-content"],
  ["stale loaded marker", (s) => { s.pages[0].blocks = [block(1, "## Weekly tasks\nroutine-loaded:: weekly-20250308")]; }, "conflicting-loaded-period"],
  ["duplicate owner", (s) => { s.pages[0].blocks = [block(1, "## Weekly tasks\nroutine-loaded:: weekly-20250315")]; s.pages.push(page(20250320, [block(2, "## Weekly tasks\nroutine-loaded:: weekly-20250315")])); }, "duplicate-period-owner"],
  ["ambiguous external owner", (s) => { s.pages.push(page(20250320, [block(1, "## Weekly tasks\nroutine-loaded:: weekly-20250315\nroutine-section:: [[Routine Monthly Section]]")])); }, "conflicting-section"],
  ["duplicate external section", (s) => { s.pages.push(page(20250320, [block(1, "## Weekly tasks\nroutine-loaded:: weekly-20250315"), block(2, "## Weekly tasks")])); }, "duplicate-section"],
  ["owner on future page", (s) => { s.pages.push(page(20250322, [block(1, "## Monthly tasks\nroutine-loaded:: monthly-1404-01")])); }, "future-period-owner"],
  ["owner outside period", (s) => { s.pages.push(page(20250320, [block(1, "## Monthly tasks\nroutine-loaded:: monthly-1404-01")])); }, "owner-outside-period"],
  ["malformed tuple", (s) => { s.pages[0].blocks = [["uuid", uuid(1)]]; }, "invalid-snapshot"],
  ["duplicate source UUID", (s) => { s.pages[0].blocks = [block(100, "colliding")]; }, "invalid-snapshot"],
]) {
  test(`blocks ambiguous input without leaking partial output: ${name}`, async (t) => {
    const { engine } = harness(t), source = fixture();
    mutate(source);
    const before = structuredClone(source);
    const result = await engine.plan(source);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, reason);
    assert.equal(result.nextJournal, null);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(source, before);
    assert.ok(!JSON.stringify(result).includes("private-graph"));
  });
}

for (const property of ["routine-loaded", "routine-section", "routine-reference", "jalali-date", "jalali-section"]) {
  test(`routine defaults cannot inject reserved marker ${property}`, async (t) => {
    const { engine } = harness(t), source = fixture();
    source.routines.weekly[0].children[0].content += `\n${property}:: reserved`;
    assert.equal((await engine.plan(source)).reason, "reserved-routine-property");
  });
}

for (const prefix of ["id:: source-id", "created-at:: 123", "updated-at:: 456"]) {
  test(`identity cleanup cannot introduce a reserved nested section: ${prefix}`, async (t) => {
    const { engine } = harness(t), source = fixture();
    source.routines.weekly = [block(800, `${prefix}\n## Weekly tasks`)];
    assert.equal((await engine.plan(source)).reason, "reserved-routine-section");
  });
}

for (const populated of [false, true]) {
  test(`property-first loaded owner is preserved, not refilled (populated=${populated})`, async (t) => {
    const { engine } = harness(t), source = fixture();
    source.pages[0].blocks = [block(800, "routine-loaded:: weekly-20250315\nroutine-section:: [[Routine Weekly Section]]",
      populated ? [block(801, "DONE existing task")] : [])];
    const result = await engine.plan(source);
    assert.equal(result.status, "planned", result.reason);
    const weekly = section(result, "Weekly tasks");
    assert.equal(weekly.uuid, uuid(800));
    assert.equal(blockProperty(weekly, "routine-loaded"), "weekly-20250315");
    assert.equal(weekly.children.length, populated ? 1 : 0);
    if (populated) assert.equal(weekly.children[0].content, "DONE existing task");
    assert.deepEqual((await engine.plan(project(source, result))).changes, []);
  });
}

test("aggregate projection bounds fail before returning a non-replayable result", async (t) => {
  const { engine } = harness(t), source = fixture();
  source.routines.weekly = Array.from({ length: 5000 }, (_, i) => block(i + 100, "TODO task"));
  source.routines.monthly = [];
  const result = await engine.plan(source);
  assert.equal(result.status, "blocked");
  assert.equal(result.nextJournal, null);
});

test("snapshots are captured before first await, even if caller switches graph immediately", async (t) => {
  const { engine } = harness(t), source = fixture();
  const pending = engine.plan(source);
  source.graphId = "different graph";
  source.pages[0].blocks.push(block(900, "late caller note"));
  const result = await pending;
  assert.equal(result.status, "planned", result.reason);
  assert.equal(result.graphId, "private-graph-A");
  assert.ok(!JSON.stringify(result.nextJournal).includes("late caller note"));
});

for (const action of ["invalidate", "destroy", "supersede"]) {
  test(`pending Calendar results cannot publish after ${action}`, async (t) => {
    const { engine, state } = harness(t), source = fixture();
    let release;
    state.gate = new Promise((resolve) => { release = resolve; });
    const pending = engine.plan(source);
    await nextTurn();
    let newest;
    if (action === "supersede") {
      state.gate = null;
      newest = engine.plan({ ...source, graphId: "new graph" });
    } else await engine[action]();
    release();
    const result = await pending;
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "stale-context");
    if (newest) assert.equal((await newest).graphId, "new graph");
    if (action === "destroy") assert.equal((await engine.plan(source)).reason, "disposed");
  });
}

test("dependency failure is sanitized and later calls recover without cached success", async (t) => {
  const { engine, state } = harness(t), source = fixture();
  state.fail = true;
  const result = await engine.plan(source);
  assert.equal(result.reason, "calendar-unavailable");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  state.fail = false;
  assert.equal((await engine.plan(source)).status, "planned");
});

for (const version of [2, null]) {
  test(`incompatible or malformed Calendar info never yields a journal projection: ${version}`, async (t) => {
    const { engine } = harness(t, { invoke: async () => version === null ? null : { ...INFO, version } });
    const result = await engine.plan(fixture());
    assert.equal(result.reason, "calendar-unavailable");
    assert.equal(result.nextJournal, null);
    assert.deepEqual(result.changes, []);
  });
}

test("timeout returns no projection and later planning recovers", async (t) => {
  const { engine, state } = harness(t, { timeoutMs: 10 }), source = fixture();
  state.gate = new Promise(() => {});
  assert.equal((await engine.plan(source)).reason, "calendar-unavailable");
  state.gate = null;
  assert.equal((await engine.plan(source)).status, "planned");
});

test("UUID factory cannot reuse source identities or publish after reentrant invalidation", async (t) => {
  const { engine } = harness(t, { createUuid: () => uuid(100) });
  assert.equal((await engine.plan(fixture())).reason, "invalid-new-identity");
  let reentrant, id = 10000;
  const h = harness(t, { createUuid: () => { void reentrant.invalidate(); return uuid(id++); } });
  reentrant = h.engine;
  assert.equal((await reentrant.plan(fixture())).reason, "stale-context");
});

test("foreign callback errors cannot leak source text through reason codes", async (t) => {
  const { engine } = harness(t, { createUuid: () => {
    const error = new Error("PRIVATE note");
    error.code = "PRIVATE path";
    throw error;
  } });
  const result = await engine.plan(fixture());
  assert.equal(result.reason, "ambiguous-journal-data");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("section resolver provides stable existing IDs and null for absent sections", () => {
  const result = resolveJournalSections([block(1, "## Tasks"), block(2, "Renamed\nroutine-section:: [[Routine Weekly Section]]")]);
  assert.equal(result.Tasks, uuid(1));
  assert.equal(result["Weekly tasks"], uuid(2));
  assert.equal(result.Notes, null);
});
