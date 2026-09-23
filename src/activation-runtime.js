import { createActivationStorage, graphIdentity } from "./activation-storage.js";
import { mountActivationView } from "./activation-view.js";
import { createCalendarClient } from "./calendar-client.js";
import { createJournalAdapter } from "./journal-adapter.js";
import { createJournalWriter } from "./journal-writer.js";
import { createRoutineSidebar } from "./routine-sidebar.js";
import { createSetupService } from "./setup-service.js";
import { normalizeBlock, normalizePage } from "./graph-normalize.js";
import { blockProperty } from "./journal-model.js";
import { canonicalSetupJSON } from "./setup-plan.js";

const ACTIVATION = "journal-routines:activation:v1:";
const RECOVERY = "journal-routines:writer:v1:";
const CLAIMS = `[:find ?uuid ?name ?loaded
 :where [?b :block/uuid ?uuid] [?b :block/page ?page] [?page :block/name ?name]
 [?b :block/properties ?props] [(get ?props :routine-loaded) ?loaded]]`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_OPERATIONS = {
  "graph-read": "App.getCurrentGraph (graph identity)",
  "configuration-read": "App.getCurrentGraphConfigs (journal configuration)",
  "page-read": "Editor.getPage (source page)",
  "tree-read": "Editor.getPageBlocksTree (source tree)",
  "current-page-read": "Editor.getCurrentPage (navigation target)",
  "owner-query": "DB.datascriptQuery (routine owner claims)",
  "journal-query": "DB.datascriptQuery (native journal date)",
  "inventory-read": "Editor.getAllPages (discovery inventory)",
  "routine-read": "Editor.getPage (routine definition lookup)",
  "block-read": "Editor.getBlock (expanded child lookup)",
};
const READ_MESSAGES = Object.fromEntries(Object.entries(READ_OPERATIONS).flatMap(([key, method]) => [
  [`${key}-failed`, `${method} failed [${key}-failed]. This identifies the SDK call, not damaged notes; do not delete pages.`],
  [`${key}-timeout`, `${method} did not respond within the read deadline [${key}-timeout]. No incomplete result was accepted.`],
]));
const SHAPE_MESSAGES = Object.fromEntries(Object.entries({
  "configuration-shape": "The default-templates configuration is not a map or null",
  "tree-shape": "A source block tree is not an expanded array",
  "owner-query-shape": "The owner query did not return a row array",
  "owner-row-shape": "An owner query row does not have the expected three fields",
  "owner-uuid-shape": "An owner query UUID is not a UUID string",
  "owner-name-shape": "An owner query page name is not a nonempty string",
  "owner-period-shape": "An owner query period is not a string",
  "journal-query-shape": "The native journal query did not return a row array",
  "journal-row-shape": "The native journal query did not return a single UUID field per row",
}).map(([key, message]) => [key, `${message} [${key}]. The response shape needs compatibility review; no values or note contents are exposed.`]));
const WRITER_MESSAGES = Object.fromEntries(Object.entries({
  "busy": "Another call is using this journal writer",
  "invalid-plan": "The journal plan failed validation before execution",
  "invalid-data": "Journal execution encountered unsupported data or an internal failure",
  "operation-limit": "The journal plan exceeds the bounded operation budget",
  "unsafe-insert": "The plan requests an insertion outside the writer's permitted scope",
  "unsafe-move": "The plan requests a move the writer cannot safely perform",
  "unsafe-remove": "The plan requests a deletion the writer cannot safely perform",
  "unsafe-update": "The plan requests a text change outside the writer's permitted scope",
  "unsafe-loaded-transition": "The plan would change an existing routine-owner marker",
  "unsafe-order": "The compiled operations do not reproduce the approved block order",
  "uuid-collision": "A proposed new block identity is not confirmed absent",
  "guard-failed": "The journal write safety check failed or timed out",
  "guard-denied": "The journal write safety check no longer authorizes this operation",
  "historical-journal": "The target journal is now in the past",
  "future-routine-write": "The plan would write routine tasks into a future journal",
  "page-conflict": "The target page identity or journal date changed",
  "block-conflict": "Block identity or page-membership verification failed",
  "read-failed": "A writer SDK read failed or its response could not be normalized",
  "read-limit": "A writer read exceeds the bounded block or text budget",
  "unsupported-tree": "The writer cannot verify the returned tree shape or depth",
  "precondition-conflict": "The target journal does not match the expected state before continuing",
  "uncertain-outcome": "An SDK write failed, timed out, or its expected result was not verified",
  "invalid-recovery-record": "The saved writer checkpoint does not match the original plan",
  "recovery-store-failed": "Durable writer checkpoint storage failed",
  "recovery-store-uncertain": "A checkpoint storage operation has an uncertain outcome; this writer is stopped",
}).map(([reason, message]) => [`writer-${reason}`,
  `${message} [writer-${reason}]. Keep this session open and preserve existing content and any checkpoint; do not clear storage to retry.`]));
