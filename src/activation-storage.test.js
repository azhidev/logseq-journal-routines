import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createActivationStorage, graphIdentity } from "./activation-storage.js";


// Deliberately separate request success from transaction completion/abort. This
// fixture checks event handling; the Chromium test below checks actual IndexedDB.
function fixture({ available = true, durability = "strict", autoOpen = true } = {}) {
  const records = new Map(), transactions = [], opens = [];
  let closes = 0, schema = false;
  const db = {
    objectStoreNames: { contains: (name) => schema && name === "records" },
    createObjectStore(name) { assert.equal(name, "records"); schema = true; },
    close() { closes += 1; },
    transaction(name, mode, options) {
      assert.equal(name, "records");
      if (mode === "readwrite") assert.deepEqual(options, { durability: "strict" });
      let operation, request, done = false;
      const tx = {
        durability,
        objectStore(store) {
          assert.equal(store, "records");
          return {
            get(key) { operation = { key, write: false }; request = {}; return request; },
            put(value, key) { operation = { key, value: structuredClone(value), write: true }; request = {}; return request; },
          };
        },
        succeed() {
          request.result = operation.write ? operation.key : structuredClone(records.get(operation.key));
          request.onsuccess?.();
        },
        complete() {
          assert.equal(done, false); done = true;
          if (operation.write) records.set(operation.key, operation.value);
          tx.oncomplete?.();
        },
        abort() {
          assert.equal(done, false); done = true;
          queueMicrotask(() => tx.onabort?.());
        },
        error() { tx.onerror?.(); tx.abort(); },
      };
      transactions.push(tx);
      return tx;
    },
  };
  const indexedDB = available ? {
    open(name, version) {
      assert.equal(name, "logseq-plugin-journal-routines-activation"); assert.equal(version, 1);
      const request = { result: db, transaction: { abort() {} } };
      opens.push(request);
      if (autoOpen) queueMicrotask(() => {
        request.onupgradeneeded?.(); request.onsuccess?.();
      });
      return request;
    },
  } : null;
  return { indexedDB, db, transactions, opens, records, closes: () => closes };
}
const hash = (path) => createHash("sha256").update(JSON.stringify(path)).digest("hex");

test("graph identity hashes the exact JSON-encoded path, not the display name", async () => {
  for (const path of ["/private/graph", " /private/graph ", "C:\\Private\\Graph", "/یادداشت/گراف", '/quotes/"graph"']) {
    const sdk = { App: { getCurrentGraph: async () => ({ path, name: "Display graph" }) } };
    const result = await graphIdentity(sdk);
    assert.deepEqual(result, { key: hash(path), name: "Display graph" });
    assert.notEqual(result.key, createHash("sha256").update(path).digest("hex"));
    sdk.App.getCurrentGraph = async () => ({ path, name: "Renamed graph" });
    assert.equal((await graphIdentity(sdk)).key, result.key);
  }
  assert.notEqual(hash("/a/Same"), hash("/b/Same"));
  assert.notEqual(hash("/Graph"), hash("/graph"));
  assert.notEqual(hash("/graph/"), hash("/graph"));
});

test("invalid/no file graph and unavailable crypto fail closed without leaking SDK errors or paths", async (t) => {
  for (const graph of [null, {}, [], { name: "Graph" }, { path: "  ", name: "Graph" }, { path: "/PRIVATE", name: "" }]) {
    await assert.rejects(graphIdentity({ App: { getCurrentGraph: async () => graph } }), { code: "unsupported-graph" });
  }
  await assert.rejects(graphIdentity({ App: { getCurrentGraph() { throw new Error("PRIVATE/path"); } } }), { message: "graph-read-failed" });
  t.mock.method(globalThis.crypto.subtle, "digest", async () => { throw new Error("PRIVATE"); });
  await assert.rejects(graphIdentity({ App: { getCurrentGraph: async () => ({ path: "/PRIVATE", name: "Graph" }) } }), { message: "identity-unavailable" });
});

