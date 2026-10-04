import { createPageWithTextProperties } from "./page-metadata.js";

export const DAILY_TEMPLATE = "Journal & Routines — Daily";
export const DAILY_TEMPLATE_PAGE = "Journal & Routines — Daily template";
const SEEN = "journal-routines:daily-template:v1:";
const OWNER = "jr-daily-template-version", STATE = "jr-daily-template-state";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const ACTIVE = '#{"TODO" "DOING" "NOW" "LATER" "IN-PROGRESS"}';
const OPEN = '#{"TODO" "DOING" "NOW" "LATER" "IN-PROGRESS" "WAITING"}';
const plain = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => JSON.stringify(value);

// Query the graph-owned template context, not private plugin settings or a journal's date.
const contextClauses = `         [?template-page :block/name ${text(DAILY_TEMPLATE_PAGE.toLowerCase())}]
         [?context :block/page ?template-page]
         [?context :block/properties ?context-props]
         [(get ?context-props :template) ?template-name]
         [(= ?template-name ${text(DAILY_TEMPLATE)})]
         [(get ?context-props :jr-weekly-definition) ?weekly-definition]
         [(get ?context-props :jr-monthly-definition) ?monthly-definition]
         [?b :block/page ?task-page]
         [?task-page :block/uuid ?task-page-uuid]
         [(str "page-uuid:" ?task-page-uuid) ?task-page-key]
         [(!= ?task-page-key ?weekly-definition)]
         [(!= ?task-page-key ?monthly-definition)]
         [(!= ?task-page ?template-page)]`;

export function dailyTaskQuery(kind, { compact = true } = {}) {
  if (!["priority", "pending", "weekly"].includes(kind)) throw new TypeError("Unknown daily task query.");
  let clauses = kind === "pending" ? '         [?b :block/marker "WAITING"]' :
    `         [?b :block/marker ?marker]\n         [(contains? ${kind === "weekly" ? OPEN : ACTIVE} ?marker)]`;
  if (kind === "priority") clauses += '\n         [?b :block/priority "A"]';
  let extra = "";
  if (kind === "weekly") {
    clauses += `
         [(get ?context-props :jr-daily-calendar) ?calendar]
         (civil-iso ?today ?today-iso)
         [?week :block/properties ?props]
         [(get ?props :jr-kind) ?kind]
         [(= ?kind "weekly")]
         [(get ?props :jr-calendar) ?calendar]
         [(contains? #{"gregorian" "jalali"} ?calendar)]
         [(get ?props :jr-start) ?start]
         [(get ?props :jr-end) ?end]
         [(<= ?start ?today-iso)]
         [(<= ?today-iso ?end)]
         [(get ?props :jr-period-id) ?id]
         [(str "journal-routines:" ?calendar ":weekly:" ?start ":" ?end) ?expected]
         [(= ?id ?expected)]
         (or-join [?b ?week ?start ?end]
           [?b :block/page ?week]
           (and [?b :block/scheduled ?scheduled]
                (civil-iso ?scheduled ?scheduled-iso)
                [(<= ?start ?scheduled-iso)]
                [(<= ?scheduled-iso ?end)])
           (and [?b :block/deadline ?deadline]
                (civil-iso ?deadline ?deadline-iso)
                [(<= ?start ?deadline-iso)]
                [(<= ?deadline-iso ?end)]))`;
    extra = `
 :inputs [:today]
 :rules [[(civil-iso ?day ?iso)
          [(str ?day) ?s]
          [(subs ?s 0 4) ?year]
          [(subs ?s 4 6) ?month]
          [(subs ?s 6 8) ?day-of-month]
          [(str ?year "-" ?month "-" ?day-of-month) ?iso]]]`;
  }
  return `#+BEGIN_QUERY
{:query [:find (pull ?b [*])
         ${kind === "weekly" ? ":in $ ?today %\n         " : ""}:where
${contextClauses}
${clauses}]${extra}
${compact ? ` :title [:span {:data-jr-query "${kind}"}]
 :group-by-page? false
 :breadcrumb-show? false
 :table-view? false` : " :breadcrumb-show? true"}
 :collapsed? false}
#+END_QUERY`;
}

