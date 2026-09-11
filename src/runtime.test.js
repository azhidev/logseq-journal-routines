import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createProbeRuntime, PROBE_DATE, PROBE_JOURNAL_DAY } from "./runtime.js";

// Minimal injected-client fixtures, not Calendar provider code or Desktop data.
const INFO = { id: "persian-calendar", version: 1 };
const DATE = { gregorian: { iso: "2025-03-21" }, persian: { iso: "1404-01-01" } };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setInterval"] });
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
  const unsubscribe = t.mock.fn();
  const onCurrentGraphChanged = t.mock.fn(() => unsubscribe);
  const sdk = readOnlySurface({ App: readOnlySurface({ onCurrentGraphChanged }) });
  const client = Object.fromEntries(Object.entries({
    invalidate: async () => {},
    destroy: async () => {},
    getApiInfo: async () => structuredClone(INFO),
    describeDate: async () => structuredClone(DATE),
    describeToday: async () => structuredClone(DATE),
    fromJournalDay: async () => "2025-03-21",
    ...overrides,
  }).map(([name, implementation]) => [name, t.mock.fn(implementation)]));
  const onReport = t.mock.fn();
  const runtime = createProbeRuntime({ sdk, client, intervalMs: 100, onReport });
  t.after(() => {
    runtime.destroy();
    assert.deepEqual(unexpected, [], "probe must not access graph-writing SDK APIs");
  });
  return {
    runtime, client, onReport, onCurrentGraphChanged, unsubscribe,
    graphChanged: () => onCurrentGraphChanged.mock.calls[0].arguments[0](),
  };
}

test("start is idempotent even while pending, and probes only the injected read API", async (t) => {
  const pending = deferred();
  const { runtime, client, onCurrentGraphChanged, onReport } = setup(t, {
    invalidate: () => pending.promise,
  });
  assert.deepEqual(runtime.getStatus(), { state: "idle", checkedAt: null });
  const first = runtime.start();
  assert.equal(await runtime.start(), null);
  assert.equal(onCurrentGraphChanged.mock.callCount(), 1);
  assert.equal(client.invalidate.mock.callCount(), 1);
  assert.equal(client.getApiInfo.mock.callCount(), 0);
  pending.resolve();
  const result = await first;
  assert.equal(result.state, "available");
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.deepEqual(result.api, INFO);
  assert.deepEqual(result.sample, {
    iso: "2025-03-21", persianIso: "1404-01-01", journalIso: "2025-03-21",
  });
  assert.deepEqual(result.today, { iso: "2025-03-21", persianIso: "1404-01-01" });
  assert.equal(client.getApiInfo.mock.callCount(), 2);
  assert.deepEqual(client.describeDate.mock.calls[0].arguments, [PROBE_DATE]);
  assert.deepEqual(client.describeToday.mock.calls[0].arguments, []);
  assert.deepEqual(client.fromJournalDay.mock.calls[0].arguments, [PROBE_JOURNAL_DAY]);
  assert.equal(await runtime.start(), null);
  assert.equal(client.invalidate.mock.callCount(), 1);

  result.sample.iso = "changed by caller";
  onReport.mock.calls[0].arguments[0].api.version = 99;
  assert.equal(runtime.getStatus().sample.iso, "2025-03-21");
  assert.equal(runtime.getStatus().api.version, 1);
});

test("graph change invalidates and clears success immediately, before invalidation settles", async (t) => {
  const pending = deferred();
  let invalidations = 0;
  const { runtime, client, graphChanged, onReport } = setup(t, {
    invalidate: () => ++invalidations === 2 ? pending.promise : Promise.resolve(),
  });
  await runtime.start();
  graphChanged();
  assert.equal(client.invalidate.mock.callCount(), 2);
  assert.deepEqual(runtime.getStatus(), { state: "checking", checkedAt: null });
  assert.equal(client.getApiInfo.mock.callCount(), 2);
  pending.resolve();
  await nextTurn();
  assert.equal(runtime.getStatus().state, "available");
  assert.equal(client.getApiInfo.mock.callCount(), 4);
  assert.equal(onReport.mock.callCount(), 1, "unchanged background state is not reported twice");
});

