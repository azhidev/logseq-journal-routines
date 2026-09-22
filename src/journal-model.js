/** Pure journal text/tree helpers. No SDK, calendar, graph reads, or writes. */
export const JOURNAL_SECTIONS = Object.freeze([
  "Focus", "Weekly tasks", "Monthly tasks", "Tasks", "Notes", "End-of-day review",
]);

// Roots count as depth 1; limits apply across the entire input forest.
export const MAX_BLOCK_DEPTH = 100;
export const MAX_BLOCK_NODES = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTION_MARKERS = new Map([
  ["Weekly tasks", "[[Routine Weekly Section]]"],
  ["Monthly tasks", "[[Routine Monthly Section]]"],
]);

export function blockTitle(block) {
  return String(block?.content ?? "")
    .split("\n", 1)[0]
    .replace(/^#+\s*/, "")
    .trim()
    .toLocaleLowerCase();
}

function propertyPattern(property) {
  // Property names are literal, not caller-supplied regular expressions.
  if (typeof property !== "string" || !property || /[\s:]/u.test(property)) {
    throw new Error("Invalid block property name.");
  }
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}::\\s*(.*?)\\s*$`, "i");
}

/** Content lines only: SDK properties metadata is intentionally ignored. */
export function blockProperty(block, property) {
  const pattern = propertyPattern(property);
  let value = null;
  for (const line of String(block?.content ?? "").split("\n")) {
    const match = pattern.exec(line);
    if (!match) continue;
    if (value !== null) throw new Error("Duplicate block property.");
    value = match[1];
  }
  return value;
}

/** Explicit replacement removes all matching lines, as in the legacy setter. */
export function setBlockProperty(content, property, value) {
  const pattern = propertyPattern(property);
  const remainingLines = String(content ?? "").split("\n")
    .filter((line) => !pattern.test(line));
  return [...remainingLines, `${property}:: ${value}`].join("\n").trimEnd();
}

export function isSection(block, title) {
  const actualTitle = blockTitle(block);
  const expectedTitle = title.toLocaleLowerCase();
  return actualTitle === expectedTitle || actualTitle.startsWith(`${expectedTitle} — `);
}

export function jalaliHeadingContent(existingContent, label, dateKey) {
  const datePattern = propertyPattern("jalali-date");
  const sectionPattern = propertyPattern("jalali-section");
  const remainingLines = String(existingContent ?? "").split("\n").slice(1)
    .filter((line) => !datePattern.test(line) && !sectionPattern.test(line));
  return [
    `## ${label}`,
    `jalali-date:: ${dateKey}`,
    "jalali-section:: [[Jalali Date Section]]",
    ...remainingLines,
  ].join("\n").trimEnd();
}

export function numberedSectionContent(existingContent, title, number) {
  if (!SECTION_MARKERS.has(title)) throw new Error("Unsupported numbered section.");
  const pattern = propertyPattern("routine-section");
  const remainingLines = String(existingContent ?? "").split("\n").slice(1)
    .filter((line) => !pattern.test(line));
  return [
    `## ${title} — ${number}`,
    `routine-section:: ${SECTION_MARKERS.get(title)}`,
    ...remainingLines,
  ].join("\n").trimEnd();
}

/**
 * Validate expanded, normalized SDK blocks; return undefined without changing input.
 * UUIDs must use the hyphenated 8-4-4-4-12 spelling (either case). Required fields
 * must be own data fields, children may be omitted, and extra SDK metadata is ignored.
 * Aliases, tuples, sparse arrays, accessors, cycles, and shared identities fail closed.
 * Errors deliberately contain no source text or identifiers.
 */
export function validateBlocks(blocks) {
  const identities = new Set();
  const objects = new Set();
  let nodes = 0;
  const invalid = () => { throw new Error("Invalid block tree."); };
  const dataField = (object, key, optional = false) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor && optional) return undefined;
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    return descriptor.value;
  };
  function visit(list, depth) {
    if (!Array.isArray(list) || list.length > MAX_BLOCK_NODES - nodes) invalid();
    for (let index = 0; index < list.length; index++) {
      if (depth > MAX_BLOCK_DEPTH || ++nodes > MAX_BLOCK_NODES) invalid();
      const block = dataField(list, index);
      if (!block || typeof block !== "object" || Array.isArray(block)) invalid();
      const proto = Object.getPrototypeOf(block);
      if (proto !== Object.prototype && proto !== null) invalid();
      const uuid = dataField(block, "uuid");
      const content = dataField(block, "content");
      if (typeof uuid !== "string" || uuid.length !== 36 || !UUID.test(uuid) || typeof content !== "string" ||
          objects.has(block) || identities.has(uuid.toLowerCase())) invalid();
      objects.add(block);
      identities.add(uuid.toLowerCase());
      const children = dataField(block, "children", true);
      if (Object.hasOwn(block, "children")) visit(children, depth + 1);
    }
  }
  visit(blocks, 1);
}

/**
 * Flatten matching top-level page-title wrappers once, then copy without SDK identity.
 * Legacy parity: a parent whose cleaned content is empty drops its ENTIRE subtree;
 * nested page-title blocks are not wrappers. TODO/DONE and custom text stay unchanged.
 */
export function copyRoutineBlocks(blocks, pageName) {
  validateBlocks(blocks);
  const expectedTitle = pageName.toLocaleLowerCase();
  function copy(block) {
    const content = block.content.split("\n")
      .filter((line) => !/^\s*(id|created-at|updated-at)::/i.test(line))
      .join("\n").trimEnd();
    if (!content.trim()) return null;
    return { content, children: (block.children ?? []).map(copy).filter(Boolean) };
  }
  const roots = blocks.flatMap((block) => blockTitle(block) === expectedTitle ? (block.children ?? []) : [block]);
  return roots.map(copy).filter(Boolean);
}

/** Reference owners rather than copying task state, so completions retain identity. */
export function routineReferenceBlock(ownerBlock) {
  validateBlocks([ownerBlock]);
  function reference(block) {
    return {
      content: `((${block.uuid}))\nroutine-reference:: ${block.uuid}`,
      children: (block.children ?? []).map(reference),
    };
  }
  return reference(ownerBlock);
}