test("lazy namespaced storage returns null missing only after transaction completion", async () => {
  const f = fixture(), store = createActivationStorage({ indexedDB: f.indexedDB });
  assert.equal(f.opens.length, 0);
  let settled = false;
  const read = store.get("activation:hash").then((value) => { settled = true; return value; });
  await nextTurn();
  const tx = f.transactions[0]; tx.succeed();
  await nextTurn(); assert.equal(settled, false);
  tx.complete(); assert.equal(await read, null);
  store.close(); store.close(); assert.equal(f.closes(), 1);
  await assert.rejects(store.get("activation:hash"), { code: "storage-closed" });
});

test("atomic metadata replacement captures inputs, waits for strict commit and survives reopening", async () => {
  const f = fixture(), store = createActivationStorage({ indexedDB: f.indexedDB });
  const key = `journal-routines:recovery:v1:${hash("/not-stored")}`;
  const record = { version: 1, graphKey: hash("/not-stored"), next: 2, pending: { kind: "insert", uuid: "12345678-1234-1234-1234-123456789012" } };
  const expected = structuredClone(record);
  let settled = false;
  const saving = store.set(key, record).then(() => { settled = true; });
  record.next = 99; record.pending.kind = "modified";
  await nextTurn(); f.transactions[0].succeed(); await nextTurn();
  assert.equal(settled, false); assert.equal(f.records.has(key), false);
  f.transactions[0].complete(); await saving; store.close();
  assert.deepEqual(f.records.get(key), expected);
  assert.equal(JSON.stringify([...f.records]).includes("/not-stored"), false);
  const reopened = createActivationStorage({ indexedDB: f.indexedDB });
  const reading = reopened.get(key); await nextTurn();
  f.transactions[1].succeed(); f.transactions[1].complete();
  const loaded = await reading; assert.deepEqual(loaded, expected);
  loaded.next = 88; assert.deepEqual(f.records.get(key), expected);
  reopened.close();
});

test("request success followed by abort/error rejects and preserves the previous checkpoint", async () => {
  for (const action of ["abort", "error"]) {
    const f = fixture(); f.records.set("checkpoint", { next: 1 });
    const store = createActivationStorage({ indexedDB: f.indexedDB });
    const saving = store.set("checkpoint", { next: 2 });
    const rejected = assert.rejects(saving, { code: "storage-transaction-failed" });
    await nextTurn(); f.transactions[0].succeed(); f.transactions[0][action]();
    await rejected; assert.deepEqual(f.records.get("checkpoint"), { next: 1 }); store.close();
  }
});

test("no IndexedDB, denied opening, blocked upgrade, and relaxed durability never fall back", async () => {
  await assert.rejects(createActivationStorage({ indexedDB: null }).get("key"), { code: "storage-unavailable" });
  await assert.rejects(createActivationStorage({ indexedDB: { open() { throw new Error("PRIVATE"); } } }).get("key"), { message: "storage-unavailable" });
  for (const event of ["onblocked", "onerror"]) {
    const f = fixture({ autoOpen: false });
    const store = createActivationStorage({ indexedDB: f.indexedDB });
    const reading = store.get("key");
    const rejected = assert.rejects(reading, { code: event === "onblocked" ? "storage-blocked" : "storage-open-failed" });
    f.opens[0][event](); await rejected;
    f.opens[0].onsuccess(); assert.equal(f.closes(), 1);
    store.close();
  }
  const f = fixture({ durability: "relaxed" }), store = createActivationStorage({ indexedDB: f.indexedDB });
  await assert.rejects(store.set("key", true), { code: "storage-durability-unavailable" });
  assert.equal(f.records.size, 0); store.close();
});