const MESSAGES = {
  ...READ_MESSAGES,
  ...SHAPE_MESSAGES,
  ...WRITER_MESSAGES,
  "runtime-unexpected": "An unexpected plugin operation failed [runtime-unexpected]. This is not evidence of graph corruption; do not delete pages.",
  "calendar-unavailable": "Enable or reload Persian Calendar, then refresh status. Enabled intent is preserved.",
  "locks-unavailable": "Web Locks are unavailable in this host. Writes are disabled because cross-window serialization cannot be established.",
  "lock-busy": "Another Journal window is working on this graph. Wait for it to finish; Journal will retry.",
  "storage-unavailable": "Durable activation storage failed. Check browser/plugin storage before refreshing; no memory-only fallback is used.",
  "invalid-activation": "Activation metadata is invalid. Restore the plugin storage from backup before enabling.",
  "disable-not-persisted": "This session is stopped, but Disable was not saved. Retry Disable after fixing durable storage. Avoid reloading the plugin until it succeeds; the older enabled intent is still stored.",
  "graph-changed": "The graph changed. Refresh status in the intended graph.",
  "date-changed": "Calendar's day changed. Journal will recheck the new day.",
  "source-changed": "Routine definitions or owner evidence changed. Wait for indexing, then refresh status; unfinished work is retained.",
  "read-failed": "A required graph read failed or has an unsupported shape. Wait for indexing and refresh status.",
  "scan-blocked": "Full owner discovery could not establish a safe plan. Resolve duplicate, ambiguous or unsupported journal/routine data, then refresh status.",
  "scan-throttled": "The automatic discovery cooldown is active (up to one minute). No new scan was attempted. Refresh status runs a fresh check; this message does not mean graph content changed.",
  "invalid-page": "Page metadata could not be verified [invalid-page]. This may be a Desktop response-shape incompatibility, not damaged notes. Do not delete pages to resolve it.",
  "invalid-block": "Block metadata could not be verified [invalid-block]. Do not delete blocks; the Desktop response needs investigation.",
  "invalid-graph": "The current graph identity could not be verified [invalid-graph].",
  "malformed-response": "Logseq returned an unsupported read response [malformed-response]. No partial scan was accepted.",
  "unsupported-format": "The graph contains a format this Markdown collector cannot safely inspect [unsupported-format].",
  "conflicting-aliases": "SDK metadata contains conflicting identity or property aliases [conflicting-aliases].",
  "conflicting-properties": "Managed block properties disagree with their content [conflicting-properties]. Preserve the blocks for review.",
  "duplicate-period-owner": "Multiple blocks claim the same weekly or monthly period [duplicate-period-owner]. Preserve them for owner review; do not delete pages.",
  "non-journal-period-owner": "A non-journal page claims a requested routine period [non-journal-period-owner].",
  "future-period-owner": "A future journal claims a requested routine period [future-period-owner].",
  "owner-outside-period": "A routine owner is on a journal outside its claimed period [owner-outside-period].",
  "invalid-period-owner": "A routine owner is nested or has conflicting section identity [invalid-period-owner].",
  "incomplete-owner-scan": "The complete owner inventory could not be established [incomplete-owner-scan].",
  "duplicate-page": "The SDK inventory contains duplicate page identities [duplicate-page].",
  "duplicate-journal": "More than one page claims the same native journal date [duplicate-journal].",
  "duplicate-block": "A block identity appeared more than once in the scan [duplicate-block].",
  "mismatched-block": "A resolved block does not match its requested identity [mismatched-block].",
  "wrong-block-page": "A block's page metadata conflicts with its tree [wrong-block-page].",
  "invalid-routine-page": "A routine definition page has an incompatible identity [invalid-routine-page].",
  "duplicate-section": "Duplicate journal sections need review [duplicate-section]. Existing sections were preserved.",
  "conflicting-section": "Journal section identities conflict [conflicting-section]. Existing sections were preserved.",
  "unmarked-routine-content": "A populated routine section has no loaded marker [unmarked-routine-content]. Tasks were not copied again.",
  "customized-reference": "A generated task reference has user modifications [customized-reference]. They were preserved.",
  "scan-limit": "The graph exceeds the bounded discovery budget [scan-limit]. No truncated scan was accepted; do not delete notes to fit the limit.",
  "scan-timeout": "Full owner discovery exceeded its time limit [scan-timeout]. No partial plan was accepted.",
  "read-timeout": "A Logseq read timed out [read-timeout]. Let indexing settle, then refresh status.",
  "graph-edited": "Database changes interrupted discovery [graph-edited]. Let indexing settle, then refresh status.",
  "inventory-changed": "The page inventory changed during discovery [inventory-changed]. Let indexing settle, then refresh status.",
  "setup-required": "Review the setup additions and all three confirmations before enabling.",
  "setup-blocked": "Setup could not complete safely. Refresh the setup review; preserve any recovery checkpoint.",
  "configuration-required": "Resources are ready. Journal template selection could not be verified. Refresh status after configuration has settled; unrelated settings were not intentionally changed.",
  "configuration-uncertain": "Journal template configuration was issued but not confirmed. Reload after it settles and review configuration before enabling; this session will not repeat the write.",
  "waiting-native-journal": "Open today's journal in Logseq so the host creates it and applies daily-default. Journal will resume on creation; no native page name or date metadata is guessed.",
  "recovery-plan-required": "An unfinished journal write needs its original private plan, which is unavailable after restart. Do not clear its checkpoint or regenerate a plan. Review the disposable graph/backup before explicit recovery.",
  "writer-blocked": "A journal write could not be verified. Original work and its checkpoint are retained; refresh to reconcile, never delete the checkpoint to force a retry.",
  "approval-required": "Confirm backup, absence of overlapping legacy journal automation, and disposable-first/live-safety acknowledgment before applying.",
  "subscription-unavailable": "Required graph/navigation/database subscriptions are unavailable. Automatic writes are paused.",
  "cancelled": "Work was cancelled. Already-issued SDK calls cannot be undone; any uncertain checkpoint is retained.",
};
const failure = (code) => Object.assign(new Error(code), { code });
const requireValue = (value, code) => { if (!value) throw failure(code); };
const copy = (value) => structuredClone(value);
const equal = (a, b) => canonicalSetupJSON(a) === canonicalSetupJSON(b);
const defaults = () => ({ version: 1, configured: false, enabled: false, sidebar: true, approved: false });

