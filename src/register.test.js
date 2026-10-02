import assert from "node:assert/strict";
import test from "node:test";
import { registerRoutines } from "./register.js";

function fixture() {
  const calls = [], commands = new Map(), hooks = new Set();
  let handlers, unload, destroyed = 0, model, toolbar;
  const state = { graphKey: "graph-a", graphName: "A", enabled: false, calendar: "gregorian", autoOpen: true,
    definitions: { weekly: "Weekly", monthly: "Monthly" }, error: null };
  const runtime = {
    async start() { calls.push("start"); },
    async destroy() { calls.push("destroy"); },
    getStatus() { return { ...state }; },
    async refreshStatus() { calls.push("status"); return { ...state }; },
    async configure(options, key, confirmation) {
      calls.push(["configure", options, key, confirmation]); Object.assign(state, options); return { ...state };
    },
    async enable(key) { calls.push(["enable", key]); state.enabled = true; return { ...state }; },
    async disable(key) { calls.push(["disable", key]); state.enabled = false; return { ...state }; },
    async showCurrent(key) { calls.push(key ? ["current", key] : "current"); },
    async addExamples(key) { calls.push(["examples", key]); },
    async installDailyTemplate(key, options) { calls.push(["daily-template", key, options]); return { ...state }; },
    async applyDailyTemplateToday(key) { calls.push(["daily-today", key]); },
    async showHistory() { calls.push("history"); },
    async openDefinition(kind) { calls.push(["definition", kind]); },
  };
  const sdk = {
    beforeunload(fn) { unload = fn; },
    provideModel(value) { model = value; },
    App: {
      registerCommandPalette({ key }, fn) { commands.set(key, fn); },
      registerUIItem(type, options) { assert.equal(type, "toolbar"); toolbar = options; },
      onCurrentGraphChanged(fn) { hooks.add(fn); return () => hooks.delete(fn); },
    },
    UI: { async showMsg(message) { calls.push(["message", message]); } },
    showMainUI() { calls.push("show"); }, hideMainUI() { calls.push("hide"); },
    setMainUIInlineStyle() {},
  };
  const renders = [];
  function mountView(document, callbacks) {
    calls.push("mount"); handlers = callbacks;
    return { render(value) { renders.push(value); }, focus() {}, destroy() { destroyed++; } };
  }
  return { calls, commands, runtime, state, hooks, renders, sdk,
    get handlers() { return handlers; }, get destroyed() { return destroyed; },
    get model() { return model; }, get toolbar() { return toolbar; },
    unload: () => unload(),
    async register() { return registerRoutines(sdk, { runtime, document: {}, mountView }); },
  };
}

test("new entry registration starts only lightweight runtime and mounts setup lazily", async () => {
  const f = fixture(), plugin = await f.register();
  assert.deepEqual(f.calls, ["start"]);
  assert.deepEqual([...f.commands.keys()], ["journal-routines-setup", "journal-routines-show", "journal-routines-history",
    "journal-routines-definition-weekly", "journal-routines-definition-monthly", "journal-routines-disable"]);
  assert.equal(f.toolbar.key, "journal-routines-open");
  assert.match(f.toolbar.template, /data-on-click="openJournalRoutinesSetup"/);
  assert.match(f.toolbar.template, /aria-label="Open Journal &amp; Routines"/);
  assert.equal(typeof f.model.openJournalRoutinesSetup, "function");
  await f.model.openJournalRoutinesSetup();
  assert.deepEqual(f.calls.slice(1), ["status", "mount", "show"]);
  assert.equal(f.renders.at(-1).graphKey, "graph-a");
  await plugin.destroy();
  assert.equal(f.destroyed, 1);
  assert.equal(f.hooks.size, 0);
});

test("Enable saves approved graph-scoped choices first; disabled Save never enables", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  const options = { calendar: "jalali", autoOpen: false }, approval = { confirmCalendarChange: true };
  await f.handlers.onSave(options, "graph-a", approval);
  assert.equal(f.state.enabled, false);
  assert.deepEqual(f.calls.at(-1), ["configure", options, "graph-a", approval]);
  await f.handlers.onEnable(options, "graph-a", approval);
  assert.deepEqual(f.calls.slice(-2), [["configure", options, "graph-a", approval], ["enable", "graph-a"]]);
  await f.handlers.onSave({ calendar: "gregorian" }, "graph-a", approval);
  assert.deepEqual(f.calls.at(-1), ["enable", "graph-a"]);
  await f.unload();
});

