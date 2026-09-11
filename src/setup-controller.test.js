import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createSetupController } from "./setup-controller.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t) {
  const unexpected = [];
  const strict = (methods) => new Proxy(methods, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      unexpected.push(String(key));
      throw new Error(`Unexpected SDK access: ${String(key)}`);
    },
  });
  const requests = [];
  const frames = [];
  const commands = [];
  const toolbar = [];
  const listeners = new Set();
  const document = {};
  let actions, model;
  const unsubscribe = t.mock.fn();
  const sdk = strict({
    App: strict({
      registerCommandPalette: t.mock.fn((options, action) => commands.push({ options, action })),
      registerUIItem: t.mock.fn((type, options) => toolbar.push({ type, options })),
      onCurrentGraphChanged: t.mock.fn((callback) => {
        listeners.add(callback);
        return () => { unsubscribe(); listeners.delete(callback); };
      }),
    }),
    setMainUIInlineStyle: t.mock.fn(),
    provideModel: t.mock.fn((value) => { model = value; }),
    showMainUI: t.mock.fn(),
    hideMainUI: t.mock.fn(),
  });
  const calendar = { invalidate: t.mock.fn(async () => {}), destroy: t.mock.fn(async () => {}) };
  const view = { render: t.mock.fn((frame) => frames.push(frame)), focus: t.mock.fn(), destroy: t.mock.fn() };
  const mount = t.mock.fn((doc, callbacks) => {
    assert.equal(doc, document);
    actions = callbacks;
    return view;
  });
  // Deliberately ignore cancellation: the controller must suppress late results itself.
  const inspect = t.mock.fn((input) => {
    assert.equal(input.sdk, sdk);
    assert.equal(input.calendar, calendar);
    const pending = { ...deferred(), signal: input.signal };
    requests.push(pending);
    return pending.promise;
  });
  const controller = createSetupController({ sdk, document, calendar, inspect, mount });
  t.after(() => {
    controller.destroy();
    assert.deepEqual(unexpected, [], "only the SDK allowlist may be accessed");
  });
  return {
    controller, sdk, calendar, view, mount, requests, frames, commands, toolbar, listeners, unsubscribe,
    close: () => actions.onClose(), refresh: () => actions.onRefresh(),
    open: () => model.openJournalSetup(),
    graphChanged: () => { for (const callback of listeners) callback(); },
  };
}

const report = (name) => ({ graph: { name } });

test("start auto-opens once and idempotently registers the view, command, model, and toolbar", async (t) => {
  const h = harness(t);
  h.controller.start();
  h.controller.start();
  assert.equal(h.mount.mock.callCount(), 1);
  assert.equal(h.sdk.setMainUIInlineStyle.mock.callCount(), 1);
  assert.deepEqual(h.sdk.setMainUIInlineStyle.mock.calls[0].arguments, [
    { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: 1000 },
  ]);
  assert.equal(h.sdk.provideModel.mock.callCount(), 1);
  assert.deepEqual(h.sdk.showMainUI.mock.calls[0].arguments, [{ autoFocus: true }]);
  assert.equal(h.sdk.showMainUI.mock.callCount(), 1);
  assert.equal(h.view.focus.mock.callCount(), 1);
  assert.equal(h.commands.length, 1);
  assert.deepEqual(h.commands[0].options, {
    key: "journal-routines-setup-preview",
    label: "Journal & Routines: Open setup preview (read-only)",
  });
  assert.equal(h.commands[0].action, h.sdk.provideModel.mock.calls[0].arguments[0].openJournalSetup);
  assert.equal(h.toolbar.length, 1);
  assert.equal(h.toolbar[0].type, "toolbar");
  assert.equal(h.toolbar[0].options.key, "journal-routines-setup");
  assert.match(h.toolbar[0].options.template, /data-on-click="openJournalSetup"/);
  assert.match(h.toolbar[0].options.template, />JR</);
  assert.equal(h.listeners.size, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].signal.aborted, false);
  assert.equal(h.calendar.invalidate.mock.callCount(), 1);
  assert.deepEqual(h.frames, [{ state: "checking" }]);
  const result = report("A");
  h.requests[0].resolve(result);
  await nextTurn();
  assert.deepEqual(h.frames.at(-1), { state: "ready", report: result });
});

test("close aborts pending work, clears content, and reopen always inspects afresh", async (t) => {
  const h = harness(t);
  h.controller.start();
  h.close();
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.calendar.invalidate.mock.callCount(), 2);
  assert.deepEqual(h.frames.at(-1), { state: "idle" });
  assert.deepEqual(h.sdk.hideMainUI.mock.calls[0].arguments, [{ restoreEditingCursor: true }]);
  h.requests[0].resolve(report("closed stale"));
  await nextTurn();
  assert.deepEqual(h.frames.at(-1), { state: "idle" });
  const pending = h.open();
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[0].signal, h.requests[1].signal);
  assert.equal(h.requests[1].signal.aborted, false);
  h.requests[1].resolve(report("fresh"));
  await pending;
  assert.equal(h.frames.at(-1).report.graph.name, "fresh");
  assert.equal(h.view.focus.mock.callCount(), 2);
});

