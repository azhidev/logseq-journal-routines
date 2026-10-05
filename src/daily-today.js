import { DAILY_TEMPLATE, DAILY_TEMPLATE_PAGE } from "./daily-template.js";

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const INSTALL_KEY = "journal-routines:daily-template:v1:";
const APPLY_KEY = "journal-routines:daily-today:v1:";
const active = new WeakMap();
const TODAY_QUERY = `[:find ?uuid ?name ?day
 :in $ ?today
 :where
 [?p :block/journal-day ?today]
 [?p :block/journal? true]
 [?p :block/name ?name]
 [?p :block/uuid ?uuid]
 [?p :block/journal-day ?day]]`;
const plain = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validUUID = (value) => typeof value === "string" && UUID.test(value);
const sameUUID = (a, b) => validUUID(a) && validUUID(b) && a.toLowerCase() === b.toLowerCase();
const identity = (entity) => entity && validUUID(entity.uuid) && Number.isSafeInteger(entity.id) && entity.id > 0;

function aliases(entity, keys) {
  const present = keys.filter((key) => Object.hasOwn(entity, key));
  const value = entity[present[0]];
  if (present.some((key) => entity[key] !== value)) throw new Error("Conflicting daily journal aliases.");
  return value;
}
function property(entity, key) {
  let result;
  for (const map of [entity.properties, entity["block/properties"]]) {
    if (map === undefined) continue;
    if (!plain(map)) throw new Error("Ambiguous daily template properties.");
    const value = aliases(map, [key, key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]);
    if (value !== undefined) {
      if (result !== undefined && result !== value) throw new Error("Conflicting daily template properties.");
      result = value;
    }
  }
  return result;
}
function ordinary(block) {
  const flag = aliases(block, ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]);
  if (flag !== undefined && flag !== false) throw new Error("A journal/template property header is not an empty content block.");
}
function contentOf(block) {
  if (typeof block.content !== "string") throw new Error("Daily journal block text is unavailable.");
  return block.content.split("\n").filter((line) => {
    const match = /^id::\s*([\da-f-]+)\s*$/i.exec(line.trim());
    return !match || !sameUUID(match[1], block.uuid);
  }).join("\n");
}
function unavailable(message, code = "today-not-empty") {
  const error = new Error(message);
  error.code = code;
  return error;
}
function journalDay(value) {
  if (!Number.isSafeInteger(value) || !/^[1-9]\d{7}$/.test(String(value))) return false;
  const year = Math.floor(value / 10000), month = Math.floor(value / 100) % 100, day = value % 100;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Explicit native insertion only. A dispatched journal write is never blindly retried. */
export async function applyDailyTemplateToToday({ sdk, storage, graphKey, guard }) {
  if (typeof graphKey !== "string" || !graphKey || typeof guard !== "function") {
    throw new TypeError("Apply to today requires a graph key and graph guard.");
  }
  async function checked(operation) {
    await guard();
    const result = await operation();
    await guard();
    return result;
  }
  async function settings() {
    const config = await checked(() => sdk.App.getUserConfigs());
    if (config?.enabledJournals !== true || config.preferredFormat !== "markdown") {
      throw new Error("Enable native journals in a Markdown graph before applying the daily template.");
    }
  }
  async function notEditing() {
    if (await checked(() => sdk.Editor.checkEditing()) !== false) {
      throw new Error("Finish editing in Logseq before applying the daily template to today.");
    }
  }
  async function today(expected) {
    const rows = await checked(() => sdk.DB.datascriptQuery(TODAY_QUERY, ":today"));
    if (Array.isArray(rows) && rows.length === 0) throw unavailable("Open today’s journal in Logseq first.", "today-missing");
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 3) {
      throw new Error("Today’s native journal lookup is ambiguous; no journal writes.");
    }
    const [uuid, name, day] = rows[0];
    if (!validUUID(uuid) || typeof name !== "string" || !name.trim() || /[\x00-\x1f]/.test(name) || !journalDay(day)) {
      throw new Error("Today’s native journal identity is invalid; no journal writes.");
    }
    const page = await checked(() => sdk.Editor.getPage(uuid));
    if (!identity(page) || !sameUUID(page.uuid, uuid) || page.name !== name ||
      aliases(page, ["journalDay", "journal-day", "block/journal-day"]) !== day ||
      aliases(page, ["isJournal", "journal?", "block/journal?"]) !== true ||
      page.format != null && page.format !== "markdown") {
      throw new Error("Today’s journal page cannot be verified; no journal writes.");
    }
    if (expected && (!sameUUID(page.uuid, expected.uuid) || page.id !== expected.id || name !== expected.name || day !== expected.day)) {
      throw new Error("Today’s journal changed during application; inspect the journal before continuing.");
    }
    return { ...page, day };
  }
  async function expand(entry) {
    if (Array.isArray(entry)) {
      if (entry.length !== 2 || !["uuid", "block/uuid"].includes(entry[0]) || !validUUID(entry[1])) {
        throw new Error("Ambiguous daily journal block tuple.");
      }
      const block = await checked(() => sdk.Editor.getBlock(entry[1], { includeChildren: true }));
      if (!identity(block) || !sameUUID(block.uuid, entry[1])) throw new Error("Daily journal block lookup changed.");
      return block;
    }
    if (!identity(entry)) throw new Error("Daily journal block identity is invalid.");
    return entry;
  }
  async function tree(entries, page, parent = page.id, forbidden = new Set()) {
    const seen = new Set(), ids = new Set();
    async function walk(list, parent) {
      if (!Array.isArray(list)) throw new Error("Daily journal/template children are ambiguous.");
      const result = [];
      let left = parent;
      for (const entry of list) {
        if (seen.size >= 100) throw new Error("Daily template is limited to 100 blocks.");
        const block = await expand(entry), uuid = block.uuid.toLowerCase();
        if (seen.has(uuid) || ids.has(block.id) || forbidden.has(uuid) || sameUUID(block.uuid, page.uuid) || block.id === page.id ||
          block.page?.id !== page.id || block.parent?.id !== parent || block.left?.id !== left) {
          throw new Error("Daily journal/template block identities or hierarchy changed.");
        }
        ordinary(block);
        seen.add(uuid); ids.add(block.id);
        result.push({ content: contentOf(block), children: await walk(block.children, block.id), block });
        left = block.id;
      }
      return result;
    }
    return { nodes: await walk(entries, parent), uuids: seen };
  }
  const shape = (nodes) => nodes.map(({ content, children }) => ({ content, children: shape(children) }));
  async function template() {
    const marker = await checked(() => storage.get(INSTALL_KEY + graphKey));
    if (marker?.version !== 1 || marker.state !== "ready") throw new Error("Install the daily journal template for this graph first.");
    const page = await checked(() => sdk.Editor.getPage(DAILY_TEMPLATE_PAGE));
    if (!identity(page) || !sameUUID(page.uuid, marker.pageUuid) || property(page, "jr-daily-template-version") !== "v1" ||
      ["isJournal", "journal?", "block/journal?"].some((key) => page[key] === true) ||
      page.format != null && page.format !== "markdown") {
      throw new Error("The installed daily template owner page cannot be verified.");
    }
    const registered = await checked(() => sdk.App.getTemplate(DAILY_TEMPLATE));
    if (!identity(registered) || !sameUUID(registered.uuid, marker.rootUuid) || registered.page?.id !== page.id) {
      throw new Error("The installed native daily template registration cannot be verified.");
    }
    const root = await checked(() => sdk.Editor.getBlock(marker.rootUuid, { includeChildren: true }));
    if (!identity(root) || !sameUUID(root.uuid, registered.uuid) || root.id !== registered.id || root.id === page.id ||
      root.page?.id !== page.id || root.parent?.id !== page.id || property(root, "template") !== DAILY_TEMPLATE ||
      ![false, "false"].includes(property(root, "template-including-parent"))) {
      throw new Error("The installed native daily template root cannot be verified.");
    }
    ordinary(root);
    const lines = contentOf(root).split("\n");
    for (const [key, value] of [["template", DAILY_TEMPLATE], ["template-including-parent", "false"]]) {
      const values = lines.filter((line) => line.startsWith(`${key}::`));
      if (values.length !== 1 || values[0].trim() !== `${key}:: ${value}`) throw new Error("Native template root text/properties disagree.");
    }
    const source = await tree(root.children, page, root.id);
    if (source.uuids.size >= 100) throw new Error("Daily template is limited to 100 blocks including its root.");
    if (source.nodes.length !== 5 || !source.nodes.some((node) => node.content.trim())) {
      throw new Error("The daily template must have five nonempty/native sections; inspect its source first.");
    }
    source.uuids.add(root.uuid.toLowerCase());
    source.uuids.add(page.uuid.toLowerCase());
    return { uuid: root.uuid, pageUuid: page.uuid, shape: shape(source.nodes), uuids: source.uuids };
  }
  function verifyBlank(node, expectedUUID) {
    const { block, content, children } = node;
    if (content.trim() || children.length || expectedUUID && !sameUUID(block.uuid, expectedUUID)) {
      throw unavailable("Today’s journal is populated or changed; existing content is preserved.");
    }
    for (const map of [block.properties, block["block/properties"]]) {
      if (map === undefined) continue;
      if (!plain(map) || Object.entries(map).some(([key, value]) => key !== "id" || !sameUUID(value, block.uuid))) {
        throw unavailable("Today’s blank block has user properties; existing content is preserved.");
      }
    }
    return block;
  }
  async function blank(page, expectedUUID) {
    const raw = await checked(() => sdk.Editor.getPageBlocksTree(page.uuid));
    if (!Array.isArray(raw)) throw new Error("Today’s journal tree is ambiguous; no writes.");
    if (raw.length > 1) throw unavailable("Today’s journal is populated; existing content is preserved.");
    if (!raw.length) {
      if (expectedUUID) throw new Error("Today’s blank block disappeared; no retry or recreation.");
      return null;
    }
    const first = await expand(raw[0]);
    if (aliases(first, ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]) === true) {
      throw unavailable("Today’s journal has a property header; existing content is preserved.");
    }
    const { nodes } = await tree([first], page);
    return verifyBlank(nodes[0], expectedUUID);
  }

  await settings();
  const page = await today();
  const key = `${APPLY_KEY}${graphKey}:${page.day}:${page.uuid.toLowerCase()}`;
  const jobs = active.get(sdk) ?? new Set();
  active.set(sdk, jobs);
  if (jobs.has(key)) throw new Error("Applying today’s daily template is already in progress.");
  jobs.add(key);
  let attempted = false, mutationPossible = false;
  async function verifySource(source) {
    const fresh = await template();
    if (!sameUUID(fresh.uuid, source.uuid) || !sameUUID(fresh.pageUuid, source.pageUuid) || JSON.stringify(fresh.shape) !== JSON.stringify(source.shape) ||
      JSON.stringify([...fresh.uuids]) !== JSON.stringify([...source.uuids])) {
      throw new Error("Daily template source changed before application; inspect today. No retry.");
    }
  }
  async function mutate(operation, target, source) {
    if (!attempted) {
      // All read-only preflight precedes intent. Persist before dispatch, not ACK.
      attempted = true;
      await checked(() => storage.set(key, { version: 1, state: "attempted", journalDay: page.day,
        pageUuid: page.uuid, rootUuid: source.uuid, targetUuid: target.uuid }));
      // Storage persistence is asynchronous: retain final safety rechecks for
      // changes during that await. Failure here is still provably pre-write.
      await settings();
      await verifySource(source);
      await today(page);
      if (target.id === undefined) {
        if (await blank(page)) throw new Error("Today’s journal changed before blank-block creation; no insertion.");
      } else {
        await blank(page, target.uuid);
      }
      await notEditing();
    }
    return checked(() => {
      mutationPossible = true;
      return operation();
    });
  }
  try {
    if (await checked(() => storage.get(key)) !== null) {
      throw unavailable("Today’s daily template was previously attempted; inspect the journal. No retry or rebuild.", "today-previous-attempt");
    }
    const source = await template();
    let target = await blank(page);
    if (!target) {
      const uuid = await checked(() => sdk.Editor.newBlockUUID());
      if (!validUUID(uuid) || sameUUID(uuid, page.uuid) || source.uuids.has(uuid.toLowerCase()) || await checked(() => sdk.Editor.getBlock(uuid)) !== null) {
        throw new Error("The new blank journal block identity is occupied or ambiguous.");
      }
      target = { uuid };
    }
    await notEditing();
    await settings();
    await today(page);
    const existing = await blank(page);
    await verifySource(source);
    if (target.id === undefined) {
      if (existing) throw new Error("Today’s journal changed before blank-block creation; no insertion.");
      await today(page);
      if (await blank(page)) throw new Error("Today’s journal changed before blank-block creation; no insertion.");
      await notEditing();
      const inserted = await mutate(() => sdk.Editor.insertBlock(page.name, "", {
        isPageBlock: true, sibling: false, focus: false, customUUID: target.uuid,
      }), target, source);
      if (!sameUUID(inserted?.uuid, target.uuid)) throw new Error("Blank journal insertion is uncertain; inspect today. No retry.");
      await today(page);
      target = await blank(page, target.uuid);
    } else if (!existing || !sameUUID(existing.uuid, target.uuid)) {
      throw new Error("Today’s blank block changed before application; no insertion.");
    }
    await settings();
    if (mutationPossible) {
      await verifySource(source);
    }
    await today(page);
    await blank(page, target.uuid);
    await notEditing();
    await mutate(() => sdk.App.insertTemplate(target.uuid, DAILY_TEMPLATE), target, source);
    await today(page);
    const result = await tree(await checked(() => sdk.Editor.getPageBlocksTree(page.uuid)), page, page.id, source.uuids);
    // Native insertion can retain an id-bearing blank anchor because its raw
    // property text is not string/blank?. Never delete that native placeholder.
    let sections = result.nodes;
    if (sections.length === source.shape.length + 1 && sameUUID(sections[0].block.uuid, target.uuid)) {
      verifyBlank(sections[0], target.uuid);
      sections = sections.slice(1);
    }
    if (JSON.stringify(shape(sections)) !== JSON.stringify(source.shape)) {
      throw new Error("Native template insertion could not be verified; inspect today’s journal. No retry or rebuild.");
    }
    return { pageUuid: page.uuid, pageName: page.name, journalDay: page.day, templateName: DAILY_TEMPLATE };
  } catch (error) {
    if (attempted && !mutationPossible) {
      // No journal SDK write was dispatched. Clear only this pinned metadata key,
      // even after graph/Disable invalidation; never touch journal content here.
      // Failed cleanup leaves the conservative marker rather than hiding uncertainty.
      try { await storage.set(key, null); } catch { /* Original failure remains actionable. */ }
    }
    // Only a preflight refusal may be treated as a harmless skip by combined setup.
    if (mutationPossible && ["today-not-empty", "today-missing"].includes(error.code)) delete error.code;
    throw error;
  } finally { jobs.delete(key); }
}
