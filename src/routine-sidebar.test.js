import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { graphIdentity } from "./activation-storage.js";
import { createRoutineSidebar } from "./routine-sidebar.js";

const uuid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
const owners = () => ({ weekly: { uuid: uuid(1), page: "prior native journal", key: "weekly-20250315" },
  monthly: { uuid: uuid(2), page: "today native journal", key: "monthly-1404-01" } });
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
async function harness(options = {}) {
  const calls = [], unexpected = [];
  const state = { graph: { path: "/PRIVATE/graph", name: "Graph" }, block: null, open: null, graphRead: null };
  function strict(object) {
    return new Proxy(object, { get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      unexpected.push(key); throw new Error(`Forbidden SDK access: ${String(key)}`);
    } });
  }
  const sdk = strict({
    App: strict({ getCurrentGraph: async () => { calls.push(["graph"]); return state.graphRead ? state.graphRead() : state.graph; } }),
    Editor: strict({
      getBlock: async (id, opts) => {
        assert.deepEqual(opts, { includeChildren: false }); calls.push(["block", id]);
        return state.block ? state.block(id) : { uuid: id };
      },
      openInRightSidebar: (id) => { calls.push(["open", id]); return state.open?.(id); },
    }),
  });
  const graphKey = (await graphIdentity(sdk)).key;
  calls.length = 0;
  const sidebar = createRoutineSidebar({ sdk, timeoutMs: 100, ...options });
  return { sdk, sidebar, state, calls, graphKey, unexpected, opened: () => calls.filter(([kind]) => kind === "open").map(([, id]) => id) };
}

test("actual engine owner shape opens weekly and monthly separately, relying on host reuse, never clearing or opening date", async () => {
  const h = await harness();
  for (let i = 0; i < 2; i += 1) {
    const result = await h.sidebar.sync({ owners: { ...owners(), dateHeading: uuid(3) }, graphKey: h.graphKey });
    assert.equal(result.status, "requested");
    assert.deepEqual(result.owners, { weekly: { status: "requested", reason: null }, monthly: { status: "requested", reason: null } });
  }
  assert.deepEqual(h.opened(), [uuid(1), uuid(2), uuid(1), uuid(2)]);
  // No local cache: a manually closed card can be reopened by another sync.
  h.sidebar.reset(); h.sidebar.destroy(); h.sidebar.destroy();
  assert.deepEqual(h.unexpected, []);
  assert.equal(h.opened().length, 4);
});

test("one absent, malformed, missing or failed owner never prevents the other period opening", async () => {
  const cases = [
    { weekly: null, status: "skipped", reason: "no-owner" },
    { weekly: { uuid: "bad", page: "journal", key: "week" }, status: "blocked", reason: "invalid-owner" },
    { block: () => null, status: "blocked", reason: "owner-block-missing" },
    { block: () => ({ uuid: uuid(9) }), status: "blocked", reason: "owner-block-missing" },
    { block: () => { throw new Error("PRIVATE note"); }, status: "blocked", reason: "sidebar-block-read-failed" },
    { open: () => { throw new Error("PRIVATE SDK error"); }, status: "blocked", reason: "sidebar-open-failed" },
  ];
  for (const scenario of cases) {
    const h = await harness(), plan = owners();
    if (Object.hasOwn(scenario, "weekly")) plan.weekly = scenario.weekly;
    if (scenario.block) h.state.block = (id) => id === uuid(1) ? scenario.block() : { uuid: id };
    if (scenario.open) h.state.open = (id) => id === uuid(1) ? scenario.open() : undefined;
    const result = await h.sidebar.sync({ owners: plan, graphKey: h.graphKey });
    assert.deepEqual(result.owners.weekly, { status: scenario.status, reason: scenario.reason });
    assert.equal(result.owners.monthly.status, "requested");
    assert.equal(result.status, scenario.status === "blocked" ? "partial" : "requested");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.deepEqual(h.unexpected, []); h.sidebar.destroy();
  }
  const h = await harness();
  const result = await h.sidebar.sync({ owners: { weekly: owners().weekly, monthly: null }, graphKey: h.graphKey });
  assert.equal(result.owners.weekly.status, "requested"); assert.deepEqual(h.opened(), [uuid(1)]);
});

test("toggle belongs to caller; disabled and ownerless syncs have no side effects", async () => {
  const h = await harness();
  assert.equal((await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey, enabled: false })).reason, "disabled");
  assert.equal(h.calls.length, 0);
  assert.equal((await h.sidebar.sync({ owners: {}, graphKey: h.graphKey })).reason, "no-owners");
  assert.equal(h.calls.length, 0);
  assert.equal((await h.sidebar.sync({ owners: owners(), graphKey: "display name" })).reason, "invalid-graph-key");
  assert.equal((await h.sidebar.sync({ owners: [], graphKey: h.graphKey })).reason, "invalid-owners");
  assert.equal(h.calls.length, 0);
});

