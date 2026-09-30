import { makePeriod, matchesPeriodMetadata, periodMetadata } from "./period-model.js";
import { createPageWithTextProperties } from "./page-metadata.js";

const PLAN = "jr-snapshot-plan";
const STATE = "jr-snapshot-state";
const TASK = /^(\s*)(?:TODO|DOING|NOW|LATER|WAITING|DONE|CANCELED|CANCELLED)\b/i;
const PROPERTY = /^\s*[^\s:]+::/;
const LOGBOOK = /^\s*:LOGBOOK:\s*$/i;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export class SnapshotConflict extends Error {
  constructor(message) { super(message); this.name = "SnapshotConflict"; }
}

function conflict(message) { throw new SnapshotConflict(message); }
function required(value, message) { if (!value) conflict(message); return value; }

// Fences and their contents are literal text, not Logseq property/drawer syntax.
function fencedLines(lines, skipLogbooks = false) {
  let fence = null, logbook = false;
  return lines.map((line) => {
    if (skipLogbooks && !fence) {
      if (logbook) { if (/^\s*:END:\s*$/i.test(line)) logbook = false; return false; }
      if (LOGBOOK.test(line)) { logbook = true; return false; }
    }
    if (fence) {
      const close = /^\s*(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return true;
    }
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1][0] !== "`" || !open[2].includes("`"))) {
      fence = open[1];
      return true;
    }
    return false;
  });
}

/**
 * Copy policy: retain literal prose, links, references and hierarchy (never rewrite
 * referenced blocks); normalize task markers to TODO. Do not copy ANY block property
 * lines (including id/completion/scheduling/plugin properties), LOGBOOK drawers or
 * SCHEDULED/DEADLINE lines outside fenced code. Fenced code is retained verbatim.
 * Other inline text is copied verbatim. This is deliberately
 * narrower than a general block clone; unsupported property-only blocks pause creation.
 */
export function snapshotContent(content) {
  if (typeof content !== "string") conflict("Malformed definition block content.");
  const lines = content.split("\n"), kept = [];
  const fenced = fencedLines(lines, true);
  let logbook = false;
  for (const [index, line] of lines.entries()) {
    if (logbook) { if (/^\s*:END:\s*$/i.test(line)) logbook = false; continue; }
    if (fenced[index]) { kept.push(line); continue; }
    if (LOGBOOK.test(line)) { logbook = true; continue; }
    if (PROPERTY.test(line) || /^\s*(?:SCHEDULED|DEADLINE|CLOSED):\s/i.test(line)) continue;
    kept.push(line);
  }
  if (logbook) conflict("Unclosed definition LOGBOOK drawer.");
  const result = kept.join("\n").replace(TASK, "$1TODO");
  if (!result.trim()) conflict("A definition block contains only properties or completion metadata.");
  return result;
}

async function definitionTree(editor, page) {
  validatePage(page);
  const raw = required(await editor.getPageBlocksTree(page.uuid), "Definition tree read failed.");
  if (!Array.isArray(raw)) conflict("Malformed definition tree.");
  const seen = new Set();
  let count = 0;
  // Build a stable flat preorder with parent indexes, independent of SDK entity IDs.
  const flat = [];
  async function flatten(list, parent, depth) {
    if (!Array.isArray(list) || depth > 40) conflict("Malformed or too deep definition tree.");
    for (const [position, entry] of list.entries()) {
      const tuple = Array.isArray(entry);
      if (tuple && (entry.length !== 2 || entry[0] !== "uuid" || !UUID.test(entry[1]))) conflict("Malformed definition block reference.");
      const block = tuple ? required(await editor.getBlock(entry[1], { includeChildren: true }), "Definition block reference is missing.") : entry;
      if (!block || !UUID.test(block.uuid) || (tuple && block.uuid.toLowerCase() !== entry[1].toLowerCase()) ||
        seen.has(block.uuid.toLowerCase()) || (block.page?.id != null && block.page.id !== page.id)) {
        conflict("Ambiguous definition block identity or ownership.");
      }
      seen.add(block.uuid.toLowerCase());
      if (isPreBlock(block)) {
        if (parent !== null || position !== 0) conflict("Definition header is not the first root block.");
        validateHeader(block, page);
        const actual = required(await editor.getBlock(block.uuid, { includeChildren: true }), "Definition header is missing.");
        validateHeader(actual, page, block);
        continue; // Page properties are not routine content, even on otherwise empty definitions.
      }
      if (++count > 2000) conflict("Definition exceeds 2000 blocks.");
      const index = flat.length;
      flat.push({ parent, content: snapshotContent(block.content) });
      await flatten(block.children ?? [], index, depth + 1);
    }
  }
  await flatten(raw, null, 0);
  return flat;
}

