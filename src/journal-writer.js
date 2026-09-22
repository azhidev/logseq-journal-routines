import { blockProperty, blockTitle, validateBlocks } from "./journal-model.js";
import { contentWithoutIdentity, normalizeBlock, normalizePage } from "./graph-normalize.js";
import { snapshotSetupEvidence } from "./setup-plan.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (value) => value.toLowerCase();
class WriterError extends Error {}
const fail = (reason) => { throw new WriterError(reason); };
const requireValue = (value, reason = "invalid-plan") => { if (!value) fail(reason); };
const clone = (value) => structuredClone(value);

function forest(blocks) {
  validateBlocks(blocks);
  return blocks.map((block) => ({ uuid: key(block.uuid), content: contentWithoutIdentity(block.content, block.uuid), children: forest(block.children ?? []) }));
}
function indexTree(blocks) {
  const map = new Map();
  function walk(list, parent = null) {
    list.forEach((block, position) => {
      map.set(block.uuid, { block, parent, position, list });
      walk(block.children, block.uuid);
    });
  }
  walk(blocks);
  return map;
}
async function digest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalReference(block) {
  const ref = blockProperty(block, "routine-reference");
  return typeof ref === "string" && UUID.test(ref) &&
    block.content.trim() === `((${ref}))\nroutine-reference:: ${ref}`;
}
function removable(block) {
  return canonicalReference(block) || ["What would make today successful?", "TODO Choose one important task."].includes(block.content.trim()) ||
    /^\{\{embed \(\([0-9a-f-]{36}\)\)\}\}$/i.test(block.content.trim());
}
function withoutLoaded(content) {
  return content.split("\n").filter((line) => !/^\s*routine-loaded::/i.test(line)).join("\n").trimEnd();
}
function capture(input) {
  const { snapshot, plan, graphKey, pageUuid } = snapshotSetupEvidence(input);
  requireValue(typeof graphKey === "string" && graphKey.trim() && typeof pageUuid === "string" && UUID.test(pageUuid));
  requireValue(snapshot?.version === 1 && plan?.version === 1 && plan.status === "planned" &&
    typeof snapshot.graphId === "string" && snapshot.graphId && snapshot.graphId === plan.graphId &&
    snapshot.ownerScanComplete === true && Array.isArray(snapshot.pages));
  const target = snapshot.pages.filter((page) => page.journalDay === snapshot.journalDay);
  requireValue(target.length === 1 && plan.before && plan.nextJournal);
  const before = plan.before, next = plan.nextJournal;
  requireValue(before.name === target[0].name && next.name === before.name &&
    before.journalDay === snapshot.journalDay && next.journalDay === before.journalDay);
  const old = forest(before.blocks), desired = forest(next.blocks);
  requireValue(JSON.stringify(old) === JSON.stringify(forest(target[0].blocks)));
  const all = forest([...snapshot.pages.flatMap((page) => page.blocks),
    ...(snapshot.routines?.weekly ?? []), ...(snapshot.routines?.monthly ?? [])]);
  const existing = indexTree(all), oldIds = indexTree(old);
  requireValue(!existing.has(key(pageUuid)) && !indexTree(desired).has(key(pageUuid)));
  for (const id of indexTree(desired).keys()) requireValue(oldIds.has(id) || !existing.has(id), "uuid-collision");
  const managed = new Set([...Object.values(plan.sections ?? {}), plan.dateHeading]
    .filter((id) => typeof id === "string" && UUID.test(id)).map(key));
  for (const block of old) {
    if (blockTitle(block) === "habits" || blockProperty(block, "habit-section") === "[[Habit Section]]") managed.add(block.uuid);
  }
  const desiredIds = indexTree(desired);
  const routineMutation = ["Weekly tasks", "Monthly tasks"].some((title) => {
    const id = plan.sections?.[title];
    if (typeof id !== "string") return false;
    const previous = oldIds.get(key(id))?.block, after = desiredIds.get(key(id))?.block;
    return JSON.stringify(previous?.children ?? []) !== JSON.stringify(after?.children ?? []) ||
      blockProperty(previous, "routine-loaded") !== blockProperty(after, "routine-loaded");
  });
  return { graphKey, pageUuid: key(pageUuid), journalDay: before.journalDay, name: before.name,
    before: old, desired, managed, routineMutation };
}