test("a newer refresh supersedes a pending one and suppresses its late failure", async (t) => {
  const pending = deferred();
  let calls = 0;
  const { runtime, onReport } = setup(t, {
    describeToday: () => ++calls === 1 ? pending.promise : structuredClone(DATE),
  });
  const first = runtime.refresh({ report: true });
  await nextTurn();
  assert.equal(calls, 1);
  const second = await runtime.refresh({ report: true });
  assert.equal(second.state, "available");
  pending.reject(new Error("old provider unloaded"));
  assert.equal(await first, null);
  assert.deepEqual(runtime.getStatus(), second);
  assert.equal(onReport.mock.callCount(), 1);
});

test("graph change supersedes pending work and suppresses its late success", async (t) => {
  const pending = deferred();
  let calls = 0;
  const { runtime, graphChanged, onReport, client } = setup(t, {
    describeToday: () => {
      if (++calls === 1) return pending.promise;
      throw new Error("new graph provider unavailable");
    },
  });
  const first = runtime.start();
  await nextTurn();
  graphChanged();
  assert.deepEqual(runtime.getStatus(), { state: "checking", checkedAt: null });
  await nextTurn();
  const latest = runtime.getStatus();
  assert.equal(latest.state, "unavailable");
  assert.match(latest.reason, /new graph provider unavailable/);
  assert.equal(client.invalidate.mock.callCount(), 2);
  pending.resolve(structuredClone(DATE));
  assert.equal(await first, null);
  assert.deepEqual(runtime.getStatus(), latest);
  assert.equal(onReport.mock.callCount(), 1);
});

test("destroy during a pending request suppresses late results and cleans up exactly once", async (t) => {
  const pending = deferred();
  const { runtime, client, onReport, unsubscribe, graphChanged } = setup(t, {
    describeToday: () => pending.promise,
  });
  const first = runtime.start();
  await nextTurn();
  assert.equal(client.describeToday.mock.callCount(), 1);
  runtime.destroy();
  runtime.destroy();
  assert.equal(unsubscribe.mock.callCount(), 1);
  assert.equal(client.destroy.mock.callCount(), 1);
  pending.resolve(structuredClone(DATE));
  assert.equal(await first, null);
  assert.deepEqual(runtime.getStatus(), { state: "disposed", checkedAt: null });
  assert.equal(onReport.mock.callCount(), 0);
  graphChanged(); // Even an already queued graph callback must be inert after unload.
  t.mock.timers.tick(500);
  assert.equal(await runtime.refresh({ report: true }), null);
  await assert.rejects(runtime.start(), /disposed/);
  assert.equal(client.invalidate.mock.callCount(), 1);
});

test("timer skips busy work, rechecks after completion, and is removed on destroy", async (t) => {
  const pending = deferred();
  let calls = 0;
  const { runtime, client, unsubscribe } = setup(t, {
    getApiInfo: () => ++calls === 1 ? pending.promise : structuredClone(INFO),
  });
  const clearInterval = t.mock.method(globalThis, "clearInterval");
  const first = runtime.start();
  await nextTurn();
  t.mock.timers.tick(300);
  assert.equal(client.invalidate.mock.callCount(), 1);
  pending.resolve(structuredClone(INFO));
  await first;
  t.mock.timers.tick(99);
  assert.equal(client.invalidate.mock.callCount(), 1);
  t.mock.timers.tick(1);
  assert.deepEqual(runtime.getStatus(), { state: "checking", checkedAt: null });
  await nextTurn();
  assert.equal(client.invalidate.mock.callCount(), 2);
  assert.equal(runtime.getStatus().state, "available");
  runtime.destroy();
  assert.equal(clearInterval.mock.callCount(), 1);
  assert.notEqual(clearInterval.mock.calls[0].arguments[0], undefined);
  assert.equal(unsubscribe.mock.callCount(), 1);
  t.mock.timers.tick(500);
  await nextTurn();
  assert.equal(client.invalidate.mock.callCount(), 2);
});
