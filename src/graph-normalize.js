/** Pure, fail-closed SDK/legacy graph boundary. No SDK calls or graph writes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHILDREN = 10000;
const ABSENT = Symbol("absent");
const MESSAGES = new Map([
  ["invalid-page", "Invalid graph page."],
  ["invalid-block", "Invalid graph block."],
  ["invalid-graph", "Invalid graph identity."],
  ["conflicting-aliases", "Conflicting graph aliases."],
  ["unsupported-format", "Unsupported graph format."],
  ["conflicting-properties", "Conflicting managed properties."],
]);

export class GraphDataError extends Error {
  constructor(code = "invalid-graph") {
    const safeCode = MESSAGES.has(code) ? code : "invalid-graph";
    super(MESSAGES.get(safeCode));
    this.name = "GraphDataError";
    this.code = safeCode;
  }
}

function fail(code) {
  throw new GraphDataError(code);
}

// Even reflection failures must not leak host error messages, paths, or content.
function boundary(code, normalize) {
  try {
    return normalize();
  } catch (error) {
    if (error instanceof GraphDataError) throw error;
    fail(code);
  }
}

// Inspect descriptors rather than reading SDK fields, including ignored fields.
// Nested, unrelated metadata is neither traversed nor serialized (no toJSON).
function fields(raw, code) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(code);
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) fail(code);
  const result = new Map();
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
    result.set(key, descriptor.value);
  }
  return result;
}

function alias(record, keys, normalize, equal = Object.is) {
  let result = ABSENT;
  for (const key of keys) {
    if (!record.has(key)) continue;
    const value = normalize(record.get(key));
    if (result !== ABSENT && !equal(result, value)) fail("conflicting-aliases");
    result = value;
  }
  return result;
}

function id(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function uuid(value, code) {
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) fail(code);
  return value;
}

function text(value, code, nonempty = false) {
  if (typeof value !== "string" || (nonempty && !value.trim())) fail(code);
  return value;
}

function required(value, code) {
  if (value === ABSENT) fail(code);
  return value;
}

function optional(value) {
  return value === ABSENT ? null : value;
}

function format(record) {
  return optional(alias(record, ["format", "block/format"], (value) => {
    // Org is rejected even on nonjournal pages: an owner scan cannot interpret it.
    if (value !== "markdown") fail("unsupported-format");
    return value;
  }));
}

function journalDay(value) {
  // Eight-digit Gregorian YYYYMMDD, independently of calendar-provider limits.
  // Zero is NOT a documented SDK sentinel and is deliberately rejected.
  if (!Number.isInteger(value) || value < 10000101 || value > 99991231) fail("invalid-page");
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail("invalid-page");
  return value;
}

/**
 * Required own identity: id/db/id/block/id, uuid/block/uuid, name/block/name.
 * originalName is NOT a name alias (the SDK distinguishes display/canonical names).
 * journal?/block/journal? must be boolean; true requires a valid journalDay,
 * journal-day, or block/journal-day. False requires the day to be absent, not null
 * or zero. No date is inferred from a name. Missing format becomes null; present
 * format/block/format must be markdown (org always throws unsupported-format).
 * @returns {{id: number, uuid: string, name: string, journalDay: number|null, format: 'markdown'|'org'|null}}
 */
export function normalizePage(raw) {
  return boundary("invalid-page", () => {
    const record = fields(raw, "invalid-page");
    const pageId = required(alias(record, ["id", "db/id", "block/id"], (v) => id(v, "invalid-page")), "invalid-page");
    const pageUuid = required(alias(record, ["uuid", "block/uuid"], (v) => uuid(v, "invalid-page")), "invalid-page");
    const name = required(alias(record, ["name", "block/name"], (v) => text(v, "invalid-page", true)), "invalid-page");
    const journal = required(alias(record, ["journal?", "block/journal?"], (v) => {
      if (typeof v !== "boolean") fail("invalid-page");
      return v;
    }), "invalid-page");
    const day = alias(record, ["journalDay", "journal-day", "block/journal-day"], journalDay);
    if (journal !== (day !== ABSENT)) fail("invalid-page");
    return { id: pageId, uuid: pageUuid, name, journalDay: optional(day), format: format(record) };
  });
}