async function fingerprint(blocks) {
  const bytes = new TextEncoder().encode(JSON.stringify(blocks));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// SDK property maps may use raw hyphenated names or camelCase. As in the old
// boundary, aliases must agree; never coerce ownership dates/IDs or hide conflicts.
function pageProperties(page, period, includeState = false) {
  // getPage().properties may retain the initial state after a direct SDK write.
  // Only the actual pre-block is authoritative for mutable checkpoint state.
  const keys = [...Object.keys(periodMetadata(period)), PLAN, ...(includeState ? [STATE] : [])];
  const names = new Map(keys.flatMap((key) => [[key, key], [key.replaceAll("-", ""), key]]));
  const result = {};
  for (const field of ["properties", "block/properties"]) {
    if (!Object.hasOwn(page, field)) continue;
    const properties = page[field];
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) conflict("Malformed period properties.");
    for (const [name, value] of Object.entries(properties)) {
      const key = names.get(name.toLowerCase());
      if (!key) continue;
      if (typeof value !== "string" || (Object.hasOwn(result, key) && result[key] !== value)) {
        conflict("Conflicting period property aliases.");
      }
      result[key] = value;
    }
  }
  return result;
}

function validatePage(page) {
  if (!page || !UUID.test(page.uuid) || !Number.isSafeInteger(page.id) || page.id <= 0 ||
    (page.format != null && page.format !== "markdown")) conflict("Invalid or unsupported page identity.");
}

function parsePlan(page, period) {
  validatePage(page);
  const properties = pageProperties(page, period);
  if (!matchesPeriodMetadata(properties, period)) conflict(`Period page ownership collision: ${period.pageName}`);
  let plan;
  try { plan = JSON.parse(properties[PLAN]); } catch { conflict("Missing or malformed period creation plan."); }
  if (!plan || (plan.version !== 1 && plan.version !== 2) ||
    (plan.version === 2 && (!validDisplayTitle(plan.displayTitle) || plan.ids?.length < 1)) ||
    !/^[\da-f]{64}$/.test(plan.hash) || !Array.isArray(plan.ids) ||
    plan.ids.length > (plan.version === 2 ? 2001 : 2000) || plan.ids.some((id) => !UUID.test(id)) ||
    new Set(plan.ids.map((id) => id.toLowerCase())).size !== plan.ids.length) {
    conflict("Invalid period creation plan.");
  }
  return { ...plan, ids: plan.ids.map((id) => id.toLowerCase()) };
}

function samePlan(left, right) {
  return left.version === right.version && left.displayTitle === right.displayTitle &&
    left.hash === right.hash && left.ids.length === right.ids.length &&
    left.ids.every((id, index) => id === right.ids[index]);
}

