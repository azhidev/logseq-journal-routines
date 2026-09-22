import assert from "node:assert/strict";
import test from "node:test";
import { createJournalInspector } from "./journal-inspector.js";

function result(status = "planned", reason = null) {
  return { version: 1, status, reason, snapshot: { graphId: "PRIVATE path", pages: ["PRIVATE notes"] },
    plan: { nextJournal: { content: "PRIVATE body" }, owners: { uuid: "PRIVATE UUID" } },
    summary: { pagesScanned: 5, journalsScanned: 2, blocksScanned: 9,
      changes: { insert: 8, update: 1, move: 2, remove: 0 }, owners: { weekly: "existing", monthly: "new" } } };
}
function fixture(t, initial = result()) {
  let command;
  const messages = [];
  const state = { result: initial, calls: 0, disposed: 0 };
  const adapter = { inspect: async () => { state.calls += 1; return state.result; }, destroy: () => { state.disposed += 1; } };
  const inspector = createJournalInspector({ sdk: {
    App: { registerCommandPalette(options, action) { assert.equal(command, undefined); command = { options, action }; } },
    UI: { async showMsg(...args) { messages.push(args); } },
  }, adapter });
  t.after(() => { inspector.destroy(); assert.ok(!JSON.stringify(messages).includes("PRIVATE")); });
  return { inspector, adapter, state, messages, command: () => command };
}

test("registers once with no startup scan; manual command only publishes safe summary", async (t) => {
  const h = fixture(t);
  h.inspector.start(); h.inspector.start();
  assert.equal(h.state.calls, 0);
  assert.deepEqual(h.command().options, { key: "journal-routines-inspect-engine", label: "Journal & Routines: Inspect today's journal engine (read-only)" });
  assert.equal(await h.command().action(), undefined);
  assert.equal(h.state.calls, 1);
  assert.equal(h.messages[0][1], "success");
  assert.match(h.messages[0][0], /5 pages, 2 journals, 9 blocks/);
  assert.match(h.messages[0][0], /weekly existing, monthly new/);
  assert.match(h.messages[0][0], /no writes were performed/);
});

for (const reason of ["superseded", "disposed", "graph-changed", "graph-edited", "cancelled"]) {
  test(`stale inspection produces no toast: ${reason}`, async (t) => {
    const h = fixture(t, result("blocked", reason));
    h.inspector.start();
    await h.command().action();
    assert.deepEqual(h.messages, []);
  });
}

for (const [status, reason] of [["blocked", "scan-limit"], ["blocked", "read-timeout"], ["blocked", "non-journal-period-owner"],
  ["waiting", "journal-not-created"], ["skipped", "historical-journal"], ["blocked", "PRIVATE arbitrary error"]]) {
  test(`non-success feedback remains sanitized: ${status}/${reason}`, async (t) => {
    const h = fixture(t, result(status, reason));
    h.inspector.start();
    await h.command().action();
    assert.equal(h.messages[0][1], "warning");
    assert.match(h.messages[0][0], /no writes were performed/);
  });
}

test("malformed summaries and thrown host errors cannot leak source values", async (t) => {
  const h = fixture(t);
  h.inspector.start();
  for (const invalid of [null, { ...result(), status: "PRIVATE status" }, { ...result(), summary: { pagesScanned: "PRIVATE" } }]) {
    h.state.result = invalid;
    await h.command().action();
  }
  h.adapter.inspect = async () => { throw new Error("PRIVATE HOST ERROR"); };
  await h.command().action();
  assert.equal(h.messages.length, 4);
  assert.ok(h.messages.every(([, type]) => type === "warning"));
});

test("unload and supersession suppress pending output; retained command stays inert", async (t) => {
  const h = fixture(t);
  h.inspector.start();
  let release;
  h.adapter.inspect = () => new Promise((resolve) => { release = resolve; });
  const old = h.command().action();
  const resolveOld = release;
  const pending = h.command().action();
  resolveOld(result());
  await old;
  assert.deepEqual(h.messages, []);
  h.inspector.destroy(); h.inspector.destroy();
  release(result());
  await pending;
  await h.command().action();
  assert.equal(h.state.disposed, 1);
  assert.deepEqual(h.messages, []);
});