test("Disable invalidates an in-flight setup chain before it can re-enable", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  let resolve;
  f.runtime.configure = () => new Promise((done) => { resolve = done; });
  const pending = f.handlers.onEnable({}, "graph-a", {});
  await f.handlers.onDisable("graph-a");
  resolve({ ...f.state });
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === "enable"), false);
  await f.unload();
});

test("graph change closes setup and prevents late open from remounting stale controls", async () => {
  const f = fixture(), plugin = await f.register();
  let resolve;
  f.runtime.refreshStatus = () => new Promise((done) => { resolve = done; });
  const pending = plugin.open();
  for (const hook of f.hooks) hook();
  resolve({ ...f.state });
  await pending;
  assert.equal(f.calls.includes("mount"), false);
  await f.unload();
});

test("explicit example action stays graph-scoped and then opens current native panes", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  await f.handlers.onAddExamples("graph-a");
  assert.deepEqual(f.calls.slice(-3), [["examples", "graph-a"], ["current", "graph-a"], "hide"]);
  await f.unload();
});

test("quick setup combines approval, enable, daily installation and today application in order", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  const options = { calendar: "gregorian", autoOpen: true, definitions: f.state.definitions };
  await f.handlers.onQuickSetup(options, "graph-a", {}, { dailyTemplate: true, replaceExisting: true });
  assert.deepEqual(f.calls.slice(-4), [["configure", options, "graph-a", {}], ["enable", "graph-a"],
    ["daily-template", "graph-a", { replaceExisting: true }], ["daily-today", "graph-a"]]);
  assert.match(f.renders.at(-1).setupMessage, /All set/);
  assert.equal(f.destroyed, 0, "completion stays visible in Setup");
});

test("quick setup can opt out of daily writes and reports a populated-today skip accurately", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  await f.handlers.onQuickSetup({}, "graph-a", {}, { dailyTemplate: false });
  assert.match(f.renders.at(-1).setupMessage, /left unchanged/);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === "daily-template"), false);
  f.runtime.applyDailyTemplateToday = async (key, options) => {
    assert.deepEqual(options, { skipUnavailable: true });
    return { applied: false, reason: "Today contains your notes." };
  };
  await f.handlers.onQuickSetup({}, "graph-a", {}, { dailyTemplate: true });
  assert.match(f.renders.at(-1).setupMessage, /Today was left unchanged.*notes/);
});

test("quick setup stops on template refusal and keeps genuine today errors actionable", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  f.runtime.installDailyTemplate = async () => { throw new Error("Explicit replacement approval required"); };
  await assert.rejects(f.handlers.onQuickSetup({}, "graph-a", {}, { dailyTemplate: true }), /approval/);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === "daily-today"), false);
  f.runtime.installDailyTemplate = async () => {};
  f.runtime.applyDailyTemplateToday = async () => { throw new Error("Native insert outcome uncertain"); };
  await assert.rejects(f.handlers.onQuickSetup({}, "graph-a", {}, { dailyTemplate: true }), /installed.*needs attention.*uncertain/);
  assert.match(f.renders.at(-1).error, /needs attention/);
});

for (const interrupt of ["disable", "graph", "unload"]) {
  test(`quick setup cancels remaining steps after ${interrupt} during configuration`, async () => {
    const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
    let finish;
    f.runtime.configure = () => new Promise((resolve) => { finish = resolve; });
    const pending = f.handlers.onQuickSetup({}, "graph-a", {}, { dailyTemplate: true });
    if (interrupt === "disable") await f.handlers.onDisable("graph-a");
    else if (interrupt === "graph") { for (const hook of f.hooks) hook(); f.state.graphKey = "graph-b"; }
    else await f.unload();
    finish({}); await assert.rejects(pending, /cancelled/);
    assert.equal(f.calls.some((call) => Array.isArray(call) && ["enable", "daily-template", "daily-today"].includes(call[0])), false);
  });
}

test("daily template callback forwards graph and replacement opt-in, refreshes status and keeps setup open", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  const renders = f.renders.length;
  for (const replaceExisting of [false, true]) {
    const options = { replaceExisting };
    const result = await f.handlers.onInstallDailyTemplate("graph-a", options);
    assert.deepEqual(f.calls.at(-1), ["daily-template", "graph-a", options]);
    assert.equal(result.graphKey, "graph-a");
  }
  assert.equal(f.renders.length, renders + 2);
  assert.deepEqual(f.renders.at(-1), f.runtime.getStatus());
  assert.equal(f.destroyed, 0);
  assert.equal(f.calls.includes("hide"), false);
  assert.equal(f.calls.some((call) => Array.isArray(call) && ["enable", "configure"].includes(call[0])), false);
  assert.equal(f.commands.size, 6);
  f.runtime.installDailyTemplate = async () => { throw new Error("Replacement approval required"); };
  await assert.rejects(f.handlers.onInstallDailyTemplate("graph-a", { replaceExisting: false }), /Replacement approval required/);
  assert.equal(f.renders.at(-1).error, "Replacement approval required");
  assert.equal(f.destroyed, 0);
  await f.unload();
});