const SECTION_LABELS = ["Focus", "Tasks", "Priority A", "Pending", "This week"];
const SECTION_ICONS = ["🎯", "☑️", "🚩", "⏳", "📅"];
const sectionHeading = (index) => `## ${SECTION_ICONS[index]} ${SECTION_LABELS[index]}`;

export function dailyTemplateNodes() {
  return [
    { parent: null, content: sectionHeading(0) },
    { parent: 0, content: "" },
    { parent: 0, content: "" },
    { parent: null, content: sectionHeading(1) },
    { parent: 3, content: "" },
    { parent: 3, content: "" },
    { parent: null, content: sectionHeading(2) },
    { parent: 6, content: dailyTaskQuery("priority") },
    { parent: null, content: sectionHeading(3) },
    { parent: 8, content: dailyTaskQuery("pending") },
    { parent: null, content: sectionHeading(4) },
    { parent: 10, content: dailyTaskQuery("weekly") },
  ];
}

function prop(entity, key) {
  const aliases = [key, key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
  let result;
  for (const map of [entity?.properties, entity?.["block/properties"]]) {
    if (map === undefined) continue;
    if (!plain(map)) throw new Error("Daily template properties are ambiguous.");
    for (const alias of aliases) {
      if (!Object.hasOwn(map, alias)) continue;
      const value = map[alias];
      if (result !== undefined && result !== value) throw new Error("Conflicting daily template properties.");
      result = value;
    }
  }
  return result;
}
function preBlock(block) {
  const flags = ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]
    .filter((key) => Object.hasOwn(block, key)).map((key) => block[key]);
  if (flags.some((flag) => typeof flag !== "boolean" || flag !== flags[0])) throw new Error("Ambiguous daily template header.");
  return flags[0] === true;
}
function identity(entity) { return entity && UUID.test(entity.uuid) && Number.isSafeInteger(entity.id) && entity.id > 0; }
function contentOf(block) {
  return block.content?.split("\n").filter((line) => line.trim().toLowerCase() !== `id:: ${block.uuid.toLowerCase()}`).join("\n");
}
function validateSettings(settings) {
  if (!["gregorian", "jalali"].includes(settings?.calendar) ||
    !["weekly", "monthly"].every((kind) => typeof settings.definitions?.[kind] === "string" &&
      settings.definitions[kind].trim() && !/[\r\n\x00-\x1f]/.test(settings.definitions[kind]))) {
    throw new TypeError("Daily template requires calendar and definition settings.");
  }
}
async function contextProperties(sdk, checked, settings) {
  validateSettings(settings);
  const result = { "jr-daily-calendar": settings.calendar };
  for (const kind of ["weekly", "monthly"]) {
    const page = await checked(() => sdk.Editor.getPage(settings.definitions[kind]));
    if (!identity(page)) throw new Error(`Daily template definition page cannot be verified: ${settings.definitions[kind]}`);
    // A prefix keeps numeric/boolean-looking values parser-stable; UUIDs survive reindex/rename.
    result[`jr-${kind}-definition`] = `page-uuid:${page.uuid.toLowerCase()}`;
  }
  return result;
}
function contextLineIndices(lines, key, current) {
  const indices = [];
  let fence = null;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const closing = /^\s*(`+|~+)\s*$/.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    const property = /^([^\s:]+)::(.*)\r?$/.exec(line);
    if (property?.[1] !== key) continue;
    // SDK metadata alone does not authorize rewriting a lookalike text line.
    if (property[2].trim() !== current) throw new Error("Daily template context property text disagrees with its metadata; inspect its root.");
    indices.push(index);
  }
  return indices;
}
function rootContent(properties) {
  return ["Daily journal template", `template:: ${DAILY_TEMPLATE}`, "template-including-parent:: false",
    ...Object.entries(properties).map(([key, value]) => `${key}:: ${value}`)].join("\n");
}

function operations({ sdk, guard }) {
  return async (operation) => { await guard(); const result = await operation(); await guard(); return result; };
}
async function readOwned({ sdk, checked, marker, state = "ready" }) {
  const editor = sdk.Editor;
  const page = await checked(() => editor.getPage(DAILY_TEMPLATE_PAGE));
  if (!identity(page) || page.uuid !== marker.pageUuid || prop(page, OWNER) !== "v1" ||
    page.isJournal === true || page["journal?"] === true || page.format != null && page.format !== "markdown") {
    throw new Error("Daily template page is missing, changed or unrelated; no recreation or repair.");
  }
  const header = await checked(() => editor.getBlock(marker.headerUuid, { includeChildren: true }));
  if (!identity(header) || !preBlock(header) || header.page?.id !== page.id || header.parent?.id !== page.id ||
    header.left?.id !== page.id || header.id === page.id || (header.children ?? []).length ||
    prop(header, OWNER) !== "v1" || prop(header, STATE) !== state) {
    throw new Error("Daily template initialization is incomplete or its header changed; inspect the template page.");
  }
  const root = await checked(() => editor.getBlock(marker.rootUuid, { includeChildren: true }));
  if (!identity(root) || root.page?.id !== page.id || root.parent?.id !== page.id || root.left?.id !== header.id ||
    prop(root, "template") !== DAILY_TEMPLATE || ![false, "false"].includes(prop(root, "template-including-parent"))) {
    throw new Error("Daily template root was changed or deleted; no automatic rebuild.");
  }
  const registered = await checked(() => sdk.App.getTemplate(DAILY_TEMPLATE));
  if (registered?.uuid !== root.uuid) throw new Error("Native daily template registration changed; no overwrite.");
  return { page, header, root };
}

/** Updates only installation-owned context properties, never tasks or journal content. */
export async function syncDailyTemplateContext({ sdk, storage, graphKey, guard, settings }) {
  const checked = operations({ sdk, guard });
  const marker = await checked(() => storage.get(SEEN + graphKey));
  if (marker === null) return;
  if (marker?.version !== 1 || marker.state !== "ready") throw new Error("Daily template installation is incomplete; inspect its page before continuing.");
  const desired = await contextProperties(sdk, checked, settings);
  const { root } = await readOwned({ sdk, checked, marker });
  if (Object.entries(desired).every(([key, value]) => prop(root, key) === value)) return;
  if (await checked(() => sdk.Editor.checkEditing()) === root.uuid) throw new Error("Finish editing the daily template root before changing its context.");
  if (typeof root.content !== "string") throw new Error("Daily template root text is unavailable.");
  const lines = root.content.split("\n");
  for (const [key, value] of Object.entries(desired)) {
    const indices = contextLineIndices(lines, key, prop(root, key));
    if (indices.length !== 1) throw new Error("Daily template context property text is missing or duplicated; inspect its root.");
    lines[indices[0]] = `${key}:: ${value}${lines[indices[0]].endsWith("\r") ? "\r" : ""}`;
  }
  const fresh = await checked(() => sdk.Editor.getBlock(root.uuid));
  if (fresh?.content !== root.content || await checked(() => sdk.Editor.checkEditing()) === root.uuid) throw new Error("Daily template root changed or is being edited; no context write.");
  // One native text save updates all context fields together and preserves the rest of the root.
  await checked(() => sdk.Editor.updateBlock(root.uuid, lines.join("\n")));
  const updated = await readOwned({ sdk, checked, marker });
  if (!Object.entries(desired).every(([key, value]) => prop(updated.root, key) === value)) throw new Error("Daily template context update is ambiguous; inspect its root.");
}

// Explicit installation may refresh only recognized generated text, never custom sections/journals.
async function refreshDailyTemplatePresentation({ sdk, checked, marker }) {
  const { root } = await readOwned({ sdk, checked, marker });
  if (!Array.isArray(root.children) || root.children.length !== 5) return;
  async function expand(entry) {
    return Array.isArray(entry) ? checked(() => sdk.Editor.getBlock(entry[1], { includeChildren: true })) : entry;
  }
  async function replace(block, before, after) {
    if (before === after || contentOf(block) !== before) return;
    await readOwned({ sdk, checked, marker });
    if (await checked(() => sdk.Editor.checkEditing()) !== false) throw new Error("Finish editing before refreshing daily template presentation.");
    const fresh = await checked(() => sdk.Editor.getBlock(block.uuid));
    if (fresh?.id !== block.id || fresh.page?.id !== block.page.id || fresh.parent?.id !== block.parent.id || contentOf(fresh) !== before) {
      throw new Error("Daily template section changed during presentation refresh; no overwrite.");
    }
    const content = fresh.content.replace(before, after);
    await checked(() => sdk.Editor.updateBlock(block.uuid, content));
    const updated = await checked(() => sdk.Editor.getBlock(block.uuid));
    if (updated?.id !== block.id || contentOf(updated) !== after) throw new Error("Daily template presentation update is uncertain; inspect its page.");
  }
  for (let index = 0; index < 5; index++) {
    const section = await expand(root.children[index]);
    if (!identity(section) || section.parent?.id !== root.id || section.page?.id !== root.page.id) throw new Error("Daily template section identity changed.");
    const oldHeading = `## ${SECTION_LABELS[index]}`;
    if (![oldHeading, sectionHeading(index)].includes(contentOf(section))) continue;
    if (index >= 2 && Array.isArray(section.children) && section.children.length === 1) {
      const query = await expand(section.children[0]);
      if (!identity(query) || query.parent?.id !== section.id || query.page?.id !== section.page.id || (query.children ?? []).length) continue;
      const kind = ["priority", "pending", "weekly"][index - 2];
      await replace(query, dailyTaskQuery(kind, { compact: false }), dailyTaskQuery(kind));
    }
    await replace(section, oldHeading, sectionHeading(index));
  }
}

