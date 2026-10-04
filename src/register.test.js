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
    async skipOnboarding(key) { calls.push(["skip", key]); state.onboarding = "skipped"; return { ...state }; },
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

test("first run automatically welcomes without enabling; skip persists and setup reopens", async () => {
  const f = fixture(); f.state.onboarding = "pending";
  const plugin = await f.register();
  assert.equal(f.calls.includes("show"), true);
  assert.equal(f.renders.at(-1).onboarding, "pending");
  assert.equal(f.state.enabled, false);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === "enable"), false);
  await f.handlers.onSkip("graph-a");
  assert.equal(f.state.onboarding, "skipped");
  assert.deepEqual(f.calls.slice(-2), [["skip", "graph-a"], "hide"]);
  await plugin.open();
  assert.equal(f.renders.at(-1).onboarding, "skipped");
  assert.equal(f.calls.at(-1), "show");
  await plugin.destroy();
});

for (const onboarding of ["skipped", "completed"]) {
  test(`startup does not reopen ${onboarding} onboarding`, async () => {
    const f = fixture(); f.state.onboarding = onboarding;
    const plugin = await f.register();
    assert.deepEqual(f.calls, ["start"]);
    await plugin.destroy();
  });
}

for (const initialization of ["pending", "verified"]) {
  test(`${initialization} initialization suppresses a fresh welcome even if preference completion was not saved`, async () => {
    const f = fixture(); Object.assign(f.state, { onboarding: "pending", initialization, enabled: false });
    const plugin = await f.register();
    assert.equal(f.calls.includes("show"), false);
    await plugin.open();
    assert.equal(f.renders.at(-1).initialization, initialization);
    await plugin.destroy();
  });
}

test("enabled graph with an interrupted initialization is not presented as a fresh first run", async () => {
  const f = fixture(); Object.assign(f.state, { onboarding: "pending", enabled: true, error: "Needs inspection" });
  const plugin = await f.register();
  assert.equal(f.calls.includes("show"), false);
  await plugin.destroy();
});

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

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

test("standalone Enable offers completion and an explicit native-sidebar handoff", async () => {
  const f = fixture(); f.state.onboarding = "pending";
  await f.register();
  await f.handlers.onEnable({}, "graph-a", {});
  assert.equal(f.renders.at(-1).enabled, true);
  assert.match(f.renders.at(-1).setupMessage, /routines are ready.*sidebar/);
  assert.equal(f.destroyed, 0, "completion stays visible until explicit handoff");
  assert.equal(f.calls.some((call) => Array.isArray(call) && ["daily-template", "daily-today"].includes(call[0])), false);
  await f.handlers.onShowCurrent();
  assert.deepEqual(f.calls.slice(-2), ["current", "hide"]);
  assert.equal(f.destroyed, 1);
  await f.unload();
});

for (const failure of [false, true]) {
  for (const [label, method, invoke, cancelled] of [
    ["refresh", "refreshStatus", (f) => f.handlers.onRefresh(), false],
    ["daily installation", "installDailyTemplate", (f) => f.handlers.onInstallDailyTemplate("graph-a", {}), false],
    ["Save", "configure", (f) => f.handlers.onSave({}, "graph-a", {}), true],
    ["Enable", "enable", (f) => f.handlers.onEnable({}, "graph-a", {}), true],
    ["quick setup", "installDailyTemplate", (f) => f.handlers.onQuickSetup({}, "graph-a", {}, { dailyTemplate: true }), true],
  ]) {
    test(`late ${label} ${failure ? "failure" : "success"} after Disable preserves the disabled render`, async () => {
      const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
      const outcome = deferred(), started = deferred();
      f.runtime[method] = () => { started.resolve(); return outcome.promise; };
      const pending = invoke(f);
      await started.promise;
      await f.handlers.onDisable("graph-a");
      const renders = f.renders.length, disabled = f.renders.at(-1);
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.setupMessage, undefined);
      if (failure) {
        outcome.reject(new Error("Late action failed"));
        await assert.rejects(pending, /Late action failed|cancelled/);
      } else {
        outcome.resolve({ ...f.state, enabled: true });
        if (cancelled) await assert.rejects(pending, /cancelled/);
        else await pending;
      }
      assert.equal(f.renders.length, renders);
      assert.equal(f.renders.at(-1), disabled);
      assert.equal(f.calls.includes("hide"), false);
      assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === "daily-today"), false);
      await f.unload();
    });
  }
}

