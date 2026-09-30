import { createPageWithTextProperties } from "./page-metadata.js";

export const HISTORY_PAGE = "Journal & Routines — History";
const SEEN = "journal-routines:history-seen:v1:";
const OWNER = "jr-history-version";
const STATE = "jr-history-state";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * Query functions are source-audited; evaluation and native page-result rendering
 * remain fixture-only, not Desktop-validated. No custom renderer
 * or background SDK query: native pull results retain links to the original pages.
 * Names contain calendar + kind + civil range; sort by ISO start descending.
 */
export function historyQuery(kind) {
  if (!["weekly", "monthly"].includes(kind)) throw new TypeError("Unknown history kind.");
  return `## ${kind === "weekly" ? "Weekly" : "Monthly"} routines
#+BEGIN_QUERY
{:title "${kind === "weekly" ? "Weekly" : "Monthly"} routine history — both calendars"
 :query [:find (pull ?p [*])
         :where
         [?p :block/name ?name]
         [?p :block/properties ?props]
         [(get ?props :jr-kind) ?kind]
         [(= ?kind "${kind}")]
         [(get ?props :jr-calendar) ?calendar]
         [(contains? #{"gregorian" "jalali"} ?calendar)]
         [(get ?props :jr-start) ?start]
         [(get ?props :jr-end) ?end]
         [(get ?props :jr-period-id) ?id]
         [(str "journal-routines:" ?calendar ":" ?kind ":" ?start ":" ?end) ?expected]
         [(= ?id ?expected)]]
 :result-transform (fn [rows] (sort-by (fn [page] [(get-in page [:block/properties :jr-start]) (get-in page [:block/properties :jr-end]) (:block/name page)]) (fn [a b] (compare b a)) rows))
 :collapsed? false}
#+END_QUERY`;
}

function properties(page, keys = [OWNER, STATE]) {
  const result = {};
  for (const source of [page.properties, page["block/properties"]]) {
    if (source === undefined) continue;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Malformed history page properties.");
    for (const [name, value] of Object.entries(source)) {
      const key = keys.find((key) => key.replaceAll("-", "") === name.toLowerCase().replaceAll("-", ""));
      if (!key) continue;
      if (typeof value !== "string" || (Object.hasOwn(result, key) && result[key] !== value)) {
        throw new Error("Conflicting history ownership property aliases.");
      }
      result[key] = value;
    }
  }
  return result;
}
function validatePage(page) {
  if (!page || !UUID.test(page.uuid) || !Number.isSafeInteger(page.id) || page.id <= 0 ||
    page["journal?"] === true || page.isJournal === true || (page.format != null && page.format !== "markdown") ||
    properties(page, [OWNER])[OWNER] !== "v1") throw new Error(`History page ownership collision: ${HISTORY_PAGE}`);
}
function preBlock(block) {
  const values = ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]
    .filter((key) => Object.hasOwn(block, key)).map((key) => block[key]);
  if (values.some((value) => typeof value !== "boolean" || value !== values[0])) {
    throw new Error("Conflicting history header pre-block aliases.");
  }
  return values[0] === true;
}
function validateHeader(header, page) {
  if (!header || !preBlock(header) || !UUID.test(header.uuid) || header.uuid.toLowerCase() === page.uuid.toLowerCase() ||
    !Number.isSafeInteger(header.id) || header.id <= 0 || header.id === page.id ||
    header.page?.id !== page.id || header.parent?.id !== page.id || header.left?.id !== page.id ||
    !Array.isArray(header.children ?? []) || (header.children ?? []).length ||
    properties(header)[OWNER] !== properties(page, [OWNER])[OWNER]) {
    throw new Error("History header identity, location or immutable ownership is ambiguous; no automatic repair.");
  }
}
function contentOf(block) {
  // Desktop may append the custom UUID as an id:: property.
  if (typeof block.content !== "string") return null;
  return block.content.split("\n").filter((line) => line.trim().toLowerCase() !== `id:: ${block.uuid.toLowerCase()}`).join("\n");
}

/**
 * Caller serializes and supplies a graph/generation guard. A durable tombstone is
 * written BEFORE creation. Interrupted initialization deliberately pauses instead
 * of retrying writes: user edits/deletions cannot be distinguished from lost SDK
 * acknowledgements. Completed pages are never repopulated, even when empty.
 */
