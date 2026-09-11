import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { registerProbe } from "./register.js";

// Static plain wire-response fixtures. No Calendar provider import, conversion,
// live clock, or actual Logseq Desktop participates in these registration tests.
const INFO_FIXTURE = {
  id: "persian-calendar", version: 1,
  capabilities: ["describe-date", "describe-today", "from-journal-day"],
};
const DATE_FIXTURE = {
  gregorian: { year: 2025, month: 3, day: 21, iso: "2025-03-21", journalDay: 20250321 },
  persian: { year: 1404, month: 1, day: 1, iso: "1404-01-01", label: "جمعه 1 فروردین 1404", weekOfYear: 1 },
  week: { start: "2025-03-15", end: "2025-03-21", key: "weekly-20250315" },
  month: { start: "2025-03-21", end: "2025-04-20", key: "monthly-1404-01", financeKey: "1404-01" },
};
const TARGET = "persian-calendar.models.";

function setup(t) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const reports = t.mock.method(console, "info", () => {});
  const unexpected = [];
  function readOnlySurface(methods) {
    return new Proxy(methods, {
      get(target, key) {
        if (Object.hasOwn(target, key)) return target[key];
        unexpected.push(String(key));
        throw new Error(`Unexpected SDK access: ${String(key)}`);
      },
    });
  }
  const state = { loaded: true, pendingToday: null };
  const order = [];
  const beforeunload = t.mock.fn(() => { order.push("unload"); });
  const unsubscribe = t.mock.fn();
  const onCurrentGraphChanged = t.mock.fn(() => {
    order.push("graph");
    return unsubscribe;
  });
  const registerCommandPalette = t.mock.fn(() => { order.push("command"); });
  const showMsg = t.mock.fn(async () => {});
  const invokeExternalPlugin = t.mock.fn(async (target, ...args) => {
    order.push("invoke");
    if (!state.loaded) throw new Error("provider not loaded");
    switch (target) {
      case `${TARGET}getApiInfo`:
        assert.deepEqual(args, []);
        return structuredClone(INFO_FIXTURE);
      case `${TARGET}describeDate`:
        assert.deepEqual(args, ["2025-03-21"]);
        return structuredClone(DATE_FIXTURE);
      case `${TARGET}describeToday`:
        assert.deepEqual(args, []);
        return state.pendingToday ?? structuredClone(DATE_FIXTURE);
      case `${TARGET}fromJournalDay`:
        assert.deepEqual(args, [20250321]);
        return "2025-03-21";
      default:
        unexpected.push(target);
        throw new Error(`Unexpected external model: ${target}`);
    }
  });
  const sdk = readOnlySurface({
    beforeunload,
    App: readOnlySurface({ onCurrentGraphChanged, registerCommandPalette, invokeExternalPlugin }),
    UI: readOnlySurface({ showMsg }),
  });
  const unload = () => beforeunload.mock.calls[0]?.arguments[0]();
  t.after(() => {
    unload();
    assert.deepEqual(unexpected, [], "only the read-only SDK/model allowlist may be used");
  });
  return {
    sdk, state, order, reports, beforeunload, unsubscribe, onCurrentGraphChanged,
    registerCommandPalette, showMsg, invokeExternalPlugin, unload,
    command: () => registerCommandPalette.mock.calls[0].arguments[1](),
  };
}

