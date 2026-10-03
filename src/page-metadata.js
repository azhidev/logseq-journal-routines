const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOTSTRAP = "Journal & Routines metadata initialization";
const FLAGS = ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"];
const fail = (message) => { throw new Error(`Page metadata initialization paused: ${message}`); };
const plain = (value) => value && typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const singleLine = (value) => typeof value === "string" && value.length > 0 &&
  value === value.trim() && !/[\r\n\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value);
const camel = (key) => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function identity(entity, label) {
  if (!plain(entity) || !Number.isSafeInteger(entity.id) || entity.id <= 0 || !UUID.test(entity.uuid)) {
    fail(`${label} has a malformed identity.`);
  }
  return `${entity.id}:${entity.uuid.toLowerCase()}`;
}

function preBlock(entity) {
  let result;
  for (const key of FLAGS) {
    if (!Object.hasOwn(entity, key)) continue;
    if (typeof entity[key] !== "boolean" || (result !== undefined && result !== entity[key])) {
      fail("Conflicting or malformed native pre-block markers.");
    }
    result = entity[key];
  }
  return result === true;
}

function propertiesOf(entity, keys) {
  const aliases = new Map(keys.flatMap((key) => [[key, key], [camel(key), key]]));
  let previous;
  for (const field of ["properties", "block/properties"]) {
    if (!Object.hasOwn(entity, field)) continue;
    if (!plain(entity[field])) fail("Malformed properties map.");
    const result = {};
    for (const [alias, value] of Object.entries(entity[field])) {
      const key = aliases.get(alias);
      if (!key || typeof value !== "string") fail(`Unexpected property or non-string value: ${alias}.`);
      if (Object.hasOwn(result, key) && result[key] !== value) fail(`Conflicting property alias: ${key}.`);
      result[key] = value;
    }
    const normalized = JSON.stringify(Object.entries(result).sort());
    if (previous && previous.normalized !== normalized) fail("Conflicting properties maps.");
    previous = { result, normalized };
  }
  return previous?.result ?? {};
}

function equalProperties(actual, expected) {
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
    fail("Native parsed properties do not exactly match the expected text values.");
  }
}

function textProperties(content) {
  if (typeof content !== "string") fail("Missing header text.");
  const result = {};
  for (const line of content.split("\n")) {
    const match = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*):: (.+)$/.exec(line);
    if (!match || !singleLine(match[2]) || Object.hasOwn(result, match[1])) fail("Unexpected header content.");
    result[match[1]] = match[2];
  }
  return result;
}