test("late daily template installation cannot render into a different setup generation", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  let resolve;
  f.runtime.installDailyTemplate = () => new Promise((done) => { resolve = done; });
  const pending = f.handlers.onInstallDailyTemplate("graph-a", { replaceExisting: true });
  for (const hook of f.hooks) hook();
  f.state.graphKey = "graph-b";
  await f.commands.get("journal-routines-setup")();
  const renders = f.renders.length;
  resolve({ graphKey: "graph-a" });
  await pending;
  assert.equal(f.renders.length, renders);
  assert.equal(f.renders.at(-1).graphKey, "graph-b");
  await f.unload();
});

test("apply-to-today forwards the graph key and closes setup only after success", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  f.runtime.applyDailyTemplateToday = async (key) => {
    f.calls.push(["daily-today", key]); throw new Error("Today’s journal is populated");
  };
  await assert.rejects(f.handlers.onApplyDailyTemplateToday("graph-a"), /populated/);
  assert.deepEqual(f.calls.at(-1), ["daily-today", "graph-a"]);
  assert.equal(f.destroyed, 0);
  assert.equal(f.calls.includes("hide"), false);
  f.runtime.applyDailyTemplateToday = async (key) => { f.calls.push(["daily-today", key]); };
  await f.handlers.onApplyDailyTemplateToday("graph-a");
  assert.deepEqual(f.calls.slice(-2), [["daily-today", "graph-a"], "hide"]);
  assert.equal(f.destroyed, 1);
  assert.equal(f.calls.some((call) => Array.isArray(call) && ["daily-template", "configure", "enable"].includes(call[0])), false);
  assert.equal(f.commands.size, 6);
  await f.unload();
});

for (const failure of [false, true]) {
  test(`late apply-to-today ${failure ? "failure" : "success"} cannot close or replace another graph's setup`, async () => {
    const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
    let resolve, reject;
    f.runtime.applyDailyTemplateToday = (key) => {
      f.calls.push(["daily-today", key]);
      return new Promise((done, failed) => { resolve = done; reject = failed; });
    };
    const pending = f.handlers.onApplyDailyTemplateToday("graph-a");
    for (const hook of f.hooks) hook();
    f.state.graphKey = "graph-b";
    await f.commands.get("journal-routines-setup")();
    const hides = f.calls.filter((call) => call === "hide").length, renders = f.renders.length;
    if (failure) { reject(new Error("Stale graph")); await assert.rejects(pending, /Stale graph/); }
    else { resolve(); await pending; }
    assert.equal(f.calls.filter((call) => call === "hide").length, hides);
    assert.equal(f.destroyed, 1, "only graph A setup was closed");
    assert.equal(f.renders.length, renders);
    assert.equal(f.renders.at(-1).graphKey, "graph-b");
    await f.unload();
  });
}

test("navigation closes UI only on success; errors remain visible", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  await f.handlers.onShowHistory();
  assert.deepEqual(f.calls.slice(-2), ["history", "hide"]);
  await f.commands.get("journal-routines-setup")();
  f.runtime.configure = async () => { throw new Error("Invalid settings"); };
  await assert.rejects(f.handlers.onSave({}, "graph-a", {}), /Invalid settings/);
  assert.equal(f.renders.at(-1).error, "Invalid settings");
  await f.unload();
});

test("unload is idempotent and commands are inert afterwards", async () => {
  const f = fixture(), plugin = await f.register();
  await f.unload(); await plugin.destroy();
  assert.equal(f.calls.filter((call) => call === "destroy").length, 1);
  const length = f.calls.length;
  await f.commands.get("journal-routines-show")();
  await f.model.openJournalRoutinesSetup();
  assert.equal(f.calls.length, length);
});

test("startup failure tears down registered graph hook and runtime", async () => {
  const f = fixture();
  f.runtime.start = async () => { throw new Error("startup failure"); };
  await assert.rejects(f.register(), /startup failure/);
  assert.equal(f.hooks.size, 0);
  assert.deepEqual(f.calls, ["destroy"]);
});