function validDisplayTitle(title) {
  return typeof title === "string" && title.trim() === title && title.length > 0 &&
    !/[\x00-\x1f\x7f]/.test(title) && !PROPERTY.test(title) && !TASK.test(title) &&
    !LOGBOOK.test(title) && !/^\s*(`{3,}|~{3,})/.test(title);
}

function plannedBlocks(definition, plan) {
  return plan.version === 2
    ? [{ parent: null, content: plan.displayTitle }, ...definition.map((block) => ({
      parent: block.parent === null ? 0 : block.parent + 1, content: block.content,
    }))]
    : definition;
}

function snapshotEmpty(plan) {
  return plan.ids.length === (plan.version === 2 ? 1 : 0);
}

function readState(state, length) {
  if (state === "populated" || state === "empty") {
    if ((state === "empty") !== (length === 0)) conflict("Invalid completed period creation state.");
    return { done: true, state };
  }
  const match = typeof state === "string" && /^(ready|writing):(\d+)$/.exec(state);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > length ||
    (match[1] === "writing" && Number(match[2]) === length)) conflict("Invalid period creation state.");
  return { done: false, phase: match[1], cursor: Number(match[2]) };
}

async function expandPeriodTree(raw, editor) {
  if (!Array.isArray(raw)) conflict("Period tree read failed.");
  const seen = new Set();
  async function expand(list, depth = 0) {
    if (!Array.isArray(list) || depth > 40) conflict("Malformed period tree.");
    const result = [];
    for (const item of list) {
      const tuple = Array.isArray(item);
      if (tuple && (item.length !== 2 || item[0] !== "uuid" || !UUID.test(item[1]))) conflict("Malformed period block reference.");
      const block = tuple ? required(await editor.getBlock(item[1], { includeChildren: true }), "Period block reference is missing.") : item;
      if (tuple && block?.uuid?.toLowerCase() !== item[1].toLowerCase()) conflict("Period block reference changed.");
      if (!block || !UUID.test(block.uuid) || !Array.isArray(block.children ?? []) ||
        seen.has(block.uuid.toLowerCase()) || seen.size >= 2001) conflict("Malformed or duplicate period block.");
      seen.add(block.uuid.toLowerCase());
      result.push({ ...block, children: await expand(block.children ?? [], depth + 1) });
    }
    return result;
  }
  return expand(raw);
}

// customUUID adds one redundant id:: line on Desktop. Ignore ONLY that exact
// identity outside code fences, not user properties, task markers or whitespace.
function writtenContent(block) {
  if (typeof block.content !== "string") conflict("Malformed written block content.");
  const lines = block.content.split("\n"), fenced = fencedLines(lines);
  let identity = false;
  return lines.filter((line, index) => {
    if (fenced[index]) return true;
    const match = /^\s*id::\s*(.*?)\s*$/i.exec(line);
    if (!match) return true;
    if (identity || match[1].toLowerCase() !== block.uuid.toLowerCase()) conflict("Conflicting written block identity.");
    identity = true;
    return false;
  }).join("\n");
}

function isPreBlock(block) {
  let flag;
  for (const key of ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]) {
    if (!Object.hasOwn(block, key)) continue;
    if (typeof block[key] !== "boolean" || (flag !== undefined && flag !== block[key])) conflict("Conflicting pre-block markers.");
    flag = block[key];
  }
  return flag === true;
}

function validateHeader(header, page, expected = header) {
  if (!header || !isPreBlock(header) || !UUID.test(header.uuid) || header.uuid.toLowerCase() === page.uuid.toLowerCase() ||
    !Number.isSafeInteger(header.id) || header.id <= 0 || header.id === page.id ||
    header.uuid.toLowerCase() !== expected.uuid.toLowerCase() || header.id !== expected.id ||
    header.page?.id !== page.id || header.parent?.id !== page.id || header.left?.id !== page.id ||
    !Array.isArray(header.children ?? []) || (header.children ?? []).length ||
    (header.format != null && header.format !== "markdown")) {
    conflict("Missing, replaced or misplaced page header; initialization paused.");
  }
}

function splitPeriodHeader(tree, page) {
  const header = tree[0];
  validateHeader(header, page);
  function noOtherHeaders(blocks) {
    for (const block of blocks) {
      if (isPreBlock(block)) conflict("Multiple or misplaced period headers; initialization paused.");
      noOtherHeaders(block.children ?? []);
    }
  }
  const blocks = tree.slice(1);
  noOtherHeaders(blocks);
  return { header, blocks };
}

function headerProperties(header, period, plan) {
  const properties = pageProperties(header, period, true);
  const keys = [...Object.keys(periodMetadata(period)), PLAN, STATE];
  const names = new Map(keys.flatMap((key) => [[key, key], [key.replaceAll("-", ""), key]]));
  const textual = {};
  for (const line of writtenContent(header).split("\n")) {
    const match = /^\s*([^\s:]+)::\s*(.*?)\s*$/.exec(line);
    const key = match && names.get(match[1].toLowerCase());
    if (!key) continue;
    // Writes use canonical names. An alternative textual spelling or a duplicate
    // must not be silently shadowed by appending another managed property.
    if (match[1].toLowerCase() !== key || Object.hasOwn(textual, key)) conflict("Conflicting header property text.");
    textual[key] = match[2];
  }
  if (keys.some((key) => typeof textual[key] !== "string" || textual[key] !== properties[key]) ||
    !samePlan(parsePlan(header, period), plan)) conflict("Header ownership, plan or property text conflict.");
  return properties;
}

function actualBlocks(raw, ids, page, header) {
  if (!Array.isArray(raw)) conflict("Period tree read failed.");
  const found = new Map(), order = [];
  const planned = new Set(ids.map((id) => id.toLowerCase()));
  function walk(list, parent) {
    if (!Array.isArray(list)) conflict("Malformed period tree.");
    let leftId = parent === null ? header.id : found.get(parent).block.id;
    for (const block of list) {
      // Unknown blocks during initialization might be user edits, not disposable scaffolding.
      if (!block || Array.isArray(block) || !UUID.test(block.uuid) || !planned.has(block.uuid.toLowerCase()) ||
        found.has(block.uuid.toLowerCase())) conflict("Unexpected or ambiguous blocks on initializing period page.");
      const parentId = parent === null ? page.id : found.get(parent).block.id;
      if ((block.page?.id != null && block.page.id !== page.id) ||
        (block.parent?.id != null && block.parent.id !== parentId) ||
        (block.left?.id != null && block.left.id !== leftId)) conflict("Written block ownership, parent or sibling changed.");
      leftId = block.id;
      found.set(block.uuid.toLowerCase(), { block, parent });
      order.push(block.uuid.toLowerCase());
      walk(block.children ?? [], block.uuid.toLowerCase());
    }
  }
  walk(raw, null);
  return { found, order };
}

/**
 * Initialize ONE exact period page. Caller serializes calls and supplies an async
 * guard that rejects stale graph/disabled work before each operation. No graph scans.
 * Returned status: created | resumed | existing; empty means no definition content.
 * A displayTitle opts new pages into a planned summary root; completed pages expose
 * viewBlockId only while that root can be verified. Omission keeps the page fallback.
 * Missing pages require explicit allowCreate=true. The caller must persist a minimal
 * initialized-period tombstone and pass false after first creation, even if the user
 * deletes the page; a deleted page must not be automatically rebuilt.
 * Fresh metadata is parsed from header text, avoiding SDK createPage property Beans.
 * Ownership/plan stay on the page; checkpoint state is read/written on that exact
 * header, never the stale page property mirror. No missing header is reconstructed.
 * Concurrent initializers on different devices are not an atomic transaction.
 */
export async function createPeriodSnapshot({ sdk, period: input, definitionPage, guard, allowCreate = false, displayTitle }) {
  const period = makePeriod(input);
  if (!sdk?.Editor || typeof guard !== "function" || typeof definitionPage !== "string" || !definitionPage.trim() ||
    definitionPage.toLowerCase() === period.pageName.toLowerCase()) throw new TypeError("Expected SDK, graph guard and distinct definition page name.");
  if (displayTitle !== undefined && !validDisplayTitle(displayTitle)) throw new TypeError("Expected a nonempty single-line display title without block metadata or task syntax.");
  const editor = sdk.Editor;
  async function checked(fn) { await guard(); const value = await fn(); await guard(); return value; }
  let page = await checked(() => editor.getPage(period.pageName));
  let created = false, createdPlan = null;
  if (page === undefined) conflict("Period lookup returned an ambiguous result.");
  if (page === null) {
    if (!allowCreate) conflict(`Period page is absent; refusing automatic recreation: ${period.pageName}`);
    const definition = required(await checked(() => editor.getPage(definitionPage)), "Definition page is missing.");
    const source = await definitionTree({
      getPageBlocksTree: (...args) => checked(() => editor.getPageBlocksTree(...args)),
      getBlock: (...args) => checked(() => editor.getBlock(...args)),
    }, definition);
    const draft = displayTitle === undefined ? { version: 1 } : { version: 2, displayTitle };
    const blocks = plannedBlocks(source, draft);
    if (blocks.length > (draft.version === 2 ? 2001 : 2000)) conflict("Snapshot exceeds supported planned block count.");
    const ids = [];
    for (const block of blocks) {
      const id = await checked(() => editor.newBlockUUID());
      if (!UUID.test(id) || ids.includes(id.toLowerCase()) || id.toLowerCase() === definition.uuid?.toLowerCase()) conflict("Invalid fresh block ID.");
      ids.push(id.toLowerCase());
    }
    const plan = { ...draft, hash: await fingerprint(blocks), ids };
    // A same-name page may have appeared while the definition was being read.
    if (await checked(() => editor.getPage(period.pageName)) !== null) conflict("Period page appeared before creation; inspect before retrying.");
    try {
      page = required(await createPageWithTextProperties({
        editor, name: period.pageName, guard, reservedIds: [...ids, definition.uuid],
        properties: { ...periodMetadata(period), [PLAN]: JSON.stringify(plan), [STATE]: "ready:0" },
      }), "Period page creation could not be verified.");
    } catch (error) {
      conflict(`Period page creation outcome is ambiguous; inspect ${period.pageName}: ${error.message}`);
    }
    createdPlan = plan;
    created = true;
  }
  const plan = parsePlan(page, period);
  async function readPeriodTree() {
    const tree = await expandPeriodTree(await checked(() => editor.getPageBlocksTree(page.uuid)), {
      getBlock: (...args) => checked(() => editor.getBlock(...args)),
    });
    return splitPeriodHeader(tree, page);
  }
  const initial = await readPeriodTree();
  const header = initial.header;
  if (plan.ids.includes(header.uuid.toLowerCase())) conflict("Creation plan includes the page header identity.");
  async function readHeader() {
    const current = required(await checked(() => editor.getBlock(header.uuid, { includeChildren: true })), "Period header disappeared; initialization paused.");
    validateHeader(current, page, header);
    return headerProperties(current, period, plan);
  }
  let expectedState = (await readHeader())[STATE];
  let state = readState(expectedState, plan.ids.length);
  if (createdPlan && (!samePlan(plan, createdPlan) || expectedState !== "ready:0")) {
    conflict("Created period plan or state differs from the requested snapshot.");
  }
  async function viewBlockId(tree) {
    if (plan.version !== 2) return undefined;
    const root = tree.blocks[0];
    if (!root || root.uuid.toLowerCase() !== plan.ids[0] || isPreBlock(root) ||
      !Number.isSafeInteger(root.id) || root.id <= 0 || root.page?.id !== page.id ||
      root.parent?.id !== page.id || root.left?.id !== header.id) return undefined;
    const current = await checked(() => editor.getBlock(plan.ids[0]));
    if (!current || current.uuid?.toLowerCase() !== root.uuid.toLowerCase() || current.id !== root.id ||
      isPreBlock(current) || current.page?.id !== page.id || current.parent?.id !== page.id ||
      current.left?.id !== header.id) return undefined;
    return plan.ids[0];
  }
  if (state.done) {
    const verifiedView = await viewBlockId(initial);
    return { status: created ? "created" : "existing", pageName: period.pageName,
      empty: snapshotEmpty(plan), ...(verifiedView ? { viewBlockId: verifiedView } :
        plan.version === 2 ? { viewUnavailable: true } : {}) };
  }

  const definition = required(await checked(() => editor.getPage(definitionPage)), "Definition page is missing during initialization.");
  if (definition.uuid?.toLowerCase() === page.uuid.toLowerCase()) conflict("Definition and period resolve to the same page.");
  const blocks = plannedBlocks(await definitionTree({
    getPageBlocksTree: (...args) => checked(() => editor.getPageBlocksTree(...args)),
    getBlock: (...args) => checked(() => editor.getBlock(...args)),
  }, definition), plan);
  if (blocks.length !== plan.ids.length || await fingerprint(blocks) !== plan.hash) {
    conflict("Definition changed during unfinished period initialization; inspect the period page.");
  }
  async function verifyCheckpoint() {
    const current = required(await checked(() => editor.getPage(period.pageName)), "Initializing period page disappeared.");
    if (current.uuid?.toLowerCase() !== page.uuid.toLowerCase() || current.id !== page.id ||
      !samePlan(parsePlan(current, period), plan) || (await readHeader())[STATE] !== expectedState) {
      conflict("Period identity, plan or state could not be verified; initialization paused. Inspect the period page before retrying.");
    }
  }
  async function checkpoint(next) {
    await verifyCheckpoint();
    await checked(() => editor.upsertBlockProperty(header.uuid, STATE, next));
    expectedState = next;
    // A resolved SDK promise is not proof the header write is visible. Page-map
    // mirroring is neither expected nor used, even after a successful checkpoint.
    await verifyCheckpoint();
  }
  async function verifyTree(written, tree = null) {
    tree ??= await readPeriodTree();
    validateHeader(tree.header, page, header);
    const actual = actualBlocks(tree.blocks, plan.ids, page, header);
    for (let i = 0; i < blocks.length; i++) {
      const item = actual.found.get(plan.ids[i]);
      const parent = blocks[i].parent === null ? null : plan.ids[blocks[i].parent];
      if (i < written) {
        if (!item || item.parent !== parent || writtenContent(item.block) !== blocks[i].content) {
          conflict("Planned block was deleted or edited during initialization; refusing to refill it.");
        }
      } else if (item) conflict("Unexpected planned block beyond creation cursor.");
    }
    if (actual.order.length !== written || actual.order.some((id, index) => id !== plan.ids[index])) {
      conflict("Initializing period block order differs from the saved creation cursor.");
    }
    return actual.found;
  }
  const found = await verifyTree(state.cursor + (state.phase === "writing" ? 1 : 0), initial);
  if (state.phase === "writing") {
    // Missing/edited writes above are ambiguous, never permission for a blind retry.
    await checkpoint(`ready:${state.cursor + 1}`);
    state = { phase: "ready", cursor: state.cursor + 1 };
  }
  for (let i = state.cursor; i < blocks.length; i++) {
    if (plan.ids[i] === page.uuid.toLowerCase() || plan.ids[i] === definition.uuid.toLowerCase() ||
      await checked(() => editor.getBlock(plan.ids[i])) !== null) conflict("Fresh block identity is occupied or ambiguous.");
    await checkpoint(`writing:${i}`);
    const parent = blocks[i].parent;
    // Siblings append after the preceding sibling; children append under parent.
    let previous = null;
    for (let j = i - 1; j >= 0; j--) {
      if (blocks[j].parent === parent) { previous = plan.ids[j]; break; }
    }
    const anchor = previous ?? (parent === null ? header.uuid : plan.ids[parent]);
    const parentId = parent === null ? page.id : found.get(plan.ids[parent])?.block.id;
    const leftId = previous === null ? (parent === null ? header.id : parentId) : found.get(previous)?.block.id;
    if (![parentId, leftId].every((id) => Number.isSafeInteger(id) && id > 0)) conflict("Insertion anchor identity is ambiguous.");
    const inserted = await checked(() => editor.insertBlock(anchor, blocks[i].content, {
      sibling: Boolean(previous) || parent === null, isPageBlock: false,
      focus: false, customUUID: plan.ids[i],
    }));
    if (!inserted || inserted.uuid?.toLowerCase() !== plan.ids[i]) conflict("Block write outcome is ambiguous; inspect the period page.");
    const actual = await checked(() => editor.getBlock(plan.ids[i]));
    if (!actual || actual.uuid?.toLowerCase() !== plan.ids[i] || !Number.isSafeInteger(actual.id) || actual.id <= 0 ||
      actual.page?.id !== page.id || actual.parent?.id !== parentId || actual.left?.id !== leftId ||
      writtenContent(actual) !== blocks[i].content) {
      conflict("Block write could not be verified in its expected location; initialization paused.");
    }
    found.set(plan.ids[i], { block: actual, parent: parent === null ? null : plan.ids[parent] });
    await checkpoint(`ready:${i + 1}`);
  }
  // Catch edits, deletions, unexpected children and reordering during this run too.
  const finalTree = await readPeriodTree();
  await verifyTree(blocks.length, finalTree);
  await checkpoint(blocks.length ? "populated" : "empty");
  const verifiedView = await viewBlockId(finalTree);
  return { status: created ? "created" : "resumed", pageName: period.pageName,
    empty: snapshotEmpty(plan), ...(verifiedView ? { viewBlockId: verifiedView } :
      plan.version === 2 ? { viewUnavailable: true } : {}) };
}