function defaults(value) {
  if (value == null) return {};
  if (!plain(value) || Object.hasOwn(value, "journals") && value.journals != null && typeof value.journals !== "string") {
    throw new Error("Default journal template config is ambiguous; no setting was changed.");
  }
  return value;
}

/** Explicit, one-shot native installation. Interrupted/deleted resources are never refilled. */
export async function installDailyJournalTemplate({ sdk, storage, graphKey, guard, settings, replaceExisting = false }) {
  if (typeof replaceExisting !== "boolean") throw new TypeError("Expected an explicit template replacement choice.");
  validateSettings(settings);
  for (const method of ["getCurrentGraphConfigs", "setCurrentGraphConfigs", "getTemplate"]) {
    if (typeof sdk.App?.[method] !== "function") throw new Error(`Native daily template API unavailable: App.${method}`);
  }
  const checked = operations({ sdk, guard }), key = SEEN + graphKey;
  async function readDefaults() { return defaults(await checked(() => sdk.App.getCurrentGraphConfigs("default-templates"))); }
  function authorize(config) {
    const existing = config.journals?.trim();
    if (existing && existing !== DAILY_TEMPLATE && !replaceExisting) {
      throw new Error(`An existing default journal template (${existing}) is preserved. Explicitly approve replacement in Setup to use this template; its original content will not be deleted.`);
    }
  }
  const before = await readDefaults();
  authorize(before);
  let marker = await checked(() => storage.get(key));
  if (marker === null) {
    if (await checked(() => sdk.Editor.getPage(DAILY_TEMPLATE_PAGE)) !== null ||
      await checked(() => sdk.App.getTemplate(DAILY_TEMPLATE)) != null) {
      throw new Error("Daily template page or name is already occupied; no existing template was overwritten.");
    }
    const context = await contextProperties(sdk, checked, settings);
    const nodes = [{ parent: null, content: rootContent(context) },
      ...dailyTemplateNodes().map((node) => ({ ...node, parent: node.parent === null ? 0 : node.parent + 1 }))];
    const ids = [];
    for (const node of nodes) {
      const id = await checked(() => sdk.Editor.newBlockUUID());
      if (!UUID.test(id) || ids.includes(id) || await checked(() => sdk.Editor.getBlock(id)) !== null) throw new Error("Daily template block identity is occupied or ambiguous.");
      ids.push(id);
    }
    marker = { version: 1, state: "attempted", rootUuid: ids[0] };
    await checked(() => storage.set(key, marker));
    const page = await createPageWithTextProperties({ editor: sdk.Editor, name: DAILY_TEMPLATE_PAGE,
      properties: { [OWNER]: "v1", [STATE]: "initializing" }, guard, reservedIds: ids });
    const tree = await checked(() => sdk.Editor.getPageBlocksTree(page.uuid));
    if (!Array.isArray(tree) || tree.length !== 1) throw new Error("Daily template bootstrap is ambiguous; no section writes.");
    const header = Array.isArray(tree[0]) ? await checked(() => sdk.Editor.getBlock(tree[0][1])) : tree[0];
    if (!identity(header) || !preBlock(header) || header.page?.id !== page.id || header.parent?.id !== page.id ||
      header.left?.id !== page.id || prop(header, STATE) !== "initializing") throw new Error("Daily template header could not be verified.");
    const written = [];
    async function verify() {
      const current = await checked(() => sdk.Editor.getPage(DAILY_TEMPLATE_PAGE));
      if (current?.uuid !== page.uuid || current.id !== page.id || prop(current, OWNER) !== "v1") throw new Error("Daily template page changed during installation.");
      const raw = await checked(() => sdk.Editor.getPageBlocksTree(page.uuid));
      const found = [];
      async function walk(entries, parent, left) {
        if (!Array.isArray(entries)) throw new Error("Daily template tree is ambiguous.");
        for (const entry of entries) {
          const block = Array.isArray(entry) ? await checked(() => sdk.Editor.getBlock(entry[1], { includeChildren: true })) : entry;
          if (!identity(block) || block.page?.id !== page.id || block.parent?.id !== parent || block.left?.id !== left) throw new Error("Daily template tree identity changed.");
          if (block.uuid === header.uuid) {
            if (!preBlock(block) || prop(block, STATE) !== "initializing" || (block.children ?? []).length) throw new Error("Daily template header changed during installation.");
          } else {
            const i = found.length;
            if (block.uuid !== ids[i] || contentOf(block) !== nodes[i]?.content) throw new Error("Daily template was edited during installation; no refill.");
            found.push(block);
            await walk(block.children ?? [], block.id, block.id);
          }
          left = block.id;
        }
      }
      await walk(raw, page.id, page.id);
      if (found.length !== written.length) throw new Error("Daily template content changed during installation.");
    }
    for (const [i, node] of nodes.entries()) {
      await verify();
      const siblings = nodes.slice(0, i).map((item, index) => ({ ...item, index })).filter((item) => item.parent === node.parent);
      const previous = siblings.at(-1)?.index;
      const anchor = previous !== undefined ? ids[previous] : node.parent === null ? header.uuid : ids[node.parent];
      const result = await checked(() => sdk.Editor.insertBlock(anchor, node.content, {
        sibling: previous !== undefined || node.parent === null, isPageBlock: false, focus: false, customUUID: ids[i],
      }));
      if (result?.uuid !== ids[i]) throw new Error("Daily template insert outcome is ambiguous; inspect its page. No retry writes.");
      written.push(result);
    }
    await verify();
    await checked(() => sdk.Editor.upsertBlockProperty(header.uuid, STATE, "ready"));
    marker = { ...marker, state: "ready", pageUuid: page.uuid, headerUuid: header.uuid };
    await readOwned({ sdk, checked, marker });
    await checked(() => storage.set(key, marker));
  } else if (marker?.version !== 1 || marker.state !== "ready") {
    throw new Error("Daily template installation was previously attempted but is incomplete; inspect its page. No automatic recreation.");
  }
  await syncDailyTemplateContext({ sdk, storage, graphKey, guard, settings });
  await refreshDailyTemplatePresentation({ sdk, checked, marker });
  // Re-read immediately before replacing this one map; preserve other default entries.
  const current = await readDefaults();
  authorize(current);
  if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error("Default templates changed during installation; retry explicitly before changing config.");
  if (current.journals !== DAILY_TEMPLATE) {
    await checked(() => sdk.App.setCurrentGraphConfigs({ "default-templates": { ...current, journals: DAILY_TEMPLATE } }));
    if ((await readDefaults()).journals !== DAILY_TEMPLATE) {
      throw new Error("Native default template setting is not yet verified. The template page is preserved; check config.edn and retry installation. No journals were edited.");
    }
  }
  return { pageName: DAILY_TEMPLATE_PAGE, templateName: DAILY_TEMPLATE };
}
