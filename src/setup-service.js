import { canonicalSetupJSON, matchesSetupSection, SETUP_SECTIONS, snapshotSetupEvidence } from "./setup-plan.js";
import { validateBlocks } from "./journal-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const PAGE_NAMES = ["Week Routine", "Month Routine", "Templates"];
const MARKER = "journal-routines-setup";
const TEMPLATE_QUERY = `[:find ?uuid ?template
 :where [?b :block/uuid ?uuid] [?b :block/properties ?props]
 [(get ?props :template) ?template]]`;
const DEFAULTS = {
  "week-0": "TODO پروژه‌های فعال را مرور کن.",
  "week-1": "TODO کارهای ناتمام و در انتظار را مرور کن.",
  "week-2": "TODO تمرکز اصلی هفته‌ی بعد را انتخاب کن.",
  "month-0": "TODO تمرکز اصلی این ماه شمسی را انتخاب کن.",
  "month-1": "TODO کارهای ناتمام و در انتظار را مرور کن.",
  "month-2": "TODO کارهای غیرفعال را ببند یا بایگانی کن.",
  "month-3": "TODO پیشرفت پروژه‌های فعال را مرور کن.",
  template: "یادداشت روزانه\ntemplate:: daily-default\ntemplate-including-parent:: false",
  input: "",
  "review-0": "امروز چه چیزی جلو رفت؟",
  "review-1": "آیا بررسی عادت‌های امروز را کامل کردم؟",
  "review-2": "فردا چه چیزی باید ادامه پیدا کند؟",
  ...Object.fromEntries(SETUP_SECTIONS.map((title, i) => [`section-${i}`, `## ${title}`])),
};
const LIMITS = [
  "Resource setup only: never enables automation, creates native journals, changes configuration, or writes period owners/history.",
  "Before each write the caller's guard must verify explicit setup/backup approval, graph/lifecycle validity, Calendar readiness, owner checks and no overlapping legacy journal automation. These are not detected by this resource service.",
  "No verified backup/export completion API is used. Back up the graph and confirm in the caller's setup flow before approving writes.",
  "If no journal template is configured, select daily-default in graph configuration before enabling; custom configuration is never replaced.",
  "Queries cover indexed template properties, not unindexed files. Non-string template properties block inspection. Reads are bounded and sampled, not an atomic snapshot.",
  "Inspection limits: 3 named pages plus the template tree, 10,000 template definitions/source blocks, depth 40, 4M content units, 30 seconds per scan and a configurable per-call timeout.",
  "Single service instance/single writer only. Another window or a switch away and back between samples can race checks; already-issued SDK calls cannot be canceled.",
  "Partial resources may be visible until setup completes. Missing uncertain writes require manual reconciliation, not blind retries. Keep the durable recovery store; do not clear it to bypass a conflict.",
  "SDK contracts checked against @logseq/libs 0.0.17 and Logseq 0.10.15 source; live Desktop write behavior still requires disposable-graph validation.",
];
const MESSAGES = {
  "read-failed": "A supported SDK read failed or returned incomplete data; absence was not established.",
  "read-timeout": "A setup read exceeded its time limit; no truncated result is accepted.",
  "graph-changed": "The graph changed. Inspect and approve setup again in the intended graph.",
  "unsupported-graph": "Setup requires a named Markdown file graph with a stable nonempty path and journals enabled.",
  "template-conflict": "daily-default definitions, root inclusion, or section placement are ambiguous. Resolve the collision explicitly before setup.",
  "custom-journal-template": "A custom journal template is configured. Preserve it and make an explicit template choice before setup.",
  "store-unavailable": "A durable setup recovery store with get/set is required; storage must succeed before graph writes.",
  "recovery-conflict": "Partial setup no longer matches its recorded checkpoint. Preserve the content and reconcile it manually; nothing is reseeded.",
  "write-uncertain": "A write may still be in flight or its outcome is unknown. Reinspect after it settles; no missing write is retried automatically.",
  "stale-plan": "Resources or configuration changed since review. Inspect and approve a fresh plan.",
  "invalid-token": "This is not a private plan token issued by this service instance. Inspect setup again.",
  "guard-denied": "The setup write guard did not authorize this operation. No further writes were issued.",
  "write-api-unavailable": "The installed SDK does not expose the required ordinary page/block write APIs.",
  "identity-unavailable": "Secure setup identities or fingerprints are unavailable.",
};
class SetupError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}
function requireValue(value, code = "read-failed") { if (!value) throw new SetupError(code); }
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (name) => name.toLowerCase().replaceAll("-", "");
const clone = (value) => snapshotSetupEvidence(value);
const equal = (a, b) => canonicalSetupJSON(a) === canonicalSetupJSON(b);
function propertyMap(properties = {}) {
  requireValue(record(properties));
  const result = {};
  for (const [name, value] of Object.entries(properties)) {
    const normalized = key(name);
    if (["id", "createdat", "updatedat"].includes(normalized)) continue;
    requireValue(!Object.hasOwn(result, normalized));
    result[normalized] = normalized === "templateincludingparent" && value === "false" ? false : value;
  }
  return result;
}
function cleanTree(tree) {
  validateBlocks(tree);
  function clean(block) {
    requireValue(block.format === undefined || block.format === "markdown", "unsupported-graph");
    const content = block.content.split("\n").filter((line) => {
      const id = /^\s*id::\s*(.*?)\s*$/.exec(line);
      return !id || id[1].toLowerCase() !== block.uuid.toLowerCase();
    }).join("\n");
    return { uuid: block.uuid.toLowerCase(), content, properties: propertyMap(block.properties), children: (block.children ?? []).map(clean) };
  }
  return tree.map(clean);
}
function walk(blocks, visit, depth = 0) {
  for (const block of blocks) { visit(block, depth); walk(block.children, visit, depth + 1); }
}
function values(block, name) {
  const normalized = key(name);
  const text = block.content.split("\n").flatMap((line) => {
    const match = /^\s*([^\s:]+)::\s*(.*?)\s*$/.exec(line);
    return match && key(match[1]) === normalized ? [match[2]] : [];
  });
  requireValue(text.length <= 1, "template-conflict");
  return [...text, ...(Object.hasOwn(block.properties, normalized) ? [block.properties[normalized]] : [])];
}
function analyze(state) {
  const root = state.template;
  if (!root) return [...SETUP_SECTIONS];
  const definition = values(root, "template"), inclusion = values(root, "template-including-parent");
  requireValue(definition.length && definition.every((v) => v === "daily-default") &&
    inclusion.length && inclusion.every((v) => v === false || v === "false"), "template-conflict");
  const found = new Map(SETUP_SECTIONS.map((title) => [title, []]));
  walk([root], (block, depth) => {
    if (depth) requireValue(!values(block, "template").length, "template-conflict");
    let matches = 0;
    for (const title of SETUP_SECTIONS) {
      const marker = values(block, "routine-section");
      const marked = title === "Weekly tasks" ? "[[Routine Weekly Section]]" : title === "Monthly tasks" ? "[[Routine Monthly Section]]" : null;
      if (matchesSetupSection(block.content, title) || (marked && marker.includes(marked))) {
        found.get(title).push(depth);
        matches += 1;
      }
    }
    requireValue(matches <= 1, "template-conflict");
  });
  for (const depths of found.values()) requireValue(depths.length <= 1 && depths.every((depth) => depth === 1), "template-conflict");
  return SETUP_SECTIONS.filter((title) => !found.get(title).length);
}
function publicChanges(ops) {
  function title(op) {
    if (op.preset === "template") return "Create daily-default (root excluded)";
    if (op.preset.startsWith("week-")) return "Append starter task to new Week Routine";
    if (op.preset.startsWith("month-")) return "Append starter task to new Month Routine";
    if (op.preset.startsWith("section-")) return `Append missing ${SETUP_SECTIONS[Number(op.preset.slice(8))]} section to daily-default`;
    if (op.preset.startsWith("review-")) return "Append starter end-of-day review prompt";
    return "Append empty input child to new section";
  }
  return ops.map((op) => op.kind === "page"
    ? { kind: "create-page", title: `Create ${op.page}`, content: "Missing page only; retain a setup recovery ownership property." }
    : { kind: "append-block", title: title(op), content: DEFAULTS[op.preset] });
}
function summary(status, changes = [], blockers = [], configuration = "unknown") {
  return { version: 1, status, changes, blockers, configuration, limitations: [...LIMITS], activates: false };
}