test("unsupported APIs return precise reasons, not false success", async () => {
  const graphKey = "a".repeat(64);
  for (const [sdk, reason] of [
    [{}, "sidebar-open-api-unavailable"],
    [{ Editor: { openInRightSidebar() {} } }, "sidebar-block-read-api-unavailable"],
    [{ Editor: { openInRightSidebar() {}, getBlock() {} } }, "sidebar-graph-read-api-unavailable"],
  ]) {
    const sidebar = createRoutineSidebar({ sdk });
    const result = await sidebar.sync({ owners: owners(), graphKey });
    assert.equal(result.status, "blocked"); assert.equal(result.reason, reason);
  }
  const h = await harness(); h.state.open = () => false;
  assert.equal((await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey })).reason, "sidebar-open-failed");
});

test("fresh async guard runs directly before EACH open with hashed identity and owner metadata", async () => {
  const contexts = [];
  const h = await harness({ guard: async (context) => { contexts.push(context); h.calls.push(["guard", context.uuid]); return true; } });
  assert.equal((await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey })).status, "requested");
  for (const [index, kind] of ["weekly", "monthly"].entries()) {
    assert.deepEqual(contexts[index], { graphKey: h.graphKey, kind, uuid: uuid(index + 1), phase: "sidebar-open" });
  }
  for (let i = 0; i < h.calls.length; i += 1) if (h.calls[i][0] === "open") assert.deepEqual(h.calls[i - 1], ["guard", h.calls[i][1]]);
  assert.deepEqual(h.unexpected, []);
});

test("guard denies truthy non-true values and errors, independently per owner", async () => {
  for (const denial of [false, undefined, { allowed: true }, "true"]) {
    const h = await harness({ guard: async ({ kind }) => kind === "weekly" ? denial : true });
    const result = await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey });
    assert.equal(result.owners.weekly.reason, "guard-denied"); assert.deepEqual(h.opened(), [uuid(2)]);
  }
  const h = await harness({ guard: async () => { throw new Error("PRIVATE"); } });
  assert.equal((await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey })).reason, "sidebar-guard-failed");
  assert.deepEqual(h.opened(), []);
});

test("graph identity is not the display name, and switching during reads or between opens blocks stale targets", async () => {
  for (const phase of ["before", "block", "open"]) {
    const h = await harness();
    const switchGraph = () => { h.state.graph = { path: "/OTHER/graph", name: "Graph" }; };
    if (phase === "before") switchGraph();
    if (phase === "block") h.state.block = (id) => { switchGraph(); return { uuid: id }; };
    if (phase === "open") h.state.open = switchGraph;
    const result = await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey });
    assert.equal(result.owners.monthly.reason, "graph-changed");
    assert.deepEqual(h.opened(), phase === "open" ? [uuid(1)] : []);
  }
});

test("reset, destroy, disable and superseding sync invalidate outstanding authorization", async () => {
  for (const action of ["reset", "destroy", "disable", "supersede"]) {
    const gate = deferred(), entered = deferred();
    const h = await harness({ guard: async () => { entered.resolve(); return gate.promise; } });
    const pending = h.sidebar.sync({ owners: owners(), graphKey: h.graphKey });
    await entered.promise;
    let next;
    if (action === "disable") next = h.sidebar.sync({ enabled: false });
    else if (action === "supersede") next = h.sidebar.sync({ owners: { monthly: owners().monthly }, graphKey: h.graphKey });
    else h.sidebar[action]();
    gate.resolve(true);
    const result = await pending; await next;
    assert.equal(result.status, "blocked");
    assert.deepEqual(h.opened(), action === "supersede" ? [uuid(2)] : []);
    if (action === "destroy") assert.equal((await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey })).reason, "destroyed");
  }
});

test("bounded reads and guards do not open after a late resolution", async () => {
  for (const phase of ["graph", "block", "guard"]) {
    const gate = deferred();
    const h = await harness({ timeoutMs: 10, ...(phase === "guard" ? { guard: () => gate.promise } : {}) });
    if (phase === "graph") h.state.graphRead = () => gate.promise;
    if (phase === "block") h.state.block = () => gate.promise;
    const result = await h.sidebar.sync({ owners: owners(), graphKey: h.graphKey });
    assert.equal(result.status, "blocked"); assert.match(result.reason, /timeout$/);
    gate.resolve(phase === "guard" ? true : phase === "graph" ? h.state.graph : { uuid: uuid(1) });
    await nextTurn(); assert.deepEqual(h.opened(), []); h.sidebar.destroy();
  }
});

test("timed-out open is reported as uncertain failure, never acknowledged visible/successful", async () => {
  const h = await harness({ timeoutMs: 10 }); h.state.open = () => new Promise(() => {});
  const result = await h.sidebar.sync({ owners: { weekly: owners().weekly }, graphKey: h.graphKey });
  assert.equal(result.status, "blocked"); assert.equal(result.reason, "sidebar-open-failed-timeout");
});

test("owner metadata is captured before asynchronous work and does not retain the caller's projection", async () => {
  const gate = deferred(), entered = deferred(), h = await harness();
  h.state.block = async (id) => { entered.resolve(); await gate.promise; return { uuid: id }; };
  const plan = owners(), pending = h.sidebar.sync({ owners: plan, graphKey: h.graphKey });
  await entered.promise; plan.monthly.uuid = uuid(99); plan.weekly.uuid = uuid(98); gate.resolve();
  assert.equal((await pending).status, "requested"); assert.deepEqual(h.opened(), [uuid(1), uuid(2)]);
});