test("registers SDK hooks and a read-only command, probes through the real client, and unloads", async (t) => {
  const h = setup(t);
  const runtime = await registerProbe(h.sdk);
  assert.deepEqual(h.order.slice(0, 4), ["unload", "command", "graph", "invoke"]);
  assert.equal(h.beforeunload.mock.callCount(), 1);
  assert.equal(h.onCurrentGraphChanged.mock.callCount(), 1);
  assert.equal(h.registerCommandPalette.mock.callCount(), 1);
  assert.deepEqual(h.registerCommandPalette.mock.calls[0].arguments[0], {
    key: "journal-routines-check-calendar",
    label: "Journal & Routines: Check Calendar dependency (read-only)",
  });
  assert.deepEqual(h.invokeExternalPlugin.mock.calls.map(({ arguments: args }) => args), [
    [`${TARGET}getApiInfo`],
    [`${TARGET}getApiInfo`],
    [`${TARGET}describeDate`, "2025-03-21"],
    [`${TARGET}getApiInfo`],
    [`${TARGET}describeToday`],
    [`${TARGET}getApiInfo`],
    [`${TARGET}fromJournalDay`, 20250321],
    [`${TARGET}getApiInfo`],
  ]);
  assert.equal(runtime.getStatus().state, "available");
  assert.equal(h.showMsg.mock.callCount(), 0, "startup does not show manual-command feedback");
  h.unload();
  h.unload();
  assert.equal(h.unsubscribe.mock.callCount(), 1);
  assert.deepEqual(runtime.getStatus(), { state: "disposed", checkedAt: null });
  t.mock.timers.tick(60_000);
  await h.command();
  assert.equal(h.invokeExternalPlugin.mock.callCount(), 8);
  assert.equal(h.showMsg.mock.callCount(), 0);
});

test("manual command reports unavailable/available through provider load order and reload", async (t) => {
  const h = setup(t);
  h.state.loaded = false;
  const runtime = await registerProbe(h.sdk);
  assert.equal(runtime.getStatus().state, "unavailable");
  assert.equal(h.showMsg.mock.callCount(), 0);

  for (const loaded of [false, true, false, true]) {
    h.state.loaded = loaded;
    const previousCalls = h.invokeExternalPlugin.mock.callCount();
    const previousReports = h.reports.mock.callCount();
    await h.command();
    assert.ok(h.invokeExternalPlugin.mock.callCount() > previousCalls, "recheck must not cache availability");
    assert.equal(h.reports.mock.callCount(), previousReports + 1, "manual rechecks always report");
    assert.equal(runtime.getStatus().state, loaded ? "available" : "unavailable");
    const [message, type] = h.showMsg.mock.calls.at(-1).arguments;
    assert.equal(type, loaded ? "success" : "warning");
    if (loaded) {
      assert.match(message, /2025-03-21 \/ 1404-01-01/);
      assert.match(message, /Read-only observation; journal writes remain disabled/);
    } else {
      assert.match(message, /Calendar dependency unavailable: .*provider not loaded/);
      assert.match(message, /No graph content was changed/);
      assert.equal(runtime.getStatus().sample, undefined);
    }
  }
  assert.equal(h.showMsg.mock.callCount(), 4);
});

test("unload cancels a pending manual probe and suppresses late transport results and feedback", async (t) => {
  const h = setup(t);
  const runtime = await registerProbe(h.sdk);
  let resolve;
  h.state.pendingToday = new Promise((yes) => { resolve = yes; });
  const pending = h.command();
  assert.deepEqual(runtime.getStatus(), { state: "checking", checkedAt: null });
  await nextTurn();
  assert.deepEqual(h.invokeExternalPlugin.mock.calls.at(-1).arguments, [`${TARGET}describeToday`]);
  h.unload();
  await pending;
  const calls = h.invokeExternalPlugin.mock.callCount();
  resolve(structuredClone(DATE_FIXTURE));
  await nextTurn();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.deepEqual(runtime.getStatus(), { state: "disposed", checkedAt: null });
  assert.equal(h.showMsg.mock.callCount(), 0);
  assert.equal(h.reports.mock.callCount(), 1, "only the completed startup probe is reported");
  assert.equal(h.invokeExternalPlugin.mock.callCount(), calls);
  assert.equal(h.unsubscribe.mock.callCount(), 1);
});

test("registration errors propagate and leave the unload hook safe to call", async (t) => {
  const h = setup(t);
  const failure = new Error("command registration failed");
  h.registerCommandPalette.mock.mockImplementation(() => { throw failure; });
  await assert.rejects(registerProbe(h.sdk), (error) => error === failure);
  assert.equal(h.beforeunload.mock.callCount(), 1);
  h.unload();
  t.mock.timers.tick(60_000);
  assert.equal(h.onCurrentGraphChanged.mock.callCount(), 0);
  assert.equal(h.invokeExternalPlugin.mock.callCount(), 0);
  assert.equal(h.showMsg.mock.callCount(), 0);
});