test("close aborts active writes, rejects pending open, closes late connection, and versionchange invalidates", async () => {
  const f = fixture(), store = createActivationStorage({ indexedDB: f.indexedDB });
  const saving = store.set("key", true), rejected = assert.rejects(saving, { code: "storage-closed" });
  await nextTurn(); store.close(); await rejected; assert.equal(f.records.size, 0);
  const pending = fixture({ autoOpen: false }), other = createActivationStorage({ indexedDB: pending.indexedDB });
  const read = other.get("key"), stopped = assert.rejects(read, { code: "storage-closed" });
  other.close(); await stopped; pending.opens[0].onsuccess(); assert.equal(pending.closes(), 1);
  const fresh = fixture(), last = createActivationStorage({ indexedDB: fresh.indexedDB });
  const reading = last.get("key"); await nextTurn(); fresh.transactions[0].succeed(); fresh.transactions[0].complete(); await reading;
  fresh.db.onversionchange(); await assert.rejects(last.set("key", true), { code: "storage-closed" });
});

test("invalid keys/uncloneable data reject without opening the database", async () => {
  const f = fixture(), store = createActivationStorage({ indexedDB: f.indexedDB });
  await assert.rejects(store.get(" "), { code: "storage-invalid-key" });
  for (const value of [undefined, { fn() {} }]) await assert.rejects(store.set("key", value), { code: "storage-invalid-value" });
  assert.equal(f.opens.length, 0); store.close();
});

const chrome = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => path && existsSync(path));
// A real-time CDP pipe avoids virtual-time/dump-dom racing disk-backed IDB work.
async function inBrowser(profile, url, expression) {
  const child = spawn(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    `--user-data-dir=${profile}`, "--remote-debugging-pipe", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pending = new Map();
  let sequence = 0, buffer = "";
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.on("error", (error) => { for (const handler of pending.values()) handler.reject(error); });
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("data", (data) => {
    buffer += data.toString();
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const handler = pending.get(message.id);
      if (handler) { pending.delete(message.id); message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result); }
    }
  });
  function call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  try {
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    await call("Page.navigate", { url }, sessionId);
    // Execution context readiness, rather than navigation acknowledgement alone.
    let ready = false;
    for (let i = 0; i < 100 && !ready; i += 1) {
      const response = await call("Runtime.evaluate", { expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, returnByValue: true }, sessionId);
      ready = response.result?.value === true;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready, "Browser page did not finish loading");
    const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
    await call("Browser.close");
    await exited;
    return response.result.value;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    for (const handler of pending.values()) handler.reject(new Error("Browser closed"));
    await exited;
  }
}
test("real Chromium IndexedDB persists metadata across browser processes", { skip: chrome ? false : "Set CHROME_BIN to run actual browser persistence validation", timeout: 60000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "journal-routines-idb-"));
  try {
    const source = readFileSync(new URL("./activation-storage.js", import.meta.url), "utf8").replaceAll("export ", "");
    const html = join(temp, "storage.html");
    const key = `activation:${hash("/fixture-not-persisted")}`;
    const record = { version: 1, enabled: true, graphKey: hash("/fixture-not-persisted"), next: 3, pending: null };
    const script = `${source}\n(async () => {
      const store = createActivationStorage();
      try {
        const key = ${JSON.stringify(key)}, expected = ${JSON.stringify(record)};
        if (location.search === '?write') {
          if (await store.get(key) !== null) throw new Error('not empty');
          await store.set(key, expected);
          await store.set('nullable', null);
        }
        if (JSON.stringify(await store.get(key)) !== JSON.stringify(expected)) throw new Error('checkpoint not durable');
        if (await store.get('missing') !== null || await store.get('nullable') !== null) throw new Error('missing/null');
        store.close();
        const reopened = createActivationStorage();
        if (JSON.stringify(await reopened.get(key)) !== JSON.stringify(expected)) throw new Error('reopen failed');
        reopened.close();
        return 'PASS';
      } catch (error) { return 'FAIL: ' + error.message; }
      finally { store.close(); }
    })();`;
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>IndexedDB fixture</title>');
    for (const phase of ["write", "read"]) {
      const result = await inBrowser(join(temp, "profile"), `${pathToFileURL(html).href}?${phase}`, script);
      assert.equal(result, "PASS", `Chromium phase ${phase}`);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