for (const failure of [false, true]) {
  for (const [method, invoke] of [
    ["showCurrent", (f) => f.handlers.onShowCurrent()],
    ["showHistory", (f) => f.handlers.onShowHistory()],
    ["openDefinition", (f) => f.handlers.onOpenDefinition("weekly")],
    ["applyDailyTemplateToday", (f) => f.handlers.onApplyDailyTemplateToday("graph-a")],
    ["skipOnboarding", (f) => f.handlers.onSkip("graph-a")],
    ["addExamples", (f) => f.handlers.onAddExamples("graph-a")],
  ]) {
    test(`late ${method} ${failure ? "failure" : "success"} after Disable cannot navigate away`, async () => {
      const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
      const outcome = deferred();
      f.runtime[method] = () => outcome.promise;
      const pending = invoke(f);
      await f.handlers.onDisable("graph-a");
      const renders = f.renders.length, disabled = f.renders.at(-1);
      if (failure) {
        outcome.reject(new Error("Late navigation failed"));
        await assert.rejects(pending, /Late navigation failed/);
      } else {
        outcome.resolve();
        if (method === "addExamples") await assert.rejects(pending, /cancelled/);
        else await pending;
      }
      assert.equal(f.renders.length, renders);
      assert.equal(f.renders.at(-1), disabled);
      assert.equal(f.destroyed, 0);
      assert.equal(f.calls.includes("hide"), false);
      assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === "current"), false);
      await f.unload();
    });
  }
}

for (const failure of [false, true]) {
  test(`late command ${failure ? "failure" : "success"} after Disable cannot toast or close setup`, async () => {
    const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
    const outcome = deferred();
    f.runtime.showCurrent = () => outcome.promise;
    const pending = f.commands.get("journal-routines-show")();
    await f.commands.get("journal-routines-disable")();
    const renders = f.renders.length;
    if (failure) outcome.reject(new Error("Late command failed"));
    else outcome.resolve();
    await pending;
    assert.equal(f.renders.length, renders);
    assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === "message"), false);
    assert.equal(f.calls.includes("hide"), false);
    assert.equal(f.destroyed, 0);
    await f.unload();
  });
}

for (const failure of [false, true]) {
  test(`older Disable ${failure ? "failure" : "success"} cannot overwrite a newer disabled result`, async () => {
    const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
    const outcome = deferred(), disable = f.runtime.disable;
    f.runtime.disable = () => outcome.promise;
    const pending = f.handlers.onDisable("graph-a");
    f.runtime.disable = disable;
    await f.handlers.onDisable("graph-a");
    const renders = f.renders.length, disabled = f.renders.at(-1);
    if (failure) {
      outcome.reject(new Error("Older Disable failed"));
      await assert.rejects(pending, /Older Disable failed/);
    } else {
      outcome.resolve({ ...f.state });
      await pending;
    }
    assert.equal(f.renders.length, renders);
    assert.equal(f.renders.at(-1), disabled);
    await f.unload();
  });
}

test("Disable command still reports its own current failure", async () => {
  const f = fixture(); await f.register();
  f.runtime.disable = async () => { throw new Error("Disable failed"); };
  await f.commands.get("journal-routines-disable")();
  assert.deepEqual(f.calls.at(-1), ["message", "Journal & Routines: Disable failed"]);
  await f.unload();
});

test("late setup opening after Disable cannot replace the disabled result", async () => {
  const f = fixture(), plugin = await f.register(); await plugin.open();
  const outcome = deferred();
  f.runtime.refreshStatus = () => outcome.promise;
  const pending = plugin.open();
  await f.handlers.onDisable("graph-a");
  const renders = f.renders.length, shows = f.calls.filter((call) => call === "show").length;
  outcome.resolve({ ...f.state, enabled: true });
  await pending;
  assert.equal(f.renders.length, renders);
  assert.equal(f.renders.at(-1).enabled, false);
  assert.equal(f.calls.filter((call) => call === "show").length, shows);
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
  assert.match(f.renders.at(-1).setupMessage, /routines are ready/);
  f.runtime.installDailyTemplate = async () => {};
  f.runtime.applyDailyTemplateToday = async () => { throw new Error("Native insert outcome uncertain"); };
  await assert.rejects(f.handlers.onQuickSetup({}, "graph-a", {}, { dailyTemplate: true }), /installed.*needs attention.*uncertain/);
  assert.match(f.renders.at(-1).error, /needs attention/);
  assert.match(f.renders.at(-1).setupMessage, /routines are ready/);
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
  assert.deepEqual(f.renders.at(-1), { ...f.runtime.getStatus(), setupMessage:
    "Daily template selected for eligible empty journals. Existing journals and template edits were preserved. To apply it to an empty today, use Apply daily template to today." });
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
  assert.equal(f.renders.at(-1).setupMessage, undefined);
  await f.unload();
});

test("routine-only save reports success without implying daily selections were applied", async () => {
  const f = fixture(); await f.register(); await f.commands.get("journal-routines-setup")();
  await f.handlers.onSave({ autoOpen: false }, "graph-a", {});
  assert.match(f.renders.at(-1).setupMessage, /settings saved.*remain disabled.*daily journal default was left unchanged/);
  assert.equal(f.state.autoOpen, false);
  assert.equal(f.state.enabled, false);
  await f.handlers.onEnable({}, "graph-a", {});
  await f.handlers.onSave({ autoOpen: true }, "graph-a", {});
  assert.match(f.renders.at(-1).setupMessage, /settings saved and applied.*daily journal default was left unchanged/);
  assert.equal(f.calls.some((call) => Array.isArray(call) && ["daily-template", "daily-today"].includes(call[0])), false);
  for (const hook of f.hooks) hook();
  f.state.graphKey = "graph-b";
  await f.commands.get("journal-routines-setup")();
  assert.equal(f.renders.at(-1).setupMessage, undefined);
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