// Only dense, bounded arrays with own data slots and no extra keys are supported.
// Array iteration methods are intentionally not read from host objects.
function arrayValues(raw, limit, code) {
  if (!Array.isArray(raw)) fail(code);
  const length = Object.getOwnPropertyDescriptor(raw, "length");
  if (!length || !Object.hasOwn(length, "value") ||
      !Number.isSafeInteger(length.value) || length.value < 0 || length.value > limit) fail(code);
  if (Reflect.ownKeys(raw).length !== length.value + 1) fail(code);
  const values = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
    values.push(descriptor.value);
  }
  return values;
}

function children(raw) {
  return arrayValues(raw, MAX_CHILDREN, "invalid-block").map((child) => {
    if (Array.isArray(child)) {
      const tuple = arrayValues(child, 2, "invalid-block");
      if (tuple.length !== 2 || tuple[0] !== "uuid") fail("invalid-block");
      uuid(tuple[1], "invalid-block");
      return tuple;
    }
    // Shallow data-only clone, NOT recursive normalization. Nested values stay raw
    // for the collector; it must recurse, expand tuples, and validate globally.
    return Object.fromEntries(fields(child, "invalid-block"));
  });
}

function sameFields(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || !Object.is(value, right.get(key))) return false;
  }
  return true;
}

function sameChildren(left, right) {
  return left.length === right.length && left.every((child, index) => {
    const other = right[index];
    if (Array.isArray(child) || Array.isArray(other)) {
      return Array.isArray(child) && Array.isArray(other) && child[0] === other[0] && child[1] === other[1];
    }
    // Compare immediate values only. Distinct nested objects are ambiguous aliases,
    // not a reason to recursively inspect/serialize arbitrary SDK metadata.
    return sameFields(fields(child, "invalid-block"), fields(other, "invalid-block"));
  });
}

const MANAGED = new Map([
  ["routine-loaded", "scalar"],
  ["routine-reference", "exact"],
  ["routine-section", "reference"],
  ["jalali-date", "exact"],
  ["jalali-section", "reference"],
  ["habit-section", "reference"],
]);
const PROPERTY_NAMES = new Map();
for (const key of MANAGED.keys()) {
  PROPERTY_NAMES.set(key, key);
  PROPERTY_NAMES.set(key.replaceAll("-", ""), key);
}

function propertyName(key) {
  return typeof key === "string" ? PROPERTY_NAMES.get(key.toLowerCase()) : undefined;
}

function referenceName(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\r\n]/.test(value)) {
    fail("conflicting-properties");
  }
  const match = /^\[\[([^\[\]]+)\]\]$/.exec(value);
  const name = match ? match[1] : value;
  if (!name.trim() || name !== name.trim() || /[\[\]]/.test(name)) fail("conflicting-properties");
  return name;
}

function metadataValue(value, kind) {
  if (kind === "reference") {
    if (Array.isArray(value)) {
      const items = arrayValues(value, 1, "conflicting-properties");
      if (items.length !== 1) fail("conflicting-properties");
      value = items[0];
    }
    return referenceName(value);
  }
  if (typeof value === "string") return value;
  // Exact UUID/date keys never undergo number coercion. For other scalars only
  // canonical finite numeric spellings can match text (no leading-zero folding).
  if (kind === "scalar" && typeof value === "number" && Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER && !Object.is(value, -0)) return String(value);
  fail("conflicting-properties");
}

/**
 * SDK properties?: Record<string, any> does NOT promise host normalization.
 * Defensive policy: content is authoritative and never synthesized. Metadata names
 * accept hyphenated and camel/unhyphenated aliases case-insensitively. Managed text
 * names must be hyphenated (case-insensitively), as required by the content reader;
 * other spellings fail rather than hide state. Duplicate text properties fail even
 * when identical. Metadata must have a text counterpart.
 * Section references accept exact-case Name, [[Name]], or a singleton string array
 * with the same semantic name. Other scalars accept matching strings or compatible
 * numbers; routine-reference UUIDs and jalali-date strings remain exact. Booleans,
 * objects, null, multi-reference arrays, and other encodings fail closed. Unmanaged
 * metadata values are ignored, never recursively inspected or serialized.
 */