// Compile from the two trees, never from engine change summaries or SDK metadata.
async function compile(job, maxOperations) {
  const work = clone(job.before), next = indexTree(job.desired), operations = [];
  let stateHash = await digest(work);
  const initialHash = stateHash;
  async function emit(operation, mutate) {
    requireValue(operations.length < maxOperations, "operation-limit");
    mutate();
    const afterHash = await digest(work);
    operations.push({ ...operation, beforeHash: stateHash, afterHash });
    stateHash = afterHash;
  }
  function canMove(entry) {
    return entry.parent === null ? job.managed.has(entry.block.uuid) : canonicalReference(entry.block);
  }
  async function arrange(wanted, parent = null) {
    for (let position = 0; position < wanted.length; position++) {
      const desired = wanted[position];
      let current = indexTree(work), entry = current.get(desired.uuid);
      const list = parent === null ? work : current.get(parent).block.children;
      const anchor = list.filter((block) => block.uuid !== desired.uuid)[position];
      const previous = wanted[position - 1];
      // A sibling anchor avoids assuming a host-specific child insertion order.
      const target = previous?.uuid ?? anchor?.uuid ?? parent ?? job.pageUuid;
      const sibling = Boolean(previous || anchor);
      const before = !previous && Boolean(anchor);
      if (!entry) {
        requireValue(parent !== null || job.managed.has(desired.uuid), "unsafe-insert");
        const content = blockProperty(desired, "routine-loaded") === null ? desired.content : withoutLoaded(desired.content);
        await emit({ kind: "insert", uuid: desired.uuid, target, content,
          options: { sibling, before, isPageBlock: !sibling && parent === null, focus: false, customUUID: desired.uuid } },
        () => list.splice(position, 0, { uuid: desired.uuid, content, children: [] }));
      } else if (entry.parent !== parent || entry.position !== position) {
        requireValue(canMove(entry) && (parent === null || canonicalReference(entry.block)), "unsafe-move");
        requireValue(target !== job.pageUuid && !indexTree(entry.block.children).has(target), "unsafe-move");
        await emit({ kind: "move", uuid: desired.uuid, target, options: { before, children: !sibling } }, () => {
          entry.list.splice(entry.position, 1);
          list.splice(position, 0, entry.block);
        });
      }
      await arrange(desired.children, desired.uuid);
    }
  }
  await arrange(job.desired);
  // Retained descendants have already been moved out. Never delete a subtree.
  for (const [id] of [...indexTree(work)].reverse()) {
    if (next.has(id)) continue;
    const entry = indexTree(work).get(id);
    requireValue(entry.block.children.length === 0 && removable(entry.block), "unsafe-remove");
    await emit({ kind: "remove", uuid: id }, () => entry.list.splice(entry.position, 1));
  }
  const updates = [];
  for (const [id, desired] of next) {
    const entry = indexTree(work).get(id);
    if (entry.block.content === desired.block.content) continue;
    requireValue((entry.parent === null && job.managed.has(id)) ||
      (canonicalReference(entry.block) && canonicalReference(desired.block)), "unsafe-update");
    const loaded = blockProperty(desired.block, "routine-loaded");
    const oldLoaded = blockProperty(entry.block, "routine-loaded");
    requireValue(oldLoaded === null || oldLoaded === loaded, "unsafe-loaded-transition");
    updates.push({ id, content: desired.block.content, publish: loaded !== null && oldLoaded === null });
  }
  // No loaded owner can become visible before every copy/move/removal is verified.
  updates.sort((a, b) => Number(a.publish) - Number(b.publish));
  for (const { id, content } of updates) {
    await emit({ kind: "update", uuid: id, content }, () => { indexTree(work).get(id).block.content = content; });
  }
  requireValue(JSON.stringify(work) === JSON.stringify(job.desired), "unsafe-order");
  return { operations, initialHash, finalHash: stateHash,
    planHash: await digest([job.pageUuid, job.journalDay, job.name, operations, initialHash, stateHash]) };
}