/**
 * Public API: createSetupService({ sdk, guard, store, timeoutMs = 3000,
 *   createUuid = () => crypto.randomUUID() }) -> { inspect, apply }.
 * inspect() -> { summary, token }; apply(token) -> { status, summary }.
 * summary: { version: 1, status, changes: [{kind,title,content}], blockers:
 *   [{code,message}], configuration: 'daily-default'|'manual-selection-required'|
 *   'unknown', limitations: string[], activates: false }.
 * Tokens are frozen, empty objects recognized by a private WeakMap, not DTOs,
 * fingerprints or transferable approvals. Applying a token is explicit resource
 * approval only; caller must gate UI approval/backup and Enable separately.
 *
 * guard({ phase: 'apply'|'write', graphKey, operation: null|{kind,index} }) must
 * resolve exactly true. It owns dependency/owner/legacy/backup/lifecycle gates,
 * including invalidation on Disable/unload/graph switch. It is called repeatedly,
 * including immediately before each SDK write: it must revalidate current state,
 * not prompt, write graph content, or return a cached approval. No default authorization.
 * store.get(key) -> null|record; store.set(key, record) -> durable completion.
 * Store is trusted private plugin storage, scoped by SHA-256 of the graph path;
 * never a display-name key or adapter scan ID. Writes must be durable/ordered and
 * reject on failure. Records contain preset keys/UUIDs/checkpoint hashes, no note
 * bodies or paths. A pending record is retained even on uncertain SDK outcomes.
 *
 * @logseq/libs 0.0.17 LSPlugin.d.ts: createPage, insertBlock(customUUID),
 * getPageBlocksTree, getBlock(includeChildren), datascriptQuery. Host evidence:
 * https://github.com/logseq/logseq/blob/0.10.15/src/main/logseq/api.cljs
 * get_current_graph_configs uses get-in with literal key strings; create_page
 * returns existing pages without applying properties; insert_block rejects an
 * existing custom UUID and supports page names. App.getTemplate alone is not a
 * uniqueness check (frontend/db/model.cljs get-template-by-name uses first).
 * No undocumented configuration setters, native journal fabrication, batch
 * return-shape assumptions, graph deletion, or rollback is used here.
 */