/**
 * Controller API: start(): Promise<status>, open(), refresh(), enable(approvals),
 * disable(), setSidebar(boolean), getStatus(), whenIdle(), destroy(). UI callbacks
 * use the same public actions. start never opens a preview/modal automatically.
 *
 * All injected factories have the corresponding production module's interface.
 * storage is raw get/set; only the writer gets the prefixed load/save adapter.
 * Private original plans/evidence live in memory, never in activation records.
 * Web Locks coordinate cooperating windows in this origin, NOT users/legacy code
 * or another origin/profile. Reads are not transactions; in-flight SDK calls and
 * delayed indexing remain races. Desktop write behavior is still live-unverified.
 *
 * Automatic full scans are limited to once/minute. Explicit Refresh/Enable
 * permit one fresh scan; approved setup changes also require rediscovery.
 * Successful evidence is cached for 15 minutes per target (today
 * and the current future page). Other events compare bounded indexed claims,
 * definitions, historical owner trees and the target, not every page in the graph.
 */
export function createActivationRuntime({
  sdk, document,
  storage = createActivationStorage(),
  locks = globalThis.navigator?.locks,
  calendar = createCalendarClient({ invoke: (...args) => sdk.App.invokeExternalPlugin(...args) }),
  mount = mountActivationView,
  setupFactory = createSetupService, adapterFactory = createJournalAdapter,
  writerFactory = createJournalWriter, sidebarFactory = createRoutineSidebar,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  pollMs = 60_000, debounceMs = 750, scanIntervalMs = 60_000, cacheMs = 900_000,
  readTimeoutMs = 3000,
} = {}) {
  for (const value of [pollMs, debounceMs, scanIntervalMs, cacheMs, readTimeoutMs]) {
    requireValue(Number.isInteger(value) && value > 0 && value <= 2_147_483_647, "read-failed");
  }
  let started = false, destroyed = false, generation = 0, queue = Promise.resolve();
  let graph = null, record = defaults(), view, review = null, authority = null;
  let status = { status: "setup-required", message: MESSAGES["setup-required"], reason: "setup-required",
    configured: false, sidebar: true, canEnable: false, summary: null };
  let poll, debounce, midnight, graphOff, workHooks = [], visible = false;
  let lastScan = -Infinity, lastScanFailure = null, scanning = null, scheduled = false, enabling = null;
  const uncertainConfiguration = new Set();
  const caches = new Map(), originals = new Map(), explicitOff = new Set();
  const recoveryStore = {
    load: (key) => read(() => storage.get(RECOVERY + key), "storage-unavailable"),
    save: (key, value) => read(() => storage.set(RECOVERY + key, value), "storage-unavailable"),
  };
  const adapter = adapterFactory({ sdk });
  const setup = setupFactory({ sdk, store: storage, guard: setupGuard });
  const writer = writerFactory({ sdk, recoveryStore, guard: writerGuard });
  const sidebar = sidebarFactory({ sdk, guard: async ({ graphKey }) => {
    try { await validate(authority, true); return record.sidebar && graphKey === graph?.key; } catch { return false; }
  } });

  async function read(fn, code = "read-failed") {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimer(() => reject(failure(Object.hasOwn(READ_MESSAGES, code) ? code.replace(/-failed$/, "-timeout") : code)), readTimeoutMs);
      })]);
    } catch (error) {
      const timeoutCode = code.replace(/-failed$/, "-timeout");
      throw failure(Object.hasOwn(READ_MESSAGES, timeoutCode) && error?.code === timeoutCode ? timeoutCode : code);
    }
    finally { clearTimer(timer); }
  }
  function live(token) { requireValue(!destroyed && token === generation, "cancelled"); }
  function render(next) {
    if (destroyed) return;
    status = { ...status, configured: record.configured, sidebar: record.sidebar, ...next };
    view?.render(copy(status));
  }
  function paused(code) {
    const reason = Object.hasOwn(MESSAGES, code) ? code : "runtime-unexpected";
    render({ status: "paused", reason, message: MESSAGES[reason], canEnable: false });
  }
  function enqueue(fn) {
    const token = generation;
    const work = queue.then(async () => {
      if (destroyed || token !== generation) return;
      try { await fn(token); }
      catch (error) { if (!destroyed && token === generation) paused(error?.code); }
      return getStatus();
    });
    queue = work.catch(() => {});
    return work;
  }
  function getStatus() { return copy(status); }
  function cancel() {
    generation++;
    review = null;
    authority = null;
    scanning?.abort();
    adapter.invalidate();
    void calendar.invalidate();
    sidebar.reset();
    clearTimer(debounce); debounce = null;
  }
  function stopWork() {
    clearTimer(poll); clearTimer(midnight); clearTimer(debounce);
    poll = midnight = debounce = null;
    for (const off of workHooks.splice(0)) { try { off(); } catch { /* Attempt every cleanup. */ } }
  }
  async function identity(token) {
    const value = await read(() => graphIdentity(sdk), "graph-read-failed");
    live(token);
    return value;
  }
  function validateRecord(value) {
    if (value === null) return defaults();
    requireValue(value?.version === 1 && ["configured", "enabled", "sidebar", "approved"].every((key) => typeof value[key] === "boolean") &&
      (!value.enabled || (value.configured && value.approved)), "invalid-activation");
    return { version: 1, ...Object.fromEntries(["configured", "enabled", "sidebar", "approved"].map((key) => [key, value[key]])) };
  }
  async function loadGraph(token) {
    const next = await identity(token);
    if (graph?.key !== next.key) {
      stopWork(); caches.clear(); lastScan = -Infinity; lastScanFailure = null; review = null;
      graph = next;
    }
    record = validateRecord(await read(() => storage.get(ACTIVATION + next.key), "storage-unavailable"));
    if (explicitOff.has(next.key)) {
      const unsaved = record.enabled;
      record.enabled = false;
      requireValue(!unsaved, "disable-not-persisted");
    }
    live(token);
    return next;
  }
  async function persist(value, key = graph.key) {
    await read(() => storage.set(ACTIVATION + key, value), "storage-unavailable");
    if (graph?.key === key) record = value;
  }
  async function today() { return read(() => calendar.describeToday(), "calendar-unavailable"); }
  async function validate(context, enabled) {
    requireValue(context, "cancelled"); live(context.token);
    requireValue((await identity(context.token)).key === context.key, "graph-changed");
    const saved = validateRecord(await read(() => storage.get(ACTIVATION + context.key), "storage-unavailable"));
    if (enabled) requireValue(!explicitOff.has(context.key) && record.enabled && saved.enabled && saved.configured && saved.approved, "cancelled");
    else requireValue(context.approved === true, "approval-required");
    const day = await today();
    requireValue(day.gregorian.journalDay === context.day, "date-changed");
    if (enabled) requireValue(await read(() => sdk.App.getCurrentGraphConfigs("default-templates", "journals"), "configuration-read-failed") === "daily-default", "configuration-required");
    requireValue((await identity(context.token)).key === context.key, "graph-changed");
    live(context.token);
    return day;
  }
  async function locked(token, fn) {
    requireValue(typeof locks?.request === "function", "locks-unavailable");
    const key = graph.key;
    return locks.request(`journal-routines:write:v1:${key}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      live(token); requireValue(lock, "lock-busy");
      requireValue((await identity(token)).key === key, "graph-changed");
      return fn();
    });
  }

  function tree(raw) {
    let count = 0, chars = 0;
    const seen = new Set();
    function visit(list, depth = 0) {
      requireValue(Array.isArray(list), "tree-shape");
            requireValue(depth <= 40, "scan-limit");
      return list.map((item) => {
        requireValue(++count <= 10000, "scan-limit");
        const b = normalizeBlock(item);
        chars += b.content.length;
        requireValue(chars <= 4_000_000, "scan-limit");
                requireValue(!seen.has(b.uuid.toLowerCase()), "duplicate-block");
        seen.add(b.uuid.toLowerCase());
        return { uuid: b.uuid, content: b.content, children: visit(b.children, depth + 1) };
      });
    }
    return visit(raw);
  }
  async function pageTree(name) {
    const raw = await read(() => sdk.Editor.getPage(name), "page-read-failed");
    if (raw === null) return null;
    const page = normalizePage(raw);
    requireValue(page.name.toLowerCase() === name.toLowerCase(), "source-changed");
    return { page, blocks: tree(await read(() => sdk.Editor.getPageBlocksTree(page.uuid), "tree-read-failed")) };
  }
  async function claims(keys, excludedName) {
    const rows = await read(() => sdk.DB.datascriptQuery(CLAIMS), "owner-query-failed");
    requireValue(Array.isArray(rows), "owner-query-shape");
    requireValue(rows.length <= 10000, "scan-limit");
    const result = [], seen = new Set();
    for (const row of rows) {
      requireValue(Array.isArray(row) && row.length === 3, "owner-row-shape");
      requireValue(typeof row[0] === "string" && UUID.test(row[0]), "owner-uuid-shape");
      requireValue(typeof row[1] === "string" && row[1].trim(), "owner-name-shape");
      requireValue(typeof row[2] === "string", "owner-period-shape");
      const [uuid, name, loaded] = row;
      requireValue(!seen.has(uuid.toLowerCase()), "source-changed"); seen.add(uuid.toLowerCase());
      if (keys.includes(loaded) && name.toLowerCase() !== excludedName?.toLowerCase()) result.push([uuid.toLowerCase(), name.toLowerCase(), loaded]);
    }
    return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  function expectedClaims(snapshot, keys, excludedName) {
    const rows = [];
    function visit(blocks, name) {
      for (const block of blocks) {
        const loaded = blockProperty(block, "routine-loaded");
        if (keys.includes(loaded)) rows.push([block.uuid.toLowerCase(), name.toLowerCase(), loaded]);
        visit(block.children ?? [], name);
      }
    }
    for (const page of snapshot.pages) if (page.name.toLowerCase() !== excludedName?.toLowerCase()) visit(page.blocks, page.name);
    return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  async function evidence(result, description, setupOnly = false) {
    const snapshot = result.snapshot;
    requireValue(snapshot?.ownerScanComplete, "scan-blocked");
    const keys = [description.week.key, description.month.key];
    const target = snapshot.pages.find((page) => page.journalDay === snapshot.journalDay);
    const excluded = setupOnly ? null : target?.name;
    const expected = expectedClaims(snapshot, keys, excluded);
    const observed = await claims(keys, excluded);
    requireValue(equal(expected, observed), "source-changed");
    const sources = [];
    for (const name of [...new Set(expected.map((row) => row[1]))]) {
      const fresh = await pageTree(name);
      const original = snapshot.pages.find((page) => page.name.toLowerCase() === name);
      requireValue(fresh && original && fresh.page.journalDay === original.journalDay && equal(fresh.blocks, original.blocks), "source-changed");
      sources.push({ name, value: fresh });
    }
    if (!setupOnly) for (const [kind, name] of [["weekly", "Week Routine"], ["monthly", "Month Routine"]]) {
      const fresh = await pageTree(name);
      requireValue(equal(fresh?.blocks ?? null, snapshot.routines[kind]), "source-changed");
      sources.push({ name, value: fresh });
    }
    return { keys, excluded, claims: observed, sources };
  }
  async function checkEvidence(value) {
    requireValue(value && equal(await claims(value.keys, value.excluded), value.claims), "source-changed");
    for (const source of value.sources) requireValue(equal(await pageTree(source.name), source.value), "source-changed");
  }
  async function setupGuard({ graphKey }) {
    try {
      requireValue(authority?.key === graphKey, "graph-changed");
      await validate(authority, false);
      await checkEvidence(authority.evidence);
      await validate(authority, false);
      return true;
    } catch { return false; }
  }
  async function writerGuard({ graphKey, pageUuid, journalDay }) {
    try {
      const context = authority;
      requireValue(context?.key === graphKey && context.input?.pageUuid === pageUuid && context.input.snapshot.journalDay === journalDay, "cancelled");
      await validate(context, true);
      await checkEvidence(context.evidence);
      const day = await validate(context, true);
      return { allowed: true, graphKey, todayJournalDay: day.gregorian.journalDay };
    } catch { return { allowed: false }; }
  }
  async function scan(token, day, request = {}) {
    live(token);
    if (!request.manual && now() - lastScan < scanIntervalMs) {
      // A skipped scan is not a new failure and must not hide the last cause.
      throw failure(lastScanFailure?.day === day ? lastScanFailure.reason : "scan-throttled");
    }
    // One explicit refresh permits one scan, not a bypass for all queued targets.
    request.manual = false;
    lastScan = now();
    scanning = new AbortController();
    try {
      const result = await adapter.inspect({ journalDay: day, signal: scanning.signal });
      live(token);
      if (!["planned", "waiting"].includes(result?.status)) {
        // Adapter reasons are fixed, sanitized codes. Preserve a known code so
        // the user can resolve the actual collision instead of seeing only the
        // generic scan-blocked message; never surface host/graph error text.
        const safeReason = Object.hasOwn(MESSAGES, result?.reason) ? result.reason : "scan-blocked";
        lastScanFailure = { day, reason: safeReason };
        throw failure(safeReason);
      }
      lastScanFailure = null;
      return result;
    } finally { scanning = null; }
  }
  async function description(day, current) {
    if (day === current.gregorian.journalDay) return current;
    return read(async () => calendar.describeDate(await calendar.fromJournalDay(day)), "calendar-unavailable");
  }
  async function inspect(token) {
    await loadGraph(token);
    review = null;
    render({ status: "checking", canEnable: false, summary: null, message: "Checking setup and Calendar." });
    await today();
    const result = await setup.inspect(); live(token);
    requireValue((await identity(token)).key === graph.key, "graph-changed");
    const templates = await read(() => sdk.App.getCurrentGraphConfigs("default-templates"), "configuration-read-failed");
    requireValue(templates === null || (typeof templates === "object" && !Array.isArray(templates)), "configuration-shape");
    review = { ...result, templates: copy(templates ?? {}), key: graph.key, tokenGeneration: token };
    if (result.token && result.summary.configuration === "manual-selection-required" && typeof sdk.App.setCurrentGraphConfigs === "function") {
      result.summary = { ...result.summary, configuration: "selection-on-enable", changes: [...result.summary.changes,
        { title: "Select daily-default for new journals", content: "Set only the journals entry in default-templates; preserve other template entries and all unrelated graph settings." }] };
    }
    const allowed = Boolean(result.token) && result.summary.blockers.length === 0 && typeof locks?.request === "function";
    render({ status: record.enabled ? "enabled" : allowed ? "ready" : "setup-required", summary: result.summary,
      reason: allowed ? null : "setup-required", canEnable: allowed,
      message: typeof locks?.request !== "function" ? MESSAGES["locks-unavailable"] :
        "Review additions before approval. Backup and legacy declarations are not verified; use a disposable graph first. Desktop writer safety is not live-verified by this plugin." });
  }
  async function enableWork(token, approvals, capturedReview) {
    requireValue(["backupConfirmed", "legacyAutomationDisabled", "liveSafetyAcknowledged"].every((key) => approvals?.[key] === true), "approval-required");
    requireValue(capturedReview?.token && capturedReview.tokenGeneration === token && capturedReview.key === graph?.key, "setup-required");
    render({ status: "enabling", canEnable: false, message: "Applying reviewed resources; activation follows only after verification." });
    await locked(token, async () => {
      const current = await today();
      // Setup needs a complete owner discovery too, but its own service guards
      // routine/template mutations, so those resources are not self-invalidating.
      const result = await scan(token, current.gregorian.journalDay, { manual: true });
      authority = { token, key: graph.key, day: current.gregorian.journalDay, approved: true,
        evidence: await evidence(result, current, true) };
      const applied = await setup.apply(capturedReview.token); live(token);
      render({ summary: applied.summary });
      requireValue(applied.status === "complete", "setup-blocked");
      await validate(authority, false);
      if (applied.summary.configuration !== "daily-default") {
        requireValue(!uncertainConfiguration.has(graph.key), "configuration-uncertain");
        requireValue(typeof sdk.App.setCurrentGraphConfigs === "function", "configuration-required");
        const before = await read(() => sdk.App.getCurrentGraphConfigs("default-templates"), "configuration-read-failed");
        requireValue(equal(before ?? {}, capturedReview.templates), "source-changed");
        requireValue(!before?.journals, "configuration-required");
        await validate(authority, false);
        // Verified 0.10.15 API: replaces top-level config entries. Merge the
        // reviewed default-templates map, never replace the whole graph config.
        uncertainConfiguration.add(graph.key);
        const desired = { ...(before ?? {}), journals: "daily-default" };
        await read(() => sdk.App.setCurrentGraphConfigs({ "default-templates": desired }), "configuration-uncertain");
        await validate(authority, false);
        requireValue(equal(await read(() => sdk.App.getCurrentGraphConfigs("default-templates"), "configuration-read-failed"), desired), "configuration-uncertain");
        uncertainConfiguration.delete(graph.key);
      }
      const verified = await setup.inspect(); live(token);
      requireValue(verified.token && verified.summary.status === "complete" && verified.summary.configuration === "daily-default", "setup-blocked");
      render({ summary: verified.summary });
      await validate(authority, false);
      await persist({ ...record, configured: true, approved: true, enabled: true }); live(token);
      explicitOff.delete(graph.key);
      review = null; caches.clear();
      // Approved setup is the one rate-limit exception: its resource writes
      // changed engine inputs. Never execute its pre-setup projection.
      lastScan = -Infinity;
      startWork();
      await runLocked(token);
    });
  }
  async function runTarget(token, day, current, request) {
    const key = graph.key;
    const pending = await recoveryStore.load(key); live(token);
    let job = originals.get(key), cached = caches.get(day);
    if (pending) {
      requireValue(job, "recovery-plan-required");
      requireValue(job.day === current.gregorian.journalDay, "date-changed");
    } else {
      originals.delete(key); job = null;
      // Native date identity comes from Logseq's index, never a constructed name.
      // In particular, waiting for creation must not inventory every page per tick.
      // Ordinary journal blocks can also carry journal-day; only named entities are pages.
      const native = await read(() => sdk.DB.datascriptQuery(`[:find ?uuid :where [?p :block/name] [?p :block/journal-day ${day}] [?p :block/uuid ?uuid]]`), "journal-query-failed");
      requireValue(Array.isArray(native), "journal-query-shape");
      requireValue(native.every((row) => Array.isArray(row) && row.length === 1 && typeof row[0] === "string" && UUID.test(row[0])), "journal-row-shape");
      requireValue(native.length <= 1, "duplicate-journal");
      requireValue(native.length === 1, "waiting-native-journal");
      const targetDescription = await description(day, current);
      if (cached && now() - cached.at < cacheMs) {
        try {
          await checkEvidence(cached.evidence);
          if (equal(await pageTree(cached.name), cached.target)) {
            if (lastScanFailure?.day === day) lastScanFailure = null;
            if (record.sidebar && cached.sidebarPending) {
              await sidebar.sync({ graphKey: key, owners: cached.owners, enabled: true });
              cached.sidebarPending = false;
            }
            return;
          }
        } catch { /* Changed evidence requires a new complete discovery, never a stale write. */ }
      }
      const result = await scan(token, day, request);
      if (result.status === "waiting") throw failure("waiting-native-journal");
      const target = result.snapshot.pages.find((page) => page.journalDay === day);
      requireValue(target, "waiting-native-journal");
      const fresh = await pageTree(target.name);
      requireValue(fresh && fresh.page.journalDay === day && equal(fresh.blocks, target.blocks), "source-changed");
      job = { key, day: current.gregorian.journalDay,
        input: { snapshot: result.snapshot, plan: result.plan, graphKey: key, pageUuid: fresh.page.uuid },
        evidence: await evidence(result, targetDescription), name: target.name };
      originals.set(key, job);
    }
    authority = { ...job, token };
    await validate(authority, true);
    await checkEvidence(job.evidence);
    const result = await writer.apply(job.input); live(token);
    const writerReason = typeof result.reason === "string" && Object.hasOwn(WRITER_MESSAGES, `writer-${result.reason}`)
      ? `writer-${result.reason}` : "writer-blocked";
    requireValue(["applied", "noop"].includes(result.status), result.reason === "recovery-plan-required" ? result.reason : writerReason);
    originals.delete(key);
    const target = await pageTree(job.name);
    requireValue(target && equal(target.blocks, job.input.plan.nextJournal.blocks), "source-changed");
    caches.set(job.input.snapshot.journalDay, { at: now(), name: job.name, target, evidence: job.evidence,
      owners: job.input.plan.owners, emptyRoutine: job.input.plan.warnings?.some((warning) =>
        ["weekly-routine-page-empty", "monthly-routine-page-empty"].includes(warning)) === true });
    if (record.sidebar) await sidebar.sync({ graphKey: key, owners: job.input.plan.owners, enabled: true });
  }
  async function runLocked(token, request = {}) {
    const key = graph.key;
    const saved = validateRecord(await read(() => storage.get(ACTIVATION + key), "storage-unavailable"));
    live(token);
    if (!saved.enabled) { record = saved; stopWork(); render({ status: "disabled", canEnable: false, message: "Automatic work is disabled.", reason: null }); return; }
    const current = await today();
    authority = { token, key, day: current.gregorian.journalDay };
    await validate(authority, true);
    const check = await setup.inspect(); live(token);
    requireValue(check.token && check.summary.status === "complete" && check.summary.configuration === "daily-default", "setup-required");
    let waiting = false;
    try { await runTarget(token, current.gregorian.journalDay, current, request); }
    catch (error) { if (error.code !== "waiting-native-journal") throw error; waiting = true; }
    const raw = await read(() => sdk.Editor.getCurrentPage(), "current-page-read-failed");
    if (raw !== null) {
      const page = normalizePage(raw);
      if (page.journalDay > current.gregorian.journalDay) await runTarget(token, page.journalDay, current, request);
    }
    live(token);
    // Bound the cache to today's and the currently visited future journal.
    while (caches.size > 2) caches.delete(caches.keys().next().value);
    if (waiting) { paused("waiting-native-journal"); return; }
    const warning = caches.get(current.gregorian.journalDay)?.emptyRoutine
      ? " An existing routine definition is empty: add your own tasks there if desired; Journal will not refill it with presets." : "";
    render({ status: "enabled", reason: null, message: `Automatic today/future journal work is enabled. Live Desktop safety checks remain your responsibility.${warning}`, canEnable: false });
  }
  async function run(token, request = {}) {
    await loadGraph(token);
    if (!record.enabled) { stopWork(); render({ status: record.configured ? "disabled" : "setup-required", reason: null, message: "Open Journal & Routines to review setup or enable.", canEnable: false }); return; }
    startWork();
    await locked(token, () => runLocked(token, request));
  }
  function schedule() {
    if (destroyed || !record.enabled || debounce != null || scheduled) return;
    debounce = setTimer(() => {
      debounce = null; scheduled = true;
      void enqueue(run).finally(() => { scheduled = false; });
    }, debounceMs);
  }
  function armClock() {
    if (destroyed || !record.enabled) return;
    clearTimer(poll); clearTimer(midnight);
    poll = setTimer(() => { schedule(); armClock(); }, pollMs);
    const date = new Date(now());
    const next = new Date(date); next.setHours(24, 0, 0, 0);
    midnight = setTimer(() => { schedule(); armClock(); }, Math.max(1, next.getTime() - date.getTime() + 50));
  }
  function startWork() {
    if (workHooks.length || destroyed || !record.enabled) return;
    try {
      for (const [object, method] of [[sdk.App, "onRouteChanged"], [sdk.DB, "onChanged"]]) {
        const off = object[method](schedule);
        requireValue(typeof off === "function", "subscription-unavailable"); workHooks.push(off);
      }
      const resume = () => { if (document?.visibilityState !== "hidden") schedule(); };
      for (const [target, name] of [[document, "visibilitychange"], [document?.defaultView, "focus"], [document?.defaultView, "pageshow"]]) {
        if (!target?.addEventListener) continue;
        target.addEventListener(name, resume); workHooks.push(() => target.removeEventListener(name, resume));
      }
      armClock();
    } catch { stopWork(); throw failure("subscription-unavailable"); }
  }
  function refresh() {
    return enqueue(async (token) => {
      await inspect(token);
      if (record.enabled) await run(token, { manual: true });
      else if (lastScanFailure && review?.token) {
        // Failed pre-setup discovery has no enabled scheduler to retry it.
        // Refresh is read-only here: never retain approval or call setup.apply.
        const current = await today();
        await scan(token, current.gregorian.journalDay, { manual: true });
      }
    });
  }
  function open() {
    if (destroyed) return Promise.resolve();
    visible = true; sdk.showMainUI({ autoFocus: true }); view?.focus();
    return refresh();
  }
  function close() { visible = false; sdk.hideMainUI({ restoreEditingCursor: true }); }
  function enable(approvals) {
    if (enabling) return enabling;
    const capturedReview = review, capturedApprovals = copy(approvals);
    review = null;
    enabling = enqueue((token) => enableWork(token, capturedApprovals, capturedReview)).finally(() => { enabling = null; });
    return enabling;
  }
  function disable() {
    const key = graph?.key;
    const disabled = { ...record, enabled: false };
    if (key) explicitOff.add(key);
    cancel(); stopWork(); record = disabled;
    render({ status: "disabled", reason: null, message: "Stopping new work. Already-issued SDK calls may still finish; checkpoints are preserved.", canEnable: false });
    return enqueue(async (token) => {
      const target = key ?? (await identity(token)).key;
      explicitOff.add(target);
      const saved = key ? disabled : { ...validateRecord(await read(() => storage.get(ACTIVATION + target), "storage-unavailable")), enabled: false };
      await persist(saved, target);
    });
  }
  function setSidebar(enabled) {
    if (enabled !== true && enabled !== false) return Promise.resolve();
    sidebar.reset();
    return enqueue(async (token) => {
      await loadGraph(token);
      await persist({ ...record, sidebar: enabled }); live(token);
      render({ sidebar: enabled });
      if (enabled && record.enabled) {
        for (const cached of caches.values()) cached.sidebarPending = true;
        schedule();
      }
    });
  }
  async function start() {
    if (destroyed || started) return getStatus();
    started = true;
    view = mount(document, { onInspect: refresh, onEnable: enable, onDisable: disable, onSidebar: setSidebar, onClose: close });
    sdk.setMainUIInlineStyle({ position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: 1000 });
    sdk.provideModel({ openJournalActivation: open });
    sdk.App.registerUIItem("toolbar", { key: "journal-routines-activation",
      template: '<a class="button" data-on-click="openJournalActivation" title="Journal &amp; Routines: status and setup" aria-label="Journal and Routines status and setup">JR</a>' });
    sdk.App.registerCommandPalette({ key: "journal-routines-activation", label: "Journal & Routines: Status, setup and Enable / Disable" }, open);
    try {
      graphOff = sdk.App.onCurrentGraphChanged(() => {
        cancel(); stopWork(); caches.clear(); graph = null; record = defaults();
        render({ status: "checking", summary: null, canEnable: false, message: "Checking the current graph." });
        void enqueue(async (token) => { await run(token); if (visible) await inspect(token); });
      });
      requireValue(typeof graphOff === "function", "subscription-unavailable");
    } catch { paused("subscription-unavailable"); return getStatus(); }
    return enqueue(run);
  }
  function destroy() {
    if (destroyed) return;
    cancel(); stopWork(); destroyed = true;
    try { graphOff?.(); } catch { /* Host teardown can already have removed it. */ }
    view?.destroy(); if (visible) sdk.hideMainUI({ restoreEditingCursor: true });
    adapter.destroy(); sidebar.destroy(); void calendar.destroy();
    originals.clear(); caches.clear(); explicitOff.clear();
    // Do not abort a durable checkpoint write already in flight on unload.
    void queue.finally(() => storage.close?.());
  }
  return { start, destroy, open, refresh, enable, disable, setSidebar, getStatus, whenIdle: () => queue };
}