/**
 * Private executor contract (not registered by this module):
 *
 * createJournalWriter({ sdk, guard, recoveryStore, timeoutMs?, maxOperations? })
 *   .apply({ snapshot, plan, graphKey, pageUuid })
 *
 * graphKey MUST be a stable verified graph key, NOT adapter snapshot.graphId or a
 * display name. pageUuid identifies the already-existing native journal. The input
 * is captured before the first await. Only planned, fully collected engine results
 * are accepted; no page creation, settings, history, or sidebar writes occur here.
 *
 * guard({ graphKey, pageUuid, journalDay, phase, operation }) must freshly verify
 * graph identity, enabled/setup/backup approval, cancellation, Calendar readiness,
 * Calendar's local today, and continued validity of owner/source discovery. Return
 * { allowed: true, graphKey, todayJournalDay } or anything else to deny. It is called
 * before reads and immediately before EVERY mutation (including recovery). A
 * historical target is independently rejected using that fresh Calendar day.
 * operation is null or { kind, uuid }; do not log it or this private input.
 *
 * recoveryStore.load(graphKey) -> record|null; save(graphKey, record|null) MUST be
 * durable, atomic replacement, resolving only after persistence. No memory-only
 * default. One slot per graph deliberately blocks other jobs behind unfinished
 * work. Serialized callers/single writer are required, including across windows.
 *
 * The bounded record contains only v1 metadata, UUIDs, SHA-256 hashes, a cursor,
 * and the pending operation identity. Intent is durable BEFORE issuing an SDK
 * call. A pending operation whose exact postcondition is observed is acknowledged;
 * an unchanged precondition is NOT proof a timed-out call cannot still execute.
 * Thus rejected/absent/ambiguous outcomes halt without retry or rollback. Never
 * clear a record automatically merely to accept a newly generated projection.
 *
 * Exact original snapshot/plan (including generated UUIDs) can resume confirmed
 * partial work. They are NOT persisted here. After a process crash, if the parent
 * cannot reconstruct the identical plan, recovery blocks for explicit review;
 * the record retains pre/post/final hashes and the last operation, not note bodies.
 * This is intentionally conservative crash recovery, not an unattended resume WAL.
 * Store-save failures latch this instance closed; quiesce outstanding storage I/O
 * before reconstructing a writer. Returned reasons/counts are sanitized; SDK errors are
 * never surfaced. `operationsApplied` counts verified operations in THIS call.
 *
 * SDK 0.0.17 LSPlugin.d.ts: insertBlock customUUID/sibling/before/isPageBlock;
 * moveBlock before/children; updateBlock/removeBlock Promise<void>. Return values
 * are not proof of success: page identity and the complete normalized target tree
 * are reread before/after each operation. Expanded trees only (tuples block).
 * Hashes/reads are page-wide; writes are individual blocks. Unrelated edits also
 * conflict. Arbitrary moves/deletes, custom reference cleanup and unsafe root
 * permutations block before writes. New loaded markers are the final operations.
 *
 * No CAS/transaction exists: edits/switches between the final check and SDK apply,
 * delayed host indexing, another writer/window, and in-flight calls cannot be
 * made race-free here. Timeout leaves durable uncertainty. Live Desktop 0.10.15
 * insert positioning, UUID retention and property round trips still need testing.
 */