export function createSetupService({ sdk, guard, store, timeoutMs = 3000, createUuid = () => globalThis.crypto.randomUUID() }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Invalid setup timeoutMs.");
  const tokens = new WeakMap();
  let queue = Promise.resolve();
  // A locally timed-out storage write could complete later and overwrite a newer
  // checkpoint. Quarantine this instance instead of allowing reordered retries.
  let storageUncertain = false;
  function serial(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }
  async function bounded(fn, code = "read-failed", timeoutCode = "read-timeout") {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn).catch(() => { throw new SetupError(code); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new SetupError(timeoutCode)), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function digest(value) {
    try {
      const bytes = new TextEncoder().encode(canonicalSetupJSON(value));
      const hash = await bounded(() => globalThis.crypto.subtle.digest("SHA-256", bytes), "identity-unavailable", "identity-unavailable");
      requireValue(hash instanceof ArrayBuffer && hash.byteLength === 32, "identity-unavailable");
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch { throw new SetupError("identity-unavailable"); }
  }
  function uuid() {
    let result;
    try { result = createUuid(); } catch { throw new SetupError("identity-unavailable"); }
    requireValue(typeof result === "string" && UUID.test(result), "identity-unavailable");
    return result.toLowerCase();
  }
  async function graphPath() {
    const graph = await bounded(() => sdk.App.getCurrentGraph());
    requireValue(record(graph) && typeof graph.path === "string" && graph.path.trim() &&
      typeof graph.name === "string" && graph.name.trim(), "unsupported-graph");
    return graph.path;
  }
  async function sameGraph(path) { requireValue(await graphPath() === path, "graph-changed"); }
  async function scan(path) {
    const started = Date.now();
    async function read(fn) {
      requireValue(Date.now() - started < 30000, "read-timeout");
      await sameGraph(path);
      const value = clone(await bounded(fn));
      await sameGraph(path);
      return value;
    }
    const user = await read(() => sdk.App.getUserConfigs());
    requireValue(record(user) && user.preferredFormat === "markdown" && user.enabledJournals === true, "unsupported-graph");
    const configured = await read(() => sdk.App.getCurrentGraphConfigs("default-templates", "journals"));
    requireValue(configured === null || typeof configured === "string");
    requireValue(configured === null || configured === "" || configured === "daily-default", "custom-journal-template");
    const state = { configuration: configured, pages: {}, template: null, definitions: [] };
    for (const name of PAGE_NAMES) {
      const page = await read(() => sdk.Editor.getPage(name));
      if (page === null) { state.pages[name] = null; continue; }
      requireValue(record(page) && typeof page.name === "string" && page.name.toLowerCase() === name.toLowerCase() &&
        typeof page.uuid === "string" && UUID.test(page.uuid) && page["journal?"] !== true);
      requireValue(page.format === undefined || page.format === "markdown", "unsupported-graph");
      state.pages[name] = { uuid: page.uuid.toLowerCase(), properties: propertyMap(page.properties),
        blocks: cleanTree(await read(() => sdk.Editor.getPageBlocksTree(name))) };
    }
    const rows = await read(() => sdk.DB.datascriptQuery(TEMPLATE_QUERY));
    requireValue(Array.isArray(rows) && rows.length <= 10000);
    for (const row of rows) {
      requireValue(Array.isArray(row) && row.length === 2 && typeof row[0] === "string" && UUID.test(row[0]));
      // Non-string property values may hide a malformed/ref-valued definition.
      // Do not infer absence from them, even if App.getTemplate returns null.
      requireValue(typeof row[1] === "string", "template-conflict");
      if (row[1].trim().toLowerCase() === "daily-default") state.definitions.push(row[0].toLowerCase());
    }
    state.definitions.sort();
    requireValue(state.definitions.length <= 1, "template-conflict");
    const lookup = await read(() => sdk.App.getTemplate("daily-default"));
    if (lookup === null) requireValue(!state.definitions.length, "template-conflict");
    else {
      requireValue(record(lookup) && typeof lookup.uuid === "string" && UUID.test(lookup.uuid));
      requireValue(equal(state.definitions, [lookup.uuid.toLowerCase()]), "template-conflict");
      state.template = cleanTree([await read(() => sdk.Editor.getBlock(lookup.uuid, { includeChildren: true }))])[0];
      requireValue(state.template.uuid === lookup.uuid.toLowerCase());
      let sampled;
      for (const page of Object.values(state.pages)) if (page) walk(page.blocks, (b) => { if (b.uuid === state.template.uuid) sampled = b; });
      requireValue(!sampled || equal(sampled, state.template), "stale-plan");
    }
    // A template located on a sampled page appears twice in state, but counts
    // once toward the source budget. Distinct page trees cannot share identities.
    const roots = Object.values(state.pages).flatMap((page) => page?.blocks ?? []);
    validateBlocks(roots);
    const ids = new Set();
    let size = 0;
    const count = (block, depth) => {
      requireValue(depth < 40);
      if (!ids.has(block.uuid)) { ids.add(block.uuid); size += block.content.length; }
      requireValue(ids.size <= 10000 && size <= 4_000_000);
    };
    walk(roots, count);
    if (state.template) walk([state.template], count);
    canonicalSetupJSON(state);
    requireValue(Date.now() - started < 30000, "read-timeout");
    return state;
  }
  function makeOps(state) {
    const ops = [];
    const used = new Set();
    for (const page of Object.values(state.pages)) if (page) { used.add(page.uuid); walk(page.blocks, (b) => used.add(b.uuid)); }
    if (state.template) walk([state.template], (b) => used.add(b.uuid));
    function identity() { const id = uuid(); requireValue(!used.has(id), "identity-unavailable"); used.add(id); return id; }
    function page(name) { ops.push({ kind: "page", page: name, uuid: identity() }); }
    function block(parent, preset) {
      const id = identity(); ops.push({ kind: "block", parent, preset, uuid: id }); return id;
    }
    for (const [name, prefix, count] of [["Week Routine", "week", 3], ["Month Routine", "month", 4]]) {
      if (state.pages[name]) continue;
      page(name);
      for (let i = 0; i < count; i++) block(name, `${prefix}-${i}`);
    }
    let root = state.template?.uuid;
    if (!root) {
      if (!state.pages.Templates) page("Templates");
      root = block("Templates", "template");
    }
    for (const title of analyze(state)) {
      const section = block(root, `section-${SETUP_SECTIONS.indexOf(title)}`);
      if (["Focus", "Tasks", "Notes"].includes(title)) block(section, "input");
      if (title === "End-of-day review") for (let i = 0; i < 3; i++) block(section, `review-${i}`);
    }
    return ops;
  }
  function childLists(state, parent) {
    if (PAGE_NAMES.includes(parent)) return state.pages[parent] ? [state.pages[parent].blocks] : [];
    const lists = [];
    const visit = (block) => { if (block.uuid === parent) lists.push(block.children); };
    for (const page of Object.values(state.pages)) if (page) walk(page.blocks, visit);
    if (state.template) walk([state.template], visit);
    return lists;
  }
  function undoPending(state, op) {
    const before = clone(state);
    if (op.kind === "page") {
      const page = before.pages[op.page];
      requireValue(page && equal(page.properties, { [key(MARKER)]: op.uuid }), "recovery-conflict");
      // createPage(properties) may materialize a property-only pre-block even
      // with createFirstBlock:false. It is ownership metadata, not a routine.
      requireValue(page.blocks.length <= 1 && page.blocks.every((b) => b.content.trim() === `${MARKER}:: ${op.uuid}` &&
        !b.children.length && equal(b.properties, { [key(MARKER)]: op.uuid })), "recovery-conflict");
      before.pages[op.page] = null;
    } else {
      const lists = childLists(before, op.parent);
      requireValue(lists.length, "recovery-conflict");
      for (const list of lists) {
        const block = list.at(-1);
        const expectedProperties = op.preset === "template" ? { template: "daily-default", templateincludingparent: false } : {};
        // Desktop 0.10.15 adds numeric heading metadata when parsing our ## presets.
        // Accept only that exact derived property; keep it in checkpoint hashes.
        const propertiesMatch = block && (equal(block.properties, expectedProperties) ||
          (op.preset.startsWith("section-") && equal(block.properties, { heading: 2 })));
        requireValue(block?.uuid === op.uuid && block.content === DEFAULTS[op.preset] &&
          !block.children.length && propertiesMatch, "recovery-conflict");
        list.pop();
      }
      if (op.preset === "template") {
        requireValue(before.template?.uuid === op.uuid && equal(before.definitions, [op.uuid]), "recovery-conflict");
        before.template = null;
        before.definitions = [];
      }
    }
    return before;
  }
  function storeKey(graphKey) { return `journal-routines:setup:v1:${graphKey}`; }
  function storageReady() {
    requireValue(!storageUncertain && typeof store?.get === "function" && typeof store?.set === "function", "store-unavailable");
  }
  async function load(graphKey) {
    storageReady();
    const saved = await bounded(() => store.get(storeKey(graphKey)), "store-unavailable", "store-unavailable");
    if (saved === null) return null;
    let value;
    try { value = clone(saved); } catch { throw new SetupError("recovery-conflict"); }
    requireValue(record(value) && value.version === 1 && value.graphKey === graphKey && UUID.test(value.id) && HASH.test(value.hash) &&
      HASH.test(value.opsHash) && Array.isArray(value.ops) && value.ops.length <= 50 &&
      Number.isInteger(value.next) && value.next >= 0 && value.next <= value.ops.length &&
      (value.pending === null || (value.pending === value.next && value.next < value.ops.length)), "recovery-conflict");
    const ids = new Set();
    for (const op of value.ops) {
      requireValue(record(op) && typeof op.uuid === "string" && UUID.test(op.uuid) && !ids.has(op.uuid), "recovery-conflict");
      ids.add(op.uuid);
      requireValue(op.kind === "page" ? PAGE_NAMES.includes(op.page) && Object.keys(op).length === 3 :
        op.kind === "block" && Object.hasOwn(DEFAULTS, op.preset) && typeof op.parent === "string" &&
        (PAGE_NAMES.includes(op.parent) || UUID.test(op.parent)) && Object.keys(op).length === 4, "recovery-conflict");
    }
    requireValue(await digest(value.ops) === value.opsHash, "recovery-conflict");
    return value;
  }
  async function save(value) {
    storageReady();
    try {
      await bounded(() => store.set(storeKey(value.graphKey), clone(value)), "store-unavailable", "store-unavailable");
    } catch {
      storageUncertain = true;
      throw new SetupError("store-unavailable");
    }
  }
  async function reconcile(saved, state) {
    const currentHash = await digest(state);
    if (saved.pending === null) {
      requireValue(currentHash === saved.hash, "recovery-conflict");
      return saved;
    }
    requireValue(currentHash !== saved.hash, "write-uncertain");
    requireValue(await digest(undoPending(state, saved.ops[saved.pending])) === saved.hash, "recovery-conflict");
    return { ...saved, hash: currentHash, next: saved.next + 1, pending: null };
  }
  async function authorize(phase, graphKey, op = null, index = null) {
    const allowed = await bounded(() => guard?.({ phase, graphKey, operation: op ? { kind: op.kind, index } : null }), "guard-denied", "guard-denied");
    requireValue(allowed === true, "guard-denied");
  }
  function prerequisites() {
    storageReady();
    requireValue(typeof guard === "function", "guard-denied");
    requireValue(typeof sdk?.Editor?.createPage === "function" && typeof sdk?.Editor?.insertBlock === "function", "write-api-unavailable");
  }
  function configuration(state) { return state.configuration === "daily-default" ? "daily-default" : "manual-selection-required"; }
  function failure(error) {
    const code = error instanceof SetupError ? error.code : "read-failed";
    return summary("blocked", [], [{ code, message: MESSAGES[code] }]);
  }
  async function inspect() {
    try {
      prerequisites();
      const path = await graphPath(), graphKey = await digest(path);
      const state = await scan(path);
      analyze(state);
      const stored = await load(graphKey);
      const active = stored && stored.next < stored.ops.length;
      const resumed = active ? await reconcile(stored, state) : null;
      const ops = resumed ? resumed.ops : makeOps(state);
      const plan = { path, graphKey, id: resumed?.id ?? uuid(), hash: await digest(state),
        ops, resume: Boolean(resumed) };
      await sameGraph(path);
      const token = Object.freeze(Object.create(null));
      tokens.set(token, plan);
      return { summary: summary(resumed ? "recovery" : ops.length ? "ready" : "complete",
        publicChanges(ops.slice(resumed?.next ?? 0)), [], configuration(state)), token };
    } catch (error) { return { summary: failure(error), token: null }; }
  }
  async function apply(token) {
    try {
      const plan = record(token) ? tokens.get(token) : null;
      requireValue(plan, "invalid-token");
      prerequisites();
      await sameGraph(plan.path);
      await authorize("apply", plan.graphKey);
      let state = await scan(plan.path);
      analyze(state);
      let saved = await load(plan.graphKey);
      if (saved?.id === plan.id) {
        // Completed approvals never replay their writes or refill deleted tasks.
        // Still perform fresh reads/collision checks before reporting completion.
        if (saved.next === saved.ops.length) {
          requireValue(!makeOps(state).length, "stale-plan");
          return { status: "complete", summary: summary("complete", [], [], configuration(state)) };
        }
        const reconciled = await reconcile(saved, state);
        if (!equal(saved, reconciled)) await save(reconciled);
        saved = reconciled;
      } else {
        requireValue(!plan.resume && (!saved || saved.next === saved.ops.length), "stale-plan");
        requireValue(await digest(state) === plan.hash, "stale-plan");
        saved = { version: 1, graphKey: plan.graphKey, id: plan.id, hash: plan.hash,
          opsHash: await digest(plan.ops), ops: plan.ops, next: 0, pending: null };
        await save(saved);
      }
      while (saved.next < saved.ops.length) {
        const op = saved.ops[saved.next];
        await authorize("write", plan.graphKey, op, saved.next);
        state = await scan(plan.path);
        analyze(state);
        requireValue(await digest(state) === saved.hash, "recovery-conflict");
        if (op.kind === "block") {
          await sameGraph(plan.path);
          const existing = await bounded(() => sdk.Editor.getBlock(op.uuid));
          requireValue(existing === null, "recovery-conflict");
        }
        let anchor, sibling;
        if (op.kind === "page") requireValue(state.pages[op.page] === null, "recovery-conflict");
        else {
          const lists = childLists(state, op.parent);
          requireValue(lists.length && lists.every((list) => equal(list, lists[0])), "recovery-conflict");
          anchor = lists[0].at(-1)?.uuid ?? op.parent;
          sibling = lists[0].length > 0;
        }
        // Persist intent BEFORE issuing the remote write. A crash in this gap
        // deliberately requires reconciliation rather than assuming no write.
        saved = { ...saved, pending: saved.next };
        await save(saved);
        try {
          await sameGraph(plan.path);
          // Recheck lifecycle after durable I/O. Scan again if the guard awaited
          // a prompt or dependency reload, so its delay cannot lease stale data.
          await authorize("write", plan.graphKey, op, saved.next);
          const fresh = await scan(plan.path);
          requireValue(await digest(fresh) === saved.hash, "recovery-conflict");
          await sameGraph(plan.path);
          // Disable/dependency invalidation may have occurred during the scan.
          // No more SDK reads or storage awaits between this guard and issuance.
          await authorize("write", plan.graphKey, op, saved.next);
        } catch (error) {
          await save({ ...saved, pending: null }); // Definitely no SDK write issued.
          throw error;
        }
        let failed = false;
        try {
          await bounded(() => op.kind === "page"
            ? sdk.Editor.createPage(op.page, { [MARKER]: op.uuid }, { redirect: false, createFirstBlock: false, format: "markdown", journal: false })
            : sdk.Editor.insertBlock(anchor, DEFAULTS[op.preset], { sibling, before: false, focus: false, customUUID: op.uuid }),
          "write-uncertain", "write-uncertain");
        } catch { failed = true; }
        // A null return or rejection is not proof of failure. Reconcile actual
        // persisted graph state; never trust a returned projection/entity alone.
        state = await scan(plan.path);
        saved = await reconcile(saved, state);
        await save(saved);
        if (failed) return { status: "interrupted", summary: summary("interrupted", [],
          [{ code: "write-uncertain", message: "The write was observed and checkpointed after an SDK failure; approve resuming the remaining additions." }], configuration(state)) };
      }
      state = await scan(plan.path);
      requireValue(await digest(state) === saved.hash && analyze(state).length === 0 &&
        PAGE_NAMES.slice(0, 2).every((name) => state.pages[name]), "recovery-conflict");
      await sameGraph(plan.path);
      return { status: "complete", summary: summary("complete", [], [], configuration(state)) };
    } catch (error) { return { status: "blocked", summary: failure(error) }; }
  }
  return Object.freeze({ inspect: () => serial(inspect), apply: (token) => serial(() => apply(token)) });
}
