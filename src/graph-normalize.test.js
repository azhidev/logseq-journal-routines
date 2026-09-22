import assert from "node:assert/strict";
import test from "node:test";
import { GraphDataError, normalizeBlock, normalizeGraph, normalizePage } from "./graph-normalize.js";

const UUID = "abcdef01-2345-6789-abcd-000000000001";
const OTHER_UUID = "abcdef01-2345-6789-abcd-000000000002";
const page = (extra = {}) => ({ id: 1, uuid: UUID, name: "Page", "journal?": false, ...extra });
const block = (extra = {}) => ({ uuid: UUID, content: "TODO Work", ...extra });
const messages = {
  "invalid-page": "Invalid graph page.",
  "invalid-block": "Invalid graph block.",
  "invalid-graph": "Invalid graph identity.",
  "conflicting-aliases": "Conflicting graph aliases.",
  "unsupported-format": "Unsupported graph format.",
  "conflicting-properties": "Conflicting managed properties.",
};
function rejects(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GraphDataError);
    assert.equal(error.name, "GraphDataError");
    assert.equal(error.code, code);
    assert.equal(error.message, messages[code]);
    return true;
  });
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, "value")) frozen(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

// SDK PageEntity.journalDay is optional, but journal? is declared boolean. Zero is
// not documented as a nonjournal sentinel: reject it rather than hide an owner.
test("host customUUID id lines normalize without concealing conflicting identities", () => {
  assert.equal(normalizeBlock(block({ content: `TODO Work\nid:: ${UUID}` })).content, "TODO Work");
  assert.equal(normalizeBlock(block({ content: `id:: ${UUID}\nTODO Work` })).content, "TODO Work");
  assert.equal(normalizeBlock(block({ content: `id:: ${UUID}` })).content, "");
  rejects(() => normalizeBlock(block({ content: `TODO Work\nid:: ${OTHER_UUID}` })), "conflicting-properties");
  rejects(() => normalizeBlock(block({ content: `id:: ${UUID}\nid:: ${UUID}` })), "conflicting-properties");
});

test("pages require explicit journal identity, never infer dates from names", () => {
  assert.deepEqual(normalizePage(page({ name: "2026-09-14" })), {
    id: 1, uuid: UUID, name: "2026-09-14", journalDay: null, format: null,
  });
  const missingFlag = page();
  delete missingFlag["journal?"];
  for (const input of [
    missingFlag,
    { ...missingFlag, journalDay: 20260914 },
    page({ "journal?": true }),
    page({ "journal?": false, journalDay: 20260914 }),
    page({ "journal?": undefined }),
    page({ "journal?": null }),
    page({ "journal?": "true", journalDay: 20260914 }),
    page({ "journal?": 1, journalDay: 20260914 }),
    page({ journalDay: 0 }),
    page({ journalDay: null }),
    page({ journalDay: undefined }),
    page({ "journal?": true, journalDay: 0 }),
  ]) rejects(() => normalizePage(input), "invalid-page");
});

test("page SDK and legacy aliases may be mixed and repeated consistently", () => {
  const input = frozen({
    id: 42, "db/id": 42, "block/id": 42,
    uuid: UUID, "block/uuid": UUID,
    name: "canonical", "block/name": "canonical", originalName: "Canonical",
    "journal?": true, "block/journal?": true,
    journalDay: 20240229, "journal-day": 20240229, "block/journal-day": 20240229,
    format: "markdown", "block/format": "markdown",
  });
  assert.deepEqual(normalizePage(input), {
    id: 42, uuid: UUID, name: "canonical", journalDay: 20240229, format: "markdown",
  });
  assert.deepEqual(normalizePage({
    "db/id": 42, "block/uuid": UUID, "block/name": "canonical",
    "block/journal?": true, "block/journal-day": 20240229, "block/format": "markdown",
  }), normalizePage(input));
  for (const extra of [
    { "block/id": 2 }, { "db/id": 2 }, { "block/uuid": OTHER_UUID },
    { "block/name": "Other" }, { "block/journal?": true },
  ]) rejects(() => normalizePage(page(extra)), "conflicting-aliases");
  rejects(() => normalizePage(page({
    "journal?": true, journalDay: 20240229, "journal-day": 20240301,
  })), "conflicting-aliases");
});

test("journal days are real eight-digit Gregorian integers, including century leap rules", () => {
  for (const day of [10000101, 20000229, 20240229, 20260914, 99991231]) {
    assert.equal(normalizePage(page({ "journal?": true, journalDay: day })).journalDay, day);
  }
  for (const day of [
    20230229, 19000229, 21000229, 20260431, 20261301, 20260001,
    20260100, 20260132, 9991231, 100000101, -20260914,
    20260914.5, NaN, Infinity, "20260914", new Number(20260914),
  ]) rejects(() => normalizePage(page({ "journal?": true, journalDay: day })), "invalid-page");
});

test("page inventory identities are required and never coerced", () => {
  for (const key of ["id", "uuid", "name"]) {
    const input = page();
    delete input[key];
    rejects(() => normalizePage(input), "invalid-page");
    for (const value of [undefined, null, {}, []]) {
      rejects(() => normalizePage(page({ [key]: value })), "invalid-page");
    }
  }
  for (const id of [0, -0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => normalizePage(page({ id })), "invalid-page");
  }
  for (const uuid of ["", "not-a-uuid", UUID + "\n", 1]) {
    rejects(() => normalizePage(page({ uuid })), "invalid-page");
  }
  for (const name of ["", " \n", 42]) rejects(() => normalizePage(page({ name })), "invalid-page");
  const onlyDisplayName = page({ originalName: "Page" });
  delete onlyDisplayName.name;
  rejects(() => normalizePage(onlyDisplayName), "invalid-page");
  assert.equal(normalizePage(page({ uuid: UUID.toUpperCase() })).uuid, UUID.toUpperCase());
});

test("Org fails closed for every page and block, not just journals", () => {
  for (const format of ["org", "Org", "text", "", null, undefined, {}]) {
    for (const key of ["format", "block/format"]) {
      rejects(() => normalizePage(page({ [key]: format })), "unsupported-format");
      rejects(() => normalizePage(page({ "journal?": true, journalDay: 20260914, [key]: format })), "unsupported-format");
      rejects(() => normalizeBlock(block({ [key]: format })), "unsupported-format");
    }
  }
  rejects(() => normalizePage(page({ format: "markdown", "block/format": "org" })), "unsupported-format");
  assert.equal(normalizePage(page({ format: "markdown" })).format, "markdown");
  assert.deepEqual(normalizeBlock(block({ format: "markdown" })), normalizeBlock(block()));
});

test("blocks require uuid/content and allow absent IDs, page IDs, and children", () => {
  assert.deepEqual(normalizeBlock(block({ content: "" })), {
    id: null, uuid: UUID, content: "", children: [], pageId: null,
  });
  assert.equal(normalizeBlock(block({ page: {} })).pageId, null);
  for (const key of ["uuid", "content"]) {
    const input = block();
    delete input[key];
    rejects(() => normalizeBlock(input), "invalid-block");
    for (const value of [undefined, null, 1, {}, []]) {
      rejects(() => normalizeBlock(block({ [key]: value })), "invalid-block");
    }
  }
  for (const value of [null, undefined, "1", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => normalizeBlock(block({ id: value })), "invalid-block");
    rejects(() => normalizeBlock(block({ page: { id: value } })), "invalid-block");
  }
  for (const value of [null, undefined, 1, ["id", 1]]) {
    rejects(() => normalizeBlock(block({ page: value })), "invalid-block");
  }
});

test("block aliases agree including immediate children and page identity", () => {
  const input = frozen({
    id: 2, "db/id": 2, "block/id": 2, uuid: UUID, "block/uuid": UUID,
    content: "TODO Work", "block/content": "TODO Work",
    children: [["uuid", OTHER_UUID]], "block/children": [["uuid", OTHER_UUID]],
    page: { id: 1, "db/id": 1 }, "block/page": { "block/id": 1 },
  });
  assert.deepEqual(normalizeBlock(input), {
    id: 2, uuid: UUID, content: "TODO Work", children: [["uuid", OTHER_UUID]], pageId: 1,
  });
  assert.deepEqual(normalizeBlock({
    "block/id": 2, "block/uuid": UUID, "block/content": "TODO Work",
    "block/children": [["uuid", OTHER_UUID]], "block/page": { "db/id": 1 },
  }), normalizeBlock(input));
  for (const extra of [
    { id: 3 }, { "db/id": 3 }, { uuid: OTHER_UUID }, { content: "Other" },
    { children: [] }, { page: { id: 3 } }, { page: {} },
  ]) rejects(() => normalizeBlock({ ...input, ...extra }), "conflicting-aliases");
  rejects(() => normalizeBlock(block({ page: { id: 1, "db/id": 2 } })), "conflicting-aliases");
  const child = block({ uuid: OTHER_UUID, children: [] });
  assert.equal(normalizeBlock(block({ children: [child], "block/children": [{ ...child }] })).children.length, 1);
  rejects(() => normalizeBlock(block({ children: [child], "block/children": [{ ...child, content: "Other" }] })), "conflicting-aliases");
});

test("children are bounded dense immediate records or exact unresolved UUID tuples", () => {
  for (const children of [
    null, undefined, {}, "", new Array(1), [undefined], [null], [1],
    [["block/uuid", OTHER_UUID]], [["uuid"]], [["uuid", OTHER_UUID, "extra"]],
    [["uuid", "bad"]], [["uuid", 1]], [new Array(2)],
    Object.assign([], { extra: 1 }), Object.assign([["uuid", OTHER_UUID]], { extra: 1 }),
    [Object.assign(["uuid", OTHER_UUID], { extra: 1 })], new Array(10001),
  ]) rejects(() => normalizeBlock(block({ children })), "invalid-block");
  const children = Array.from({ length: 10000 }, () => ["uuid", OTHER_UUID]);
  assert.equal(normalizeBlock(block({ children })).children.length, 10000);
});

test("normalization is shallow: collector owns descendant validation, expansion and cycles", () => {
  const nested = { notYetValidated: true };
  const child = block({ uuid: OTHER_UUID, children: nested });
  const tuple = ["uuid", OTHER_UUID];
  const raw = block({ children: [child, tuple] });
  const result = normalizeBlock(raw);
  assert.notEqual(result, raw);
  assert.notEqual(result.children, raw.children);
  assert.notEqual(result.children[0], child);
  assert.notEqual(result.children[1], tuple);
  assert.equal(result.children[0].children, nested);
  child.content = "Changed after normalization";
  tuple[1] = UUID;
  raw.content = "Changed parent";
  assert.equal(result.content, "TODO Work");
  assert.equal(result.children[0].content, "TODO Work");
  assert.deepEqual(result.children[1], ["uuid", OTHER_UUID]);
  const cyclic = block();
  cyclic.children = [cyclic];
  assert.equal(normalizeBlock(cyclic).children[0].children, cyclic.children);
  // Even missing child fields are left for its own normalizeBlock invocation.
  assert.deepEqual(normalizeBlock(block({ children: [{}] })).children, [{}]);
});

const referenceKeys = [
  ["routine-section", "routineSection", "Routine Weekly Section"],
  ["jalali-section", "jalaliSection", "Jalali Date Section"],
  ["habit-section", "habitSection", "Habit Daily Section"],
];
test("defensive SDK reference metadata supports bracketed/bare strings and singleton arrays", () => {
  for (const [key, camel, name] of referenceKeys) {
    const content = `## Section\n${key}:: [[${name}]]\ncustom:: keep`;
    for (const value of [name, `[[${name}]]`, [name], [`[[${name}]]`]]) {
      for (const metadataKey of [key, camel, key.toUpperCase()]) {
        const result = normalizeBlock(block({ content, properties: { [metadataKey]: value } }));
        assert.equal(result.content, content);
        assert.ok(!Object.hasOwn(result, "properties"));
      }
    }
    assert.equal(normalizeBlock(block({ content, properties: {
      [key]: name, [camel]: [`[[${name}]]`],
    } })).content, content);
    assert.equal(normalizeBlock(block({ content,
      properties: { [key]: name }, "block/properties": { [camel]: [name] },
    })).content, content);
  }
});

test("scalar metadata matches canonical numeric text without coercing UUID/date strings", () => {
  const content = `routine-loaded:: 42\nroutine-reference:: ${UUID}\njalali-date:: 1405-06-23`;
  for (const loaded of ["42", 42]) {
    assert.equal(normalizeBlock(block({ content, properties: {
      routineLoaded: loaded, routineReference: UUID, jalaliDate: "1405-06-23",
    } })).content, content);
  }
  for (const [key, textual, metadata] of [
    ["routine-loaded", "042", 42], ["routine-loaded", "42.0", 42],
    ["routine-loaded", "0", -0], ["routine-loaded", "true", true],
    ["routine-loaded", "NaN", NaN], ["routine-loaded", "Infinity", Infinity],
    ["routine-loaded", "42", ["42"]], ["routine-loaded", "yes", { value: "yes" }],
    ["routine-reference", UUID, UUID.toUpperCase()], ["routine-reference", UUID, [UUID]],
    ["routine-reference", "42", 42], ["jalali-date", "14050623", 14050623],
    ["jalali-date", "1405-06-23", ["1405-06-23"]], ["jalali-date", "1405-06-23", "1405-6-23"],
  ]) rejects(() => normalizeBlock(block({ content: `${key}:: ${textual}`, properties: { [key]: metadata } })), "conflicting-properties");
});

test("metadata-only managed state, conflicts and unsupported reference representations fail", () => {
  const allKeys = [
    ["routine-loaded", "routineLoaded", "2026-W38"],
    ["routine-reference", "routineReference", UUID],
    ["jalali-date", "jalaliDate", "1405-06-23"], ...referenceKeys,
  ];
  for (const [key, camel, value] of allKeys) {
    for (const name of [key, camel]) {
      for (const container of ["properties", "block/properties"]) {
        rejects(() => normalizeBlock(block({ [container]: { [name]: value } })), "conflicting-properties");
        rejects(() => normalizeBlock(block({ content: `${key}:: ${value}`, [container]: { [name]: "Other" } })), "conflicting-properties");
      }
      for (const invalid of [null, undefined, true, {}, [], [value, value]]) {
        rejects(() => normalizeBlock(block({ content: `${key}:: ${value}`, properties: { [name]: invalid } })), "conflicting-properties");
      }
    }
  }
  for (const invalid of [" Other ", "[[Other]]", "[[Routine Weekly Section]] trailing", "[[Routine Weekly Section", [["Routine Weekly Section"]], 42]) {
    rejects(() => normalizeBlock(block({ content: "routine-section:: [[Routine Weekly Section]]", properties: { routineSection: invalid } })), "conflicting-properties");
  }
  rejects(() => normalizeBlock(block({ content: "routine-loaded:: yes", properties: {
    "routine-loaded": "yes", routineLoaded: "no",
  } })), "conflicting-aliases");
  rejects(() => normalizeBlock(block({ content: "routine-loaded:: yes",
    properties: { routineLoaded: "yes" }, "block/properties": {},
  })), "conflicting-aliases");
  for (const properties of [null, undefined, [], "text"]) {
    rejects(() => normalizeBlock(block({ properties })), "conflicting-properties");
  }
});

test("duplicate managed text fails even if identical, empty, case-varied, or aliased", () => {
  for (const key of ["routine-loaded", "routine-reference", "routine-section", "jalali-date", "jalali-section", "habit-section"]) {
    for (const other of [key, key.toUpperCase(), key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]) {
      for (const value of ["", "PRIVATE"]) {
        rejects(() => normalizeBlock(block({ content: `TODO Work\n ${key}:: ${value}\r\n${other}:: ${value}` })), "conflicting-properties");
      }
    }
  }
  const content = "TODO Work\ncustom:: one\ncustom:: two\nprose routine-loaded:: not a property\nroutine-loaded::";
  assert.equal(normalizeBlock(block({ content })).content, content);
});

test("own data fields are required; no accessors are ever invoked", () => {
  let calls = 0;
  const getter = { get() { calls++; throw new Error("PRIVATE content/path/id"); }, enumerable: true };
  for (const [normalize, raw, keys, code] of [
    [normalizePage, page(), ["id", "uuid", "name", "journal?", "journalDay", "format", "block/name", "ignored"], "invalid-page"],
    [normalizeBlock, block(), ["id", "uuid", "content", "children", "page", "format", "properties", "block/content", "ignored"], "invalid-block"],
    [normalizeGraph, { path: "/private", name: "Private" }, ["path", "name", "ignored"], "invalid-graph"],
  ]) {
    for (const key of keys) rejects(() => normalize(Object.defineProperty({ ...raw }, key, getter)), code);
  }
  rejects(() => normalizeBlock(block({ page: Object.defineProperty({}, "id", getter) })), "invalid-block");
  rejects(() => normalizeBlock(block({ properties: Object.defineProperty({}, "routineLoaded", getter) })), "conflicting-properties");
  rejects(() => normalizeBlock(block({ properties: Object.defineProperty({}, "custom", getter) })), "conflicting-properties");
  rejects(() => normalizeBlock(block({ children: Object.defineProperty([null], "0", getter) })), "invalid-block");
  rejects(() => normalizeBlock(block({ children: [Object.defineProperty(block(), "content", getter)] })), "invalid-block");
  rejects(() => normalizeBlock(block({ children: [Object.defineProperty(["uuid", OTHER_UUID], "1", getter)] })), "invalid-block");
  rejects(() => normalizeBlock(block({ content: "routine-section:: [[Name]]",
    properties: { routineSection: Object.defineProperty([null], "0", getter) },
  })), "conflicting-properties");
  for (const [normalize, raw, code] of [
    [normalizePage, page(), "invalid-page"], [normalizeBlock, block(), "invalid-block"],
    [normalizeGraph, { path: "/private", name: "Private" }, "invalid-graph"],
  ]) {
    rejects(() => normalize(Object.create(raw)), code);
    assert.deepEqual(normalize(Object.assign(Object.create(null), raw)), normalize(raw));
    for (const invalid of [null, undefined, [], "text", 1, new Date()]) rejects(() => normalize(invalid), code);
  }
  assert.equal(calls, 0);
});

test("managed text must remain readable by the hyphenated content-property reader", () => {
  for (const key of ["routine-loaded", "routine-reference", "routine-section", "jalali-date", "jalali-section", "habit-section"]) {
    const camel = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    rejects(() => normalizeBlock(block({ content: `${camel}:: PRIVATE` })), "conflicting-properties");
    rejects(() => normalizeBlock(block({ content: `${camel}:: PRIVATE`, properties: { [camel]: "PRIVATE" } })), "conflicting-properties");
    const content = `${key.toUpperCase()}:: PRIVATE`;
    assert.equal(normalizeBlock(block({ content })).content, content);
  }
});

test("unrelated metadata is not traversed, serialized, or coerced", () => {
  let calls = 0;
  const hostile = {
    toJSON() { calls++; throw new Error("PRIVATE"); },
    toString() { calls++; throw new Error("PRIVATE"); },
    get nested() { calls++; throw new Error("PRIVATE"); },
  };
  hostile.cycle = hostile;
  assert.deepEqual(normalizeBlock(block({ properties: { custom: hostile }, ignored: hostile, toJSON: hostile.toJSON })), normalizeBlock(block()));
  rejects(() => normalizeBlock(block({ content: "routine-loaded:: yes", properties: { routineLoaded: hostile } })), "conflicting-properties");
  rejects(() => normalizeGraph({ path: hostile, name: "Private" }), "invalid-graph");
  assert.equal(calls, 0);
});

test("normalizers do not mutate frozen inputs or expose extra SDK fields", () => {
  const input = frozen(block({
    id: 2, content: "## Section\r\n  routine-section:: [[Name]]  \r\ncustom:: keep",
    page: { id: 1 }, properties: { routineSection: ["Name"], custom: "keep" },
    children: [block({ uuid: OTHER_UUID }), ["uuid", OTHER_UUID]], ignored: "private",
  }));
  const result = normalizeBlock(input);
  assert.deepEqual(Object.keys(result), ["id", "uuid", "content", "children", "pageId"]);
  assert.equal(result.content, input.content);
  result.children[0].content = "Local edit";
  result.children[1][1] = UUID;
  assert.equal(input.children[0].content, "TODO Work");
  assert.equal(input.children[1][1], OTHER_UUID);
  assert.deepEqual(normalizePage(frozen(page())), { id: 1, uuid: UUID, name: "Page", journalDay: null, format: null });
  assert.deepEqual(normalizeGraph(frozen({ path: "/private/graph", name: " Graph ", url: "ignored" })), { path: "/private/graph", name: " Graph " });
});

test("graph identity is exact required text, not url fallback", () => {
  for (const raw of [
    {}, { name: "Graph", url: "/private" }, { path: "/private" },
    { path: "", name: "Graph" }, { path: "/private", name: " " },
    { path: null, name: "Graph" }, { path: "/private", name: 1 },
  ]) rejects(() => normalizeGraph(raw), "invalid-graph");
});

test("errors have fixed codes/messages and sanitize reflection failures", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  for (const [normalize, code] of [
    [normalizePage, "invalid-page"], [normalizeBlock, "invalid-block"], [normalizeGraph, "invalid-graph"],
  ]) rejects(() => normalize(proxy), code);
  const error = new GraphDataError("PRIVATE path/content/id");
  assert.equal(error.code, "invalid-graph");
  assert.equal(error.message, messages["invalid-graph"]);
});