// The caller must persist its attempt marker before entering this one-shot operation.
// Existing pages (including interrupted bootstraps) are never adopted or repaired here.
export async function createPageWithTextProperties({ editor, name, properties, guard, reservedIds = [] }) {
  if (!singleLine(name) || typeof guard !== "function" || !plain(properties) ||
      !Array.isArray(reservedIds) || reservedIds.some((id) => !UUID.test(id))) {
    throw new TypeError("Expected a page name, flat metadata, graph guard and reserved UUID array.");
  }
  const managed = Object.fromEntries(Object.entries(properties));
  for (const [key, value] of Object.entries(managed)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key) || ["title", "id", "__proto__", "constructor", "prototype"].includes(key) || !singleLine(value)) {
      throw new TypeError("Metadata requires canonical keys and nonempty single-line string values; title/id are reserved.");
    }
  }
  const keys = [...Object.keys(managed), "title", "id"];
  if (new Set(keys.map(camel)).size !== keys.length) throw new TypeError("Ambiguous metadata aliases.");
  const hasMetadata = Object.keys(managed).length > 0;
  const methods = ["getPage", "createPage", "getPageBlocksTree", "getBlock", "checkEditing"];
  if (hasMetadata) methods.push("newBlockUUID", "insertBlock", "updateBlock");
  for (const method of methods) {
    if (typeof editor?.[method] !== "function") throw new TypeError(`Editor.${method} is required for safe metadata creation.`);
  }
  const reserved = new Set(reservedIds.map((id) => id.toLowerCase()));
  async function call(method, ...args) {
    await guard();
    try { return await editor[method](...args); }
    finally { await guard(); }
  }
  function pageIdentity(page) {
    const result = identity(page, "Page");
    if (page["journal?"] === true || page.isJournal === true || (page.format != null && page.format !== "markdown")) {
      fail("Page is not an ordinary Markdown page.");
    }
    if (typeof page.name !== "string" || page.name.toLowerCase() !== name.toLowerCase() || reserved.has(page.uuid.toLowerCase())) {
      fail("Page name or reserved identity collision.");
    }
    return result;
  }
  const absent = await call("getPage", name);
  if (absent !== null) fail(absent === undefined ? "Page absence lookup is ambiguous." : "Page already exists; it will not be adopted.");
  const acknowledgement = await call("createPage", name, null, { redirect: false, createFirstBlock: false, format: "markdown" });
  const pageKey = pageIdentity(acknowledgement);
  const page = await call("getPage", name);
  if (pageIdentity(page) !== pageKey) fail("Creation acknowledgement and page identity differ.");
  const initialPageProperties = propertiesOf(page, keys);
  if (Object.keys(initialPageProperties).some((key) => !["title", "id"].includes(key)) ||
      (Object.hasOwn(initialPageProperties, "title") && initialPageProperties.title !== name)) {
    fail("New page contains unexpected properties.");
  }
  equalProperties(propertiesOf(acknowledgement, keys), initialPageProperties);

  async function readRoot() {
    const tree = await call("getPageBlocksTree", page.uuid);
    if (!Array.isArray(tree) || tree.length > 1) fail("Expected at most one first root; user content is preserved.");
    if (!tree.length) return null;
    const entry = tree[0];
    const tuple = Array.isArray(entry);
    if (tuple && (entry.length !== 2 || !["uuid", "block/uuid"].includes(entry[0]) || !UUID.test(entry[1]))) fail("Malformed root UUID tuple.");
    const uuid = tuple ? entry[1] : entry?.uuid;
    if (!UUID.test(uuid)) fail("Malformed root UUID.");
    const root = await call("getBlock", uuid, { includeChildren: true });
    validateRoot(root);
    if (root.uuid.toLowerCase() !== uuid.toLowerCase()) fail("Root lookup returned a different UUID.");
    if (!tuple && snapshot(entry) !== snapshot(root)) fail("Tree and header snapshots differ.");
    return root;
  }
  function validateRoot(root) {
    identity(root, "Header");
    if (root.id === page.id || root.uuid.toLowerCase() === page.uuid.toLowerCase() || reserved.has(root.uuid.toLowerCase())) fail("Header identity collision.");
    for (const key of ["page", "parent", "left"]) {
      if (root[key]?.id !== page.id) fail(`Header ${key} is not the first page root.`);
    }
    if (!Array.isArray(root.children) || root.children.length) fail("Header has children or an ambiguous children read.");
    if (root.format !== undefined && root.format !== "markdown") fail("Header is not Markdown.");
    preBlock(root);
  }
  function snapshot(root) {
    validateRoot(root);
    return JSON.stringify([identity(root, "Header"), root.content, preBlock(root),
      Object.entries(propertiesOf(root, keys)).sort(), root.format ?? "markdown"]);
  }
  let root = await readRoot();
  let original = {};
  if (root) {
    original = propertiesOf(root, keys);
    if (!preBlock(root) || original.title !== name || Object.keys(original).some((key) => !["title", "id"].includes(key)) ||
        (Object.hasOwn(original, "id") && original.id.toLowerCase() !== root.uuid.toLowerCase())) fail("Existing root is not an untouched native title header.");
    equalProperties(textProperties(root.content), original);
    // Native title headers need not be mirrored onto a newly created page yet.
    for (const [key, value] of Object.entries(initialPageProperties)) {
      if (original[key] !== value) fail("Native title header and page properties disagree.");
    }
  } else if (hasMetadata) {
    equalProperties(initialPageProperties, {});
    const uuid = await call("newBlockUUID");
    if (!UUID.test(uuid) || reserved.has(uuid.toLowerCase()) || uuid.toLowerCase() === page.uuid.toLowerCase()) fail("Fresh bootstrap UUID collision or malformed UUID.");
    if (await call("getBlock", uuid) !== null) fail("Fresh bootstrap UUID is occupied or its lookup is ambiguous.");
    const inserted = await call("insertBlock", name, BOOTSTRAP, { sibling: false, isPageBlock: true, focus: false, customUUID: uuid });
    // Logseq returns the pre-transaction block map, which may not have a db/id.
    if (inserted?.uuid?.toLowerCase() !== uuid.toLowerCase()) fail("Bootstrap acknowledgement UUID differs.");
    root = await readRoot();
    if (!root || root.uuid.toLowerCase() !== uuid.toLowerCase() ||
        (inserted.id !== undefined && inserted.id !== root.id)) fail("Bootstrap acknowledgement and root identity differ.");
    original = propertiesOf(root, keys);
    if (preBlock(root) || Object.keys(original).some((key) => key !== "id") ||
        (Object.hasOwn(original, "id") && original.id.toLowerCase() !== uuid.toLowerCase())) fail("Unexpected bootstrap properties.");
    const expected = BOOTSTRAP + (Object.hasOwn(original, "id") ? `\nid:: ${original.id}` : "");
    if (root.content !== expected) fail("Bootstrap text was edited.");
  }
  if (!root) equalProperties(initialPageProperties, {});
  const before = root ? snapshot(root) : null;
  const latestPage = await call("getPage", name);
  if (pageIdentity(latestPage) !== pageKey) fail("Page identity changed before metadata write.");
  equalProperties(propertiesOf(latestPage, keys), initialPageProperties);
  const latestRoot = await readRoot();
  if ((latestRoot ? snapshot(latestRoot) : null) !== before) fail("Header was edited before metadata write.");
  const editing = await call("checkEditing");
  if (editing !== false && editing !== null && (typeof editing !== "string" || !UUID.test(editing))) fail("Editing status is ambiguous.");
  if (typeof editing === "string" && [root?.uuid, page.uuid].filter(Boolean).some((uuid) => uuid.toLowerCase() === editing.toLowerCase())) fail("Target header/page is currently being edited.");
  // Ordinary definitions need no bootstrap, ownership properties or title mirroring.
  if (!hasMetadata) return latestPage;
  // Preserve native title text/order verbatim; customUUID may have appended an id line.
  const prefix = original.title ? root.content : (original.id ? `id:: ${original.id}` : "");
  const text = [prefix, ...Object.entries(managed).map(([key, value]) => `${key}:: ${value}`)].filter(Boolean).join("\n");
  await call("updateBlock", root.uuid, text);
  const verifiedPage = await call("getPage", name);
  if (pageIdentity(verifiedPage) !== pageKey) fail("Page identity changed after metadata write.");
  const verifiedRoot = await readRoot();
  if (!verifiedRoot || identity(verifiedRoot, "Header") !== identity(root, "Header") || !preBlock(verifiedRoot) || verifiedRoot.content !== text) fail("Native metadata header did not materialize unchanged.");
  const expected = { ...original, ...managed };
  equalProperties(propertiesOf(verifiedRoot, keys), expected);
  equalProperties(propertiesOf(verifiedPage, keys), expected);
  return verifiedPage;
}
