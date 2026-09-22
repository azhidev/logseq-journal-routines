import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  JOURNAL_SECTIONS, MAX_BLOCK_DEPTH, MAX_BLOCK_NODES,
  blockTitle, blockProperty, setBlockProperty, isSection,
  jalaliHeadingContent, numberedSectionContent, copyRoutineBlocks,
  routineReferenceBlock, validateBlocks,
} from "./journal-model.js";

const uuid = (n) => `abcdef01-2345-6789-abcd-${String(n).padStart(12, "0")}`;
const block = (n, content = "", children) => ({
  uuid: uuid(n), content, ...(children === undefined ? {} : { children }),
});
function freezeTree(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}
function chain(length) {
  let root = block(length, "TODO leaf");
  for (let n = length - 1; n > 0; n--) root = block(n, "Parent", [root]);
  return [root];
}
function copiedShape(blocks) {
  for (const item of blocks) {
    assert.deepEqual(Object.keys(item), ["content", "children"]);
    assert.equal(typeof item.content, "string");
    assert.ok(Array.isArray(item.children));
    copiedShape(item.children);
  }
}

// Extract only exact, explicitly allowlisted declarations. Never evaluate the IIFE,
// imports, timers, API access, or any other legacy automation. Indentation anchors
// delimit these declarations; fail the test if the legacy source layout changes.
function legacyHelpers() {
  const source = readFileSync(new URL("../../../logseq/custom.js", import.meta.url), "utf8");
  const names = [
    "entityValue", "blockUuid", "blockContent", "blockChildren", "blockTitle",
    "propertyPattern", "blockProperty", "setBlockProperty", "cleanCopiedContent",
    "copyableBlock", "routineRootBlocks", "jalaliHeadingContent", "isSection",
    "numberedSectionContent", "routineReferenceBlock", "ownerTaskSignature", "referenceTaskSignature",
  ];
  const constants = [
    "WEEKLY_SECTION", "WEEKLY_SECTION_MARKER", "MONTHLY_SECTION_MARKER",
    "ROUTINE_SECTION_PROPERTY", "ROUTINE_REFERENCE_PROPERTY",
    "JALALI_DATE_PROPERTY", "JALALI_SECTION_PROPERTY", "JALALI_SECTION_MARKER",
  ];
  const declarations = [
    ...constants.map((name) => {
      const matches = [...source.matchAll(new RegExp(`^  const ${name} = [^\\n]+;$`, "gm"))];
      assert.equal(matches.length, 1, `Unique legacy constant: ${name}`);
      return matches[0][0];
    }),
    ...names.map((name) => {
      const matches = [...source.matchAll(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^  \\}`, "gm"))];
      assert.equal(matches.length, 1, `Unique legacy function: ${name}`);
      return matches[0][0];
    }),
  ];
  return vm.runInNewContext(`${declarations.join("\n")}\n({ ${names.join(", ")} });`,
    Object.create(null), { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}
const legacy = legacyHelpers();
const plain = (value) => JSON.parse(JSON.stringify(value));

test("journal sections are the exact frozen starter order", () => {
  assert.deepEqual(JOURNAL_SECTIONS, ["Focus", "Weekly tasks", "Monthly tasks", "Tasks", "Notes", "End-of-day review"]);
  assert.ok(Object.isFrozen(JOURNAL_SECTIONS));
  assert.throws(() => JOURNAL_SECTIONS.push("Other"), TypeError);
});

test("titles and section matching retain legacy first-line and em-dash rules", () => {
  for (const [content, title] of [
    ["### FoCuS  \ncustom:: yes", "focus"], ["##Weekly tasks", "weekly tasks"],
    ["  ## Focus", "## focus"], ["\n## Tasks", ""], ["Notes\r\nbody", "notes"],
  ]) {
    assert.equal(blockTitle({ content }), title);
    assert.equal(blockTitle({ content }), legacy.blockTitle({ content }));
  }
  for (const [content, title, expected] of [
    ["## Weekly tasks — 23", "Weekly tasks", true], ["Monthly tasks — 6", "Monthly tasks", true],
    ["FOCUS", "Focus", true], ["## Notes — custom", "Notes", true],
    ["Weekly tasks extra", "Weekly tasks", false], ["Weekly tasks - 23", "Weekly tasks", false],
    ["Weekly tasks—23", "Weekly tasks", false], ["Weekly tasks —", "Weekly tasks", false],
    ["My Tasks", "Tasks", false],
  ]) {
    assert.equal(isSection({ content }, title), expected);
    assert.equal(isSection({ content }, title), legacy.isSection({ content }, title));
  }
});

test("properties read content lines only, case-insensitively, without normalizing hyphens", () => {
  const input = freezeTree(block(1, "TODO Work\n  RoUtInE-LoAdEd::  yes  \ncustom:: [[Page]]\r\nempty::", []));
  for (const property of ["routine-loaded", "custom", "empty", "missing", "routineloaded"]) {
    assert.equal(blockProperty(input, property), legacy.blockProperty(input, property));
  }
  assert.equal(blockProperty(input, "routine-loaded"), "yes");
  assert.equal(blockProperty(input, "empty"), "");
  assert.equal(blockProperty({ content: "TODO Work", properties: { custom: "metadata only" } }, "custom"), null);
  assert.equal(blockProperty({ content: "custom:: text", properties: { custom: "different" } }, "custom"), "text");
  assert.equal(blockProperty({ content: "prose custom:: not a property" }, "custom"), null);
});

test("duplicate reads fail with a generic error, including identical and empty values", () => {
  for (const content of ["custom:: PRIVATE\nCUSTOM:: PRIVATE", "custom:: one\ncustom:: two", "custom::\ncustom::"]) {
    assert.throws(() => blockProperty({ content }, "custom"), { name: "Error", message: "Duplicate block property." });
  }
});

test("property names are literal and empty values cannot consume the next line", () => {
  assert.equal(blockProperty({ content: "aXb:: wrong\na.b:: right" }, "a.b"), "right");
  assert.equal(blockProperty({ content: "tag[0]:: right" }, "tag[0]"), "right");
  assert.equal(blockProperty({ content: "empty::\nTODO keep this" }, "empty"), "");
  for (const property of ["", "bad name", "bad\nname", "bad:name", null]) {
    assert.throws(() => blockProperty({ content: "" }, property), /Invalid block property name/);
    assert.throws(() => setBlockProperty("", property, "value"), /Invalid block property name/);
  }
});

test("property replacement preserves unrelated lines and replaces all old instances", () => {
  const content = "TODO Keep completion\ncustom:: first\n  CUSTOM:: second\nid:: identity\n\nNotes  ";
  const expected = "TODO Keep completion\nid:: identity\n\nNotes  \ncustom:: new";
  assert.equal(setBlockProperty(content, "custom", "new"), expected);
  assert.equal(setBlockProperty(content, "custom", "new"), legacy.setBlockProperty(content, "custom", "new"));
  for (const input of [null, "", "DONE Task\nother:: yes\n"]) {
    assert.equal(setBlockProperty(input, "routine-loaded", true), legacy.setBlockProperty(input, "routine-loaded", true));
  }
  assert.equal(setBlockProperty("aXb:: keep\na.b:: old", "a.b", "new"), "aXb:: keep\na.b:: new");
});

test("Jalali heading formatting replaces only first line and managed properties", () => {
  const content = "## Old date\nJALALI-DATE:: old\ncustom:: keep\njalali-section:: old marker\njalali-date:: duplicate\nDONE Keep\n\n";
  const label = "دوشنبه ۲۳ شهریور ۱۴۰۵";
  const expected = `## ${label}\njalali-date:: 1405-06-23\njalali-section:: [[Jalali Date Section]]\ncustom:: keep\nDONE Keep`;
  assert.equal(jalaliHeadingContent(content, label, "1405-06-23"), expected);
  for (const input of [content, null, "", "## Date\nid:: keep\n\nNotes"]) {
    const result = jalaliHeadingContent(input, label, "1405-06-23");
    assert.equal(result, legacy.jalaliHeadingContent(input, label, "1405-06-23"));
    assert.equal(jalaliHeadingContent(result, label, "1405-06-23"), result);
  }
});

test("weekly/monthly headings preserve loaded markers, IDs, task states, and custom text", () => {
  const content = "## Old\nroutine-section:: old\nroutine-loaded:: yes\nid:: keep\ncustom:: text\nDONE task\nROUTINE-SECTION:: duplicate\n";
  for (const [title, number, marker] of [
    ["Weekly tasks", 26, "[[Routine Weekly Section]]"], ["Monthly tasks", 6, "[[Routine Monthly Section]]"],
  ]) {
    const result = numberedSectionContent(content, title, number);
    assert.equal(result, `## ${title} — ${number}\nroutine-section:: ${marker}\nroutine-loaded:: yes\nid:: keep\ncustom:: text\nDONE task`);
    for (const input of [content, null, "", "## Old\n\nNotes"]) {
      assert.equal(numberedSectionContent(input, title, number), legacy.numberedSectionContent(input, title, number));
    }
    assert.equal(numberedSectionContent(result, title, number), result);
  }
  for (const title of ["Tasks", "weekly tasks", "Month Routine", "", "toString"]) {
    assert.throws(() => numberedSectionContent(content, title, 1), /Unsupported numbered section/);
  }
});

function routineFixture() {
  return [
    block(1, "## WEEK ROUTINE", [
      block(2, `TODO Exercise\nid:: ${uuid(2)}\nCREATED-AT:: 1\ncustom:: [[Health]]`, [
        block(3, "DONE Warmup\nupdated-at:: 2\npriority:: A"),
        block(4, "id:: removed\n \ncreated-at:: 3", [block(5, "TODO dropped with empty parent")]),
      ]),
      block(6, "## Week Routine", [block(7, "DONE Nested title is retained")]),
    ]),
    block(8, "DONE Standalone\n  Updated-At:: 9\nid-extra:: keep\n\n"),
    block(9, "Week Routine"),
  ];
}

test("routine copies flatten top-level wrappers, recursively strip identity lines, and preserve completions", () => {
  const source = freezeTree(routineFixture());
  const before = structuredClone(source);
  const result = copyRoutineBlocks(source, "Week Routine");
  assert.deepEqual(result, [
    { content: "TODO Exercise\ncustom:: [[Health]]", children: [
      { content: "DONE Warmup\npriority:: A", children: [] },
    ] },
    { content: "## Week Routine", children: [{ content: "DONE Nested title is retained", children: [] }] },
    { content: "DONE Standalone\nid-extra:: keep", children: [] },
  ]);
  assert.deepEqual(result, plain(legacy.routineRootBlocks(source, "Week Routine").map(legacy.copyableBlock).filter(Boolean)));
  copiedShape(result);
  assert.ok(!JSON.stringify(result).includes(uuid(2)));
  result[0].children[0].content = "edited copy";
  assert.deepEqual(source, before);
  assert.deepEqual(copyRoutineBlocks([], "Month Routine"), []);
  assert.deepEqual(copyRoutineBlocks([block(20, "Month Routine", [block(21, "DONE Bill")])], "Month Routine"), [
    { content: "DONE Bill", children: [] },
  ]);
});

test("legacy empty-parent subtree loss is deliberate, not promotion of descendants", () => {
  const source = [block(1, "\n ID:: gone\nupdated-at:: gone\n", [block(2, "TODO child")])];
  assert.deepEqual(copyRoutineBlocks(source, "Week Routine"), []);
  assert.equal(legacy.copyableBlock(source[0]), null);
});

test("reference trees preserve every owner identity rather than copying task/completion text", () => {
  const owner = freezeTree(block(1, "DONE Owner\ncustom:: keep", [
    block(2, "TODO Child"), block(3, "", [block(4, "DONE Grandchild")]),
  ]));
  const before = structuredClone(owner);
  const ref = (n, children = []) => ({ content: `((${uuid(n)}))\nroutine-reference:: ${uuid(n)}`, children });
  const result = routineReferenceBlock(owner);
  assert.deepEqual(result, ref(1, [ref(2), ref(3, [ref(4)])]));
  assert.deepEqual(result, plain(legacy.routineReferenceBlock(owner)));
  assert.deepEqual(plain(legacy.referenceTaskSignature([result])), plain(legacy.ownerTaskSignature([owner])));
  copiedShape([result]);
  const changedCompletion = structuredClone(owner);
  changedCompletion.content = "TODO Owner";
  changedCompletion.children[0].content = "DONE Child";
  assert.deepEqual(routineReferenceBlock(changedCompletion), result);
  result.children[0].content = "edited reference";
  assert.deepEqual(owner, before);
  const uppercase = block(10, "DONE Uppercase identity");
  uppercase.uuid = uppercase.uuid.toUpperCase();
  assert.equal(blockProperty(routineReferenceBlock(uppercase), "routine-reference"), uppercase.uuid);
});

test("validation accepts normalized frozen forests and omitted leaf children, returning nothing", () => {
  const source = freezeTree([block(1, "", []), { ...block(2, "DONE task"), properties: { custom: "metadata" }, id: 123 }]);
  assert.equal(validateBlocks(source), undefined);
  assert.equal(validateBlocks([]), undefined);
  assert.equal(validateBlocks([Object.assign(Object.create(null), block(3))]), undefined);
  assert.equal(validateBlocks([{ ...block(4), uuid: uuid(4).toUpperCase() }]), undefined);
});

const invalidTrees = [
  ["non-array forest", () => ({})],
  ["null forest", () => null],
  ["null block", () => [null]],
  ["primitive block", () => ["content"]],
  ["missing UUID", () => [{ content: "PRIVATE" }]],
  ["non-string UUID", () => [{ ...block(1), uuid: { toString: () => uuid(1) } }]],
  ["noncanonical UUID", () => [{ ...block(1), uuid: uuid(1).replaceAll("-", "") }]],
  ["UUID whitespace", () => [{ ...block(1), uuid: ` ${uuid(1)}` }]],
  ["UUID trailing newline", () => [{ ...block(1), uuid: `${uuid(1)}\n` }]],
  ["invalid UUID characters", () => [{ ...block(1), uuid: uuid(1).replace("a", "z") }]],
  ["missing content", () => [{ uuid: uuid(1) }]],
  ["non-string content", () => [{ ...block(1), content: 42 }]],
  ["legacy aliases", () => [{ "block/uuid": uuid(1), "block/content": "PRIVATE" }]],
  ["explicit undefined children", () => [{ ...block(1), children: undefined }]],
  ["null children", () => [{ ...block(1), children: null }]],
  ["non-array children", () => [{ ...block(1), children: {} }]],
  ["root tuple", () => [["uuid", uuid(1)]]],
  ["unexpanded child tuple", () => [block(1, "", [["uuid", uuid(2)]])]],
  ["sparse roots", () => new Array(1)],
  ["sparse children", () => [block(1, "", new Array(1))]],
  ["duplicate UUID across branches", () => [block(1, "", [block(2)]), block(3, "", [block(2)])]],
  ["case-insensitive duplicate UUID", () => [block(1), { ...block(1), uuid: uuid(1).toUpperCase() }]],
  ["shared object", () => { const shared = block(2); return [block(1, "", [shared]), shared]; }],
  ["cycle", () => { const root = block(1, "", []); root.children.push(root); return [root]; }],
  ["array cycle", () => { const roots = []; roots.push(block(1, "", roots)); return roots; }],
  ["inherited fields", () => [Object.create(block(1))]],
  ["depth overflow", () => chain(MAX_BLOCK_DEPTH + 1)],
  ["node overflow", () => Array.from({ length: MAX_BLOCK_NODES + 1 }, (_, n) => block(n))],
  ["huge sparse forest", () => new Array(100000000)],
];
for (const [label, make] of invalidTrees) {
  test(`malformed/bounded trees fail closed: ${label}`, () => {
    const source = make();
    const error = { name: "Error", message: "Invalid block tree." };
    assert.throws(() => validateBlocks(source), error);
    assert.throws(() => copyRoutineBlocks(source, "Week Routine"), error);
    // A synthetic valid owner ensures every malformed forest is tested as children too.
    assert.throws(() => routineReferenceBlock(block(99999, "Owner", source)), error);
  });
}

test("validation does not invoke field or array-element getters", () => {
  let reads = 0;
  const get = () => { reads++; throw new Error("Must not execute"); };
  for (const key of ["uuid", "content", "children"]) {
    const source = block(1);
    Object.defineProperty(source, key, { get });
    assert.throws(() => validateBlocks([source]), /Invalid block tree/);
  }
  const roots = [];
  Object.defineProperty(roots, 0, { get });
  assert.throws(() => validateBlocks(roots), /Invalid block tree/);
  assert.equal(reads, 0);
});

test("depth and total-node limits are inclusive and apply to tree transforms", () => {
  const deep = chain(MAX_BLOCK_DEPTH);
  assert.equal(validateBlocks(deep), undefined);
  copiedShape(copyRoutineBlocks(deep, "Week Routine"));
  copiedShape([routineReferenceBlock(deep[0])]);
  const wide = [block(0, "Owner", Array.from({ length: MAX_BLOCK_NODES - 1 }, (_, n) => block(n + 1, "DONE task")))];
  assert.equal(validateBlocks(wide), undefined);
  assert.equal(copyRoutineBlocks(wide, "Week Routine")[0].children.length, MAX_BLOCK_NODES - 1);
  assert.equal(routineReferenceBlock(wide[0]).children.length, MAX_BLOCK_NODES - 1);
  wide[0].children.push(block(MAX_BLOCK_NODES));
  assert.throws(() => validateBlocks(wide), /Invalid block tree/);
});

test("invalid descendants cannot hide inside wrappers or dropped empty subtrees", () => {
  for (const content of ["Week Routine", "id:: only identity"]) {
    const source = [block(1, content, [{ content: "TODO missing owner UUID" }])];
    assert.throws(() => copyRoutineBlocks(source, "Week Routine"), /Invalid block tree/);
  }
  assert.throws(() => routineReferenceBlock({ content: "Missing owner UUID" }), /Invalid block tree/);
});