test("one unload hook owns both setup and probe, installed before either starts", async (t) => {
  const h = setup(t);
  const preview = {
    start: t.mock.fn(() => { h.order.push("setup"); }),
    destroy: t.mock.fn(),
  };
  const runtime = await registerProbe(h.sdk, { setup: preview });
  assert.deepEqual(h.order.slice(0, 5), ["unload", "setup", "command", "graph", "invoke"]);
  assert.equal(h.beforeunload.mock.callCount(), 1);
  assert.equal(preview.start.mock.callCount(), 1);
  assert.equal(runtime.getStatus().state, "available");
  await h.unload();
  assert.equal(preview.destroy.mock.callCount(), 1);
  assert.equal(h.unsubscribe.mock.callCount(), 1);
  assert.equal(runtime.getStatus().state, "disposed");
  const calls = h.invokeExternalPlugin.mock.callCount();
  t.mock.timers.tick(60_000);
  await h.command();
  assert.equal(h.invokeExternalPlugin.mock.callCount(), calls);
  assert.equal(h.showMsg.mock.callCount(), 0);
});

test("setup start errors propagate after cleanup with an already installed unload hook", async (t) => {
  const h = setup(t);
  const failure = new Error("setup mount failed");
  const preview = {
    start: t.mock.fn(() => {
      assert.equal(h.beforeunload.mock.callCount(), 1);
      throw failure;
    }),
    destroy: t.mock.fn(),
  };
  await assert.rejects(registerProbe(h.sdk, { setup: preview }), (error) => error === failure);
  assert.equal(preview.destroy.mock.callCount(), 1);
  assert.equal(h.registerCommandPalette.mock.callCount(), 0);
  assert.equal(h.onCurrentGraphChanged.mock.callCount(), 0);
  await h.unload();
  t.mock.timers.tick(60_000);
  assert.equal(h.invokeExternalPlugin.mock.callCount(), 0);
});

test("probe start errors also destroy the already started setup", async (t) => {
  const h = setup(t);
  const failure = new Error("graph subscription failed");
  h.onCurrentGraphChanged.mock.mockImplementation(() => { throw failure; });
  const preview = { start: t.mock.fn(), destroy: t.mock.fn() };
  await assert.rejects(registerProbe(h.sdk, { setup: preview }), (error) => error === failure);
  assert.equal(preview.start.mock.callCount(), 1);
  assert.equal(preview.destroy.mock.callCount(), 1);
  assert.equal(h.beforeunload.mock.callCount(), 1);
  assert.equal(h.registerCommandPalette.mock.callCount(), 1);
  await h.unload();
  await h.command();
  t.mock.timers.tick(60_000);
  assert.equal(h.invokeExternalPlugin.mock.callCount(), 0);
  assert.equal(h.showMsg.mock.callCount(), 0);
});

test("setup destroy errors cannot prevent probe disposal in the combined unload hook", async (t) => {
  const h = setup(t);
  const failure = new Error("setup teardown failed");
  let fail = true;
  const preview = {
    start: t.mock.fn(),
    destroy: t.mock.fn(() => { if (fail) throw failure; }),
  };
  const runtime = await registerProbe(h.sdk, { setup: preview });
  try {
    await assert.rejects(h.unload(), (error) => error === failure);
    assert.equal(runtime.getStatus().state, "disposed");
    assert.equal(h.unsubscribe.mock.callCount(), 1);
    const calls = h.invokeExternalPlugin.mock.callCount();
    t.mock.timers.tick(60_000);
    await h.command();
    assert.equal(h.invokeExternalPlugin.mock.callCount(), calls);
    assert.equal(h.showMsg.mock.callCount(), 0);
  } finally {
    fail = false;
  }
});