function reconcileProperties(record, content) {
  const textual = new Map();
  for (const line of content.split("\n")) {
    const match = /^\s*([^\s:]+)::\s*(.*?)\s*$/.exec(line);
    const key = match && propertyName(match[1]);
    if (!key) continue;
    if (match[1].toLowerCase() !== key || textual.has(key)) fail("conflicting-properties");
    textual.set(key, match[2]);
  }
  alias(record, ["properties", "block/properties"], (raw) => {
    const managed = new Map();
    for (const [name, value] of fields(raw, "conflicting-properties")) {
      const key = propertyName(name);
      if (!key) continue;
      if (!textual.has(key)) fail("conflicting-properties");
      const kind = MANAGED.get(key);
      const normalized = metadataValue(value, kind);
      if (managed.has(key) && managed.get(key) !== normalized) fail("conflicting-aliases");
      managed.set(key, normalized);
    }
    for (const [key, value] of managed) {
      const expected = MANAGED.get(key) === "reference" ? referenceName(textual.get(key)) : textual.get(key);
      if (value !== expected) fail("conflicting-properties");
    }
    return managed;
  }, sameFields);
}

/**
 * Required uuid/block/uuid and content/block/content; optional positive safe integer
 * id/db/id/block/id and page/block/page record with optional id/db/id/block/id.
 * Present null/undefined fields are invalid, not absent. Missing children is a leaf.
 * Children/block/children: at most 10,000 dense immediate entries, either shallow
 * raw record clones or fresh exact ['uuid', uuid] tuples. Descendants are NOT checked
 * or copied recursively; cycles, duplicates, ownership, total nodes and depth are
 * the collector's job. Aliases must agree (nested objects by identity, not deep equality).
 * @returns {{id: number|null, uuid: string, content: string, children: Array, pageId: number|null}}
 */
// Desktop 0.10.15 insert_block persists customUUID as an id:: line. Treat only
// that exact redundant identity as metadata, so verified inserts round-trip.
// A conflicting or duplicate textual identity is not harmless normalization.
export function contentWithoutIdentity(content, blockUuid) {
  let found = false;
  return content.split("\n").filter((line) => {
    const match = /^\s*id::\s*(.*?)\s*$/i.exec(line);
    if (!match) return true;
    if (found || match[1].toLowerCase() !== blockUuid.toLowerCase()) fail("conflicting-properties");
    found = true;
    return false;
  }).join("\n");
}

export function normalizeBlock(raw) {
  return boundary("invalid-block", () => {
    const record = fields(raw, "invalid-block");
    const blockId = optional(alias(record, ["id", "db/id", "block/id"], (v) => id(v, "invalid-block")));
    const blockUuid = required(alias(record, ["uuid", "block/uuid"], (v) => uuid(v, "invalid-block")), "invalid-block");
    const content = required(alias(record, ["content", "block/content"], (v) => text(v, "invalid-block")), "invalid-block");
    format(record);
    const pageId = optional(alias(record, ["page", "block/page"], (v) => {
      return optional(alias(fields(v, "invalid-block"), ["id", "db/id", "block/id"], (n) => id(n, "invalid-block")));
    }));
    const blockChildren = alias(record, ["children", "block/children"], children, sameChildren);
    reconcileProperties(record, content);
    return { id: blockId, uuid: blockUuid, content: contentWithoutIdentity(content, blockUuid), children: blockChildren === ABSENT ? [] : blockChildren, pageId };
  });
}

/** Required own nonempty strings, preserved exactly; url is not a path alias.
 * @returns {{path: string, name: string}}
 */
export function normalizeGraph(raw) {
  return boundary("invalid-graph", () => {
    const record = fields(raw, "invalid-graph");
    return {
      path: text(required(record.has("path") ? record.get("path") : ABSENT, "invalid-graph"), "invalid-graph", true),
      name: text(required(record.has("name") ? record.get("name") : ABSENT, "invalid-graph"), "invalid-graph", true),
    };
  });
}
