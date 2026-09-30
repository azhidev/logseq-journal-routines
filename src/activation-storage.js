const DATABASE = "logseq-plugin-journal-routines-activation";
const STORE = "records";
const TIMEOUT_MS = 3000;
const failure = (code) => Object.assign(new Error(code), { code });

/**
 * Private, origin-local plugin storage. Callers supply metadata-only keys/records:
 * hashes, UUIDs, flags and recovery cursors, never graph paths or note snapshots.
 * This generic adapter does not validate caller-specific recovery schemas.
 * Each set is an atomic replacement, acknowledged only on strict-durability
 * transaction completion. No settings/localStorage/in-memory fallback exists.
 * Browser eviction/profile deletion and cross-window writer coordination remain
 * caller concerns; separate calls are NOT a multi-record transaction or CAS.
 */
export function createActivationStorage({ indexedDB = globalThis.indexedDB } = {}) {
  let closed = false, connection = null, opening = null, cancelOpen = null;
  const active = new Set();

  function database() {
    if (closed) return Promise.reject(failure("storage-closed"));
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request, settled = false;
      const finish = (error, db) => {
        if (settled) { db?.close(); return; }
        settled = true;
        clearTimeout(timer);
        cancelOpen = null;
        if (error) reject(failure(error));
        else { connection = db; resolve(db); }
      };
      const timer = setTimeout(() => finish("storage-open-timeout"), TIMEOUT_MS);
      cancelOpen = () => finish("storage-closed");
      try {
        if (typeof indexedDB?.open !== "function") { finish("storage-unavailable"); return; }
        request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          if (settled || closed) { request.transaction.abort(); return; }
          try {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
          } catch { request.transaction.abort(); finish("storage-schema-failed"); }
        };
        request.onblocked = () => finish("storage-blocked");
        request.onerror = () => finish("storage-open-failed");
        request.onsuccess = () => {
          const db = request.result;
          if (settled || closed) { db.close(); return; }
          if (!db.objectStoreNames.contains(STORE)) { db.close(); finish("storage-schema-failed"); return; }
          db.onversionchange = () => close();
          db.onclose = () => close();
          finish(null, db);
        };
      } catch { finish("storage-unavailable"); }
    });
    return opening;
  }

  async function transact(key, value, write) {
    if (typeof key !== "string" || !key.trim()) throw failure("storage-invalid-key");
    // Capture at invocation, not after database opening or another asynchronous task.
    if (write) {
      if (value === undefined) throw failure("storage-invalid-value");
      try { value = structuredClone(value); } catch { throw failure("storage-invalid-value"); }
    }
    const db = await database();
    if (closed) throw failure("storage-closed");
    return new Promise((resolve, reject) => {
      let tx, result = null, reason = "storage-transaction-failed";
      try {
        tx = write ? db.transaction(STORE, "readwrite", { durability: "strict" }) : db.transaction(STORE, "readonly");
        active.add(tx);
        tx.oncomplete = () => { active.delete(tx); resolve(write ? undefined : result); };
        tx.onabort = () => { active.delete(tx); reject(failure(closed ? "storage-closed" : reason)); };
        // Do not preventDefault: request errors must abort, not commit partial work.
        tx.onerror = () => { reason = "storage-transaction-failed"; };
        if (write && tx.durability !== "strict") {
          reason = "storage-durability-unavailable";
          tx.abort();
          return;
        }
        const store = tx.objectStore(STORE);
        const request = write ? store.put(value, key) : store.get(key);
        request.onsuccess = () => { if (!write) result = request.result === undefined ? null : request.result; };
      } catch {
        if (tx) {
          try { tx.abort(); return; } catch { active.delete(tx); }
        }
        reject(failure("storage-transaction-failed"));
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    cancelOpen?.();
    for (const tx of active) { try { tx.abort(); } catch { /* Already completed. */ } }
    connection?.close();
    connection = null;
  }
  return { get: (key) => transact(key, undefined, false), set: (key, value) => transact(key, value, true), close };
}

/**
 * SHA-256 over UTF-8 JSON.stringify of the EXACT graph path (including JSON
 * quotes/escapes). This is local path identity, not an immutable graph ID. Do not
 * trim, normalize separators/case/Unicode, or hash the display name instead.
 * Raw path is transient and never returned, persisted or included in errors.
 * 0.10.15 api.cljs get_current_graph returns {path,name,url} for file graphs.
 */
export async function graphIdentity(sdk) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let graph;
        try { graph = await sdk.App.getCurrentGraph(); } catch { throw failure("graph-read-failed"); }
        if (!graph || typeof graph !== "object" || Array.isArray(graph) ||
            typeof graph.path !== "string" || !graph.path.trim() ||
            typeof graph.name !== "string" || !graph.name.trim()) throw failure("unsupported-graph");
        const { path, name } = graph;
        try {
          const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(path)));
          if (!(hash instanceof ArrayBuffer) || hash.byteLength !== 32) throw failure("identity-unavailable");
          return { key: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""), name };
        } catch { throw failure("identity-unavailable"); }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure("graph-read-timeout")), TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}