export async function ensureRoutineHistory({ sdk, storage, graphKey, guard }) {
  async function checked(operation) { await guard(); const value = await operation(); await guard(); return value; }
  const editor = sdk.Editor, marker = SEEN + graphKey;
  // Metadata text creates a separate root pre-block; checkpoint writes target
  // ITS UUID. Mutable page properties may lag indefinitely after those writes.
  async function readHeader(page, expectedState, expectedHeader) {
    validatePage(page);
    const raw = await checked(() => editor.getPageBlocksTree(page.uuid));
    if (!Array.isArray(raw)) throw new Error("History header tree read is ambiguous.");
    const tree = [];
    for (const entry of raw) {
      let block = entry;
      if (Array.isArray(entry)) {
        if (entry.length !== 2 || entry[0] !== "uuid" || !UUID.test(entry[1])) throw new Error("Malformed history block reference.");
        block = await checked(() => editor.getBlock(entry[1], { includeChildren: true }));
        if (block?.uuid?.toLowerCase() !== entry[1].toLowerCase()) throw new Error("History block reference changed.");
      }
      if (!block || typeof block !== "object") throw new Error("History tree read is ambiguous.");
      tree.push(block);
    }
    const headers = tree.filter(preBlock);
    if (headers.length !== 1 || headers[0] !== tree[0]) throw new Error("History header is missing, duplicated or misplaced; no automatic repair.");
    const treeHeader = headers[0];
    validateHeader(treeHeader, page);
    const header = await checked(() => editor.getBlock(treeHeader.uuid, { includeChildren: true }));
    validateHeader(header, page);
    if (header.uuid !== treeHeader.uuid || header.id !== treeHeader.id ||
      tree.slice(1).some((block) => block.uuid === header.uuid || block.id === header.id) ||
      (expectedHeader && (header.uuid !== expectedHeader.uuid || header.id !== expectedHeader.id))) {
      throw new Error("History header identity changed; no automatic repair.");
    }
    if (properties(header)[STATE] !== expectedState || properties(treeHeader)[STATE] !== expectedState) {
      throw new Error("History initialization is incomplete or ambiguous; inspect the history page. No automatic repopulation.");
    }
    return { header, content: tree.slice(1) };
  }
  let page = await checked(() => editor.getPage(HISTORY_PAGE));
  if (page === undefined) throw new Error("History lookup is ambiguous.");
  const seen = await checked(() => storage.get(marker));
  if (seen !== null && seen !== true) throw new Error("Invalid saved history creation marker.");
  if (page !== null) {
    await readHeader(page, "ready");
    if (!seen) await checked(() => storage.set(marker, true));
    return { pageName: HISTORY_PAGE, id: page.id, status: "existing" };
  }
  if (seen) throw new Error("Deleted history page is preserved as deleted; no automatic recreation.");
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const id = await checked(() => editor.newBlockUUID());
    if (!UUID.test(id) || ids.includes(id.toLowerCase()) || await checked(() => editor.getBlock(id)) !== null) {
      throw new Error("History block identity is occupied or ambiguous.");
    }
    ids.push(id.toLowerCase());
  }
  if (await checked(() => editor.getPage(HISTORY_PAGE)) !== null) throw new Error("History page appeared before creation; no writes made.");
  await checked(() => storage.set(marker, true));
  let acknowledgement;
  try {
    // createPage(properties) produces a Bean that Transit cannot serialize on
    // Desktop 0.10.15; updateBlock text reparses native persistent property maps.
    acknowledgement = await checked(() => createPageWithTextProperties({
      editor, name: HISTORY_PAGE, properties: { [OWNER]: "v1", [STATE]: "initializing" }, guard, reservedIds: ids,
    }));
  } catch (error) { throw new Error(`History creation outcome is ambiguous; inspect the history page. ${error.message}`); }
  page = await checked(() => editor.getPage(HISTORY_PAGE));
  validatePage(page);
  const { header } = await readHeader(page, "initializing");
  if (!acknowledgement || acknowledgement.uuid !== page.uuid || acknowledgement.id !== page.id || ids.includes(page.uuid.toLowerCase()) || ids.includes(header.uuid.toLowerCase())) {
    throw new Error("History creation acknowledgement is ambiguous; no blocks were populated.");
  }
  const written = [];
  async function verify(state = "initializing") {
    const current = await checked(() => editor.getPage(HISTORY_PAGE));
    validatePage(current);
    if (current.id !== page.id || current.uuid !== page.uuid) throw new Error("History page identity changed.");
    const { content } = await readHeader(current, state, header);
    if (content.length !== written.length) throw new Error("History page was edited during initialization; no repopulation.");
    for (let i = 0; i < written.length; i++) {
      const block = content[i];
      if (block?.uuid !== ids[i] || block.id !== written[i].id ||
        block.page?.id !== page.id || block.parent?.id !== page.id || block.left?.id !== (i === 0 ? header.id : written[i - 1].id) ||
        contentOf(block) !== historyQuery(i === 0 ? "weekly" : "monthly") ||
        !Array.isArray(block.children ?? []) || (block.children ?? []).length) throw new Error("History blocks changed during initialization; no repopulation.");
    }
  }
  for (const [i, kind] of ["weekly", "monthly"].entries()) {
    await verify();
    if (await checked(() => editor.getBlock(ids[i])) !== null) throw new Error("History block identity became occupied.");
    const inserted = await checked(() => editor.insertBlock(i === 0 ? header.uuid : ids[i - 1], historyQuery(kind), {
      sibling: true, isPageBlock: false, focus: false, customUUID: ids[i],
    }));
    const block = await checked(() => editor.getBlock(ids[i]));
    if (inserted?.uuid !== ids[i] || block?.uuid !== ids[i] || !Number.isSafeInteger(block.id) || block.id <= 0 ||
      block.page?.id !== page.id || block.parent?.id !== page.id || block.left?.id !== (i === 0 ? header.id : written[i - 1].id) ||
      contentOf(block) !== historyQuery(kind)) throw new Error("History block write is ambiguous; inspect the history page.");
    written.push(block);
  }
  await verify();
  await checked(() => editor.upsertBlockProperty(header.uuid, STATE, "ready"));
  await verify("ready");
  return { pageName: HISTORY_PAGE, id: page.id, status: "created" };
}