test("Refresh clears a completed report and supersedes pending results", async (t) => {
  const h = harness(t);
  h.controller.start();
  h.requests[0].resolve(report("old"));
  await nextTurn();
  h.refresh();
  assert.deepEqual(h.frames.at(-1), { state: "checking" });
  h.refresh();
  assert.equal(h.requests[1].signal.aborted, true);
  h.requests[2].resolve(report("newest"));
  await nextTurn();
  const count = h.frames.length;
  h.requests[1].resolve(report("late"));
  await nextTurn();
  assert.equal(h.frames.length, count);
  assert.equal(h.frames.at(-1).report.graph.name, "newest");
});

test("visible graph change immediately clears old data and cancels the prior inspection", async (t) => {
  const h = harness(t);
  h.controller.start();
  h.requests[0].resolve(report("A"));
  await nextTurn();
  h.refresh();
  const before = h.frames.length;
  h.graphChanged();
  assert.deepEqual(h.frames.slice(before), [{ state: "idle" }, { state: "checking" }]);
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve(report("B"));
  h.requests[1].resolve(report("A stale"));
  await nextTurn();
  assert.equal(h.frames.at(-1).report.graph.name, "B");
  assert.equal(h.sdk.showMainUI.mock.callCount(), 1, "graph changes do not steal focus");
});

test("hidden graph changes and Refresh do not inspect until command reopen", async (t) => {
  const h = harness(t);
  h.controller.start();
  h.close();
  const invalidations = h.calendar.invalidate.mock.callCount();
  h.graphChanged();
  h.refresh();
  assert.equal(h.calendar.invalidate.mock.callCount(), invalidations + 1);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.frames.at(-1), { state: "idle" });
  assert.equal(h.sdk.showMainUI.mock.callCount(), 1);
  const pending = h.commands[0].action();
  h.requests[1].resolve(report("B"));
  await pending;
  assert.equal(h.frames.at(-1).report.graph.name, "B");
});

test("inspection errors render a recoverable error and a blank message uses the fallback", async (t) => {
  const h = harness(t);
  h.controller.start();
  h.requests[0].reject(new Error("Cannot verify the current graph."));
  await nextTurn();
  assert.deepEqual(h.frames.at(-1), { state: "error", error: "Cannot verify the current graph." });
  h.refresh();
  assert.deepEqual(h.frames.at(-1), { state: "checking" });
  h.requests[1].reject(new Error());
  await nextTurn();
  assert.deepEqual(h.frames.at(-1), { state: "error", error: "Setup inspection failed. Try refreshing." });
  h.refresh();
  h.requests[2].resolve(report("recovered"));
  await nextTurn();
  assert.equal(h.frames.at(-1).report.graph.name, "recovered");
});

test("superseded and closed inspection rejections never replace current UI", async (t) => {
  const h = harness(t);
  h.controller.start();
  const pending = h.open();
  h.requests[1].resolve(report("current"));
  await pending;
  const before = h.frames.length;
  h.requests[0].reject(new Error("stale error"));
  await nextTurn();
  assert.equal(h.frames.length, before);
  h.refresh();
  h.close();
  h.requests[2].reject(new Error("closed error"));
  await nextTurn();
  assert.deepEqual(h.frames.at(-1), { state: "idle" });
});

test("repeated open while visible refreshes without remounting or duplicating hooks", async (t) => {
  const h = harness(t);
  h.controller.start();
  const pending = h.open();
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.mount.mock.callCount(), 1);
  assert.equal(h.listeners.size, 1);
  assert.equal(h.commands.length, 1);
  h.requests[1].resolve(report("latest open"));
  await pending;
  h.requests[0].resolve(report("startup late"));
  await nextTurn();
  assert.equal(h.frames.at(-1).report.graph.name, "latest open");
});

test("destroy cancels and disposes once; late work and retained callbacks are inert", async (t) => {
  const h = harness(t);
  h.controller.start();
  const pending = h.open();
  h.controller.destroy();
  h.controller.destroy();
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.calendar.destroy.mock.callCount(), 1);
  assert.equal(h.unsubscribe.mock.callCount(), 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.view.destroy.mock.callCount(), 1);
  assert.deepEqual(h.sdk.hideMainUI.mock.calls.at(-1).arguments, []);
  const frames = h.frames.length;
  const invalidations = h.calendar.invalidate.mock.callCount();
  h.requests[0].resolve(report("late success"));
  h.requests[1].reject(new Error("late failure"));
  await pending;
  await h.open();
  h.close();
  h.refresh();
  h.graphChanged();
  await nextTurn();
  assert.equal(h.frames.length, frames);
  assert.equal(h.requests.length, 2);
  assert.equal(h.calendar.invalidate.mock.callCount(), invalidations);
  assert.equal(h.sdk.showMainUI.mock.callCount(), 2);
  assert.equal(h.sdk.hideMainUI.mock.callCount(), 1);
  assert.throws(() => h.controller.start(), /disposed/);
});

test("destroy before start is safe and prevents later initialization", (t) => {
  const h = harness(t);
  h.controller.destroy();
  h.controller.destroy();
  assert.equal(h.calendar.destroy.mock.callCount(), 1);
  assert.equal(h.calendar.invalidate.mock.callCount(), 1);
  assert.equal(h.mount.mock.callCount(), 0);
  assert.equal(h.unsubscribe.mock.callCount(), 0);
  assert.equal(h.requests.length, 0);
  assert.throws(() => h.controller.start(), /disposed/);
});