export function createJournalWriter({ sdk, guard, recoveryStore, timeoutMs = 3000, maxOperations = 1000 }) {
  requireValue(typeof guard === "function" && typeof recoveryStore?.load === "function" &&
    typeof recoveryStore?.save === "function", "invalid-writer-options");
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647 &&
    Number.isInteger(maxOperations) && maxOperations > 0 && maxOperations <= 30000, "invalid-writer-options");
  let busy = false, storageUncertain = false;
  async function bounded(invoke, reason) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(invoke), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new WriterError(reason)), timeoutMs);
      })]);
    } catch (error) { throw error instanceof WriterError ? error : new WriterError(reason); }
    finally { clearTimeout(timer); }
  }
  return {
    async apply(input) {
      let applied = 0, recoveryRequired = false;
      const result = (status, reason = null) => ({ version: 1, status, reason, operationsApplied: applied, recoveryRequired });
      if (busy) return result("blocked", "busy");
      if (storageUncertain) { recoveryRequired = true; return result("blocked", "recovery-store-uncertain"); }
      busy = true;
      try {
        const job = capture(input);
        const program = await compile(job, maxOperations);
        const context = { graphKey: job.graphKey, pageUuid: job.pageUuid, journalDay: job.journalDay };
        async function authorize(phase, operation = null) {
          const permit = await bounded(() => guard({ ...context, phase,
            operation: operation ? { kind: operation.kind, uuid: operation.uuid } : null }), "guard-failed");
          requireValue(permit?.allowed === true && permit.graphKey === job.graphKey &&
            Number.isInteger(permit.todayJournalDay), "guard-denied");
          // Reuse the strict Gregorian date validator, not numeric ordering alone.
          normalizePage({ id: 1, uuid: job.pageUuid, name: job.name, "journal?": true, journalDay: permit.todayJournalDay });
          requireValue(job.journalDay >= permit.todayJournalDay, "historical-journal");
          requireValue(!job.routineMutation || job.journalDay === permit.todayJournalDay, "future-routine-write");
        }
        let pageId;
        const persistedIds = new Set();
        async function observe() {
          const page = await bounded(async () => normalizePage(await sdk.Editor.getPage(job.pageUuid)), "read-failed");
          requireValue(key(page.uuid) === job.pageUuid && page.name === job.name && page.journalDay === job.journalDay &&
            (pageId === undefined || pageId === page.id), "page-conflict");
          pageId = page.id;
          const tree = await bounded(async () => {
            const raw = await sdk.Editor.getPageBlocksTree(job.pageUuid);
            let count = 0, text = 0;
            const seen = new Set(), ids = new Set();
            function expand(list, depth = 0) {
              requireValue(Array.isArray(list) && depth <= 40, "unsupported-tree");
              return list.map((rawBlock) => {
                requireValue(++count <= 10000, "read-limit");
                const block = normalizeBlock(rawBlock), id = key(block.uuid);
                const rawContent = rawBlock.content ?? rawBlock["block/content"];
                if (/^\s*id::/im.test(rawContent)) persistedIds.add(id); else persistedIds.delete(id);
                requireValue(!seen.has(id) && id !== job.pageUuid && (block.id === null || !ids.has(block.id)) &&
                  (block.pageId === null || block.pageId === page.id), "block-conflict");
                seen.add(id);
                if (block.id !== null) ids.add(block.id);
                text += block.content.length;
                requireValue(text <= 4_000_000, "read-limit");
                return { uuid: id, content: block.content, children: expand(block.children, depth + 1) };
              });
            }
            return forest(expand(raw));
          }, "read-failed");
          return digest(tree);
        }
        async function save(record) {
          recoveryRequired = true;
          try { await bounded(() => recoveryStore.save(job.graphKey, clone(record)), "recovery-store-failed"); }
          catch (error) { storageUncertain = true; throw error; }
          recoveryRequired = record !== null;
        }
        function receipt(cursor, pending = false) {
          const operation = program.operations[cursor];
          return { version: 1, pageUuid: job.pageUuid, journalDay: job.journalDay, planHash: program.planHash,
            finalHash: program.finalHash, cursor, stateHash: operation?.beforeHash ?? program.finalHash,
            pending: pending ? { kind: operation.kind, uuid: operation.uuid, afterHash: operation.afterHash } : null };
        }
        await authorize("start");
        let record = await bounded(async () => snapshotSetupEvidence(await recoveryStore.load(job.graphKey)), "recovery-store-failed");
        recoveryRequired = record !== null;
        let cursor = 0;
        if (record !== null) {
          requireValue(record && record.version === 1 && record.planHash === program.planHash &&
            Number.isInteger(record.cursor) && record.cursor >= 0 && record.cursor <= program.operations.length,
          "recovery-plan-required");
          cursor = record.cursor;
          requireValue(!record.pending || cursor < program.operations.length, "invalid-recovery-record");
          requireValue(JSON.stringify(record) === JSON.stringify(snapshotSetupEvidence(receipt(cursor, Boolean(record.pending)))), "invalid-recovery-record");
        }
        let live = await observe();
        await authorize("observed");
        if (record?.pending) {
          requireValue(live === program.operations[cursor].afterHash, "uncertain-outcome");
          cursor++;
          await save(receipt(cursor));
        } else if (record === null && live === program.finalHash) {
          return result("noop");
        }
        requireValue(live === (program.operations[cursor]?.beforeHash ?? program.finalHash), "precondition-conflict");
        for (; cursor < program.operations.length; cursor++) {
          const operation = program.operations[cursor];
          await authorize("precondition", operation);
          requireValue(await observe() === operation.beforeHash, "precondition-conflict");
          await save(receipt(cursor, true));
          await authorize("prepared", operation);
          requireValue(await observe() === operation.beforeHash, "precondition-conflict");
          if (operation.kind === "insert") {
            const absent = await bounded(() => sdk.Editor.getBlock(operation.uuid), "read-failed");
            requireValue(absent === null, "uuid-collision");
            const absentPage = await bounded(() => sdk.Editor.getPage(operation.uuid), "read-failed");
            requireValue(absentPage === null, "uuid-collision");
          }
          await authorize("write", operation);
          await bounded(() => {
            const editor = sdk.Editor;
            if (operation.kind === "insert") return editor.insertBlock(operation.target, operation.content, operation.options);
            if (operation.kind === "move") return editor.moveBlock(operation.uuid, operation.target, operation.options);
            if (operation.kind === "remove") return editor.removeBlock(operation.uuid);
            // Keep the host's persisted UUID property when changing managed text.
            const content = persistedIds.has(operation.uuid)
              ? `${operation.content}\nid:: ${operation.uuid}` : operation.content;
            return editor.updateBlock(operation.uuid, content);
          }, "uncertain-outcome");
          await authorize("verify", operation);
          requireValue(await observe() === operation.afterHash, "uncertain-outcome");
          applied++;
          await save(receipt(cursor + 1));
        }
        await authorize("complete");
        requireValue(await observe() === program.finalHash, "precondition-conflict");
        await save(null);
        return result("applied");
      } catch (error) {
        return result("blocked", error instanceof WriterError ? error.message : "invalid-data");
      } finally { busy = false; }
    },
  };
}
