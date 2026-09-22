import { createCalendarClient } from "./calendar-client.js";
import { snapshotSetupEvidence } from "./setup-plan.js";
import {
  JOURNAL_SECTIONS, blockProperty, blockTitle, copyRoutineBlocks, isSection,
  jalaliHeadingContent, numberedSectionContent, setBlockProperty, validateBlocks,
} from "./journal-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS = [
  { kind: "weekly", title: "Weekly tasks", marker: "[[Routine Weekly Section]]", field: "week" },
  { kind: "monthly", title: "Monthly tasks", marker: "[[Routine Monthly Section]]", field: "month" },
];
const PLACEHOLDERS = new Set(["What would make today successful?", "TODO Choose one important task."]);
const children = (block) => block.children ?? [];
const keyOf = (uuid) => uuid.toLowerCase();
// Marker-identified legacy blocks may start with a property rather than a title.
// The heading formatters replace line one; protect property-first layouts.
const headingSource = (content) => /^\s*[^\s:]+::/.test(content.split("\n", 1)[0]) ? `\n${content}` : content;
class PlanError extends Error {}
function fail(code) { throw new PlanError(code); }
function requireValue(condition, code = "invalid-snapshot") { if (!condition) fail(code); }
function walk(blocks, visit, parent = null) {
  for (const block of blocks) { visit(block, parent); walk(children(block), visit, block.uuid); }
}
function journalIso(day) {
  requireValue(Number.isInteger(day) && /^\d{8}$/.test(String(day)));
  const raw = String(day);
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const date = new Date(`${iso}T12:00:00Z`);
  requireValue(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso);
  return iso;
}
function normalizedSnapshot(input) {
  const source = snapshotSetupEvidence(input);
  requireValue(source.version === 1 && typeof source.graphId === "string" && source.graphId.trim() &&
    Array.isArray(source.pages) && source.pages.length <= 3660 && source.routines &&
    typeof source.routines === "object");
  journalIso(source.journalDay);
  const names = new Set(), days = new Set();
  for (const page of source.pages) {
    requireValue(page && typeof page.name === "string" && page.name.trim());
    journalIso(page.journalDay);
    requireValue(!names.has(page.name.toLowerCase()) && !days.has(page.journalDay), "duplicate-journal");
    names.add(page.name.toLowerCase());
    days.add(page.journalDay);
    validateBlocks(page.blocks);
  }
  for (const { kind } of PERIODS) {
    requireValue(Object.hasOwn(source.routines, kind));
    if (source.routines[kind] !== null) validateBlocks(source.routines[kind]);
  }
  // Block UUIDs are graph-wide, including routine definition blocks.
  validateBlocks([...source.pages.flatMap((page) => page.blocks), ...PERIODS.flatMap(({ kind }) => source.routines[kind] ?? [])]);
  return source;
}
function matches(block, title) {
  const period = PERIODS.find((entry) => entry.title === title);
  return period ? isSection(block, title) || blockProperty(block, "routine-section") === period.marker : blockTitle(block) === title.toLowerCase();
}

/** Resolve existing top-level section IDs without creating content. Ambiguity fails closed. */
export function resolveJournalSections(blocks) {
  validateBlocks(blocks);
  const result = {};
  const used = new Set();
  for (const title of JOURNAL_SECTIONS) {
    const found = blocks.filter((block) => matches(block, title));
    requireValue(found.length <= 1, "duplicate-section");
    if (found.length) {
      requireValue(!used.has(found[0].uuid), "conflicting-section");
      used.add(found[0].uuid);
    }
    result[title] = found[0]?.uuid ?? null;
  }
  return result;
}

function diffTrees(before, after) {
  function index(blocks) {
    const entries = new Map();
    function visit(list, parent) {
      list.forEach((block, position) => {
        entries.set(block.uuid, { block, parent, position });
        visit(children(block), block.uuid);
      });
    }
    visit(blocks, null);
    return entries;
  }
  const old = index(before), next = index(after), changes = [];
  for (const [uuid, current] of next) {
    const previous = old.get(uuid);
    if (!previous) changes.push({ kind: "insert", uuid, parent: current.parent, position: current.position });
    else {
      if (previous.block.content !== current.block.content) changes.push({ kind: "update", uuid });
      if (previous.parent !== current.parent || previous.position !== current.position) {
        changes.push({ kind: "move", uuid, parent: current.parent, position: current.position });
      }
    }
  }
  for (const uuid of old.keys()) if (!next.has(uuid)) changes.push({ kind: "remove", uuid });
  return changes;
}

function transition(source, description, today, createUuid) {
  const target = source.pages.find((page) => page.journalDay === source.journalDay);
  if (!target) return { status: "waiting", reason: "journal-not-created", nextJournal: null, changes: [], owners: {} };
  if (description.gregorian.iso < today.gregorian.iso) {
    return { status: "skipped", reason: "historical-journal", nextJournal: null, changes: [], owners: {} };
  }
  const isToday = description.gregorian.iso === today.gregorian.iso;
  requireValue(!isToday || source.ownerScanComplete === true, "incomplete-owner-scan");
  const before = snapshotSetupEvidence(target);
  const warnings = [], owners = {};
  const used = new Set();
  for (const page of source.pages) walk(page.blocks, (block) => used.add(keyOf(block.uuid)));
  for (const { kind } of PERIODS) walk(source.routines[kind] ?? [], (block) => used.add(keyOf(block.uuid)));
  function newBlock(content, childBlocks = []) {
    const uuid = createUuid();
    requireValue(typeof uuid === "string" && UUID.test(uuid) && !used.has(keyOf(uuid)), "invalid-new-identity");
    used.add(keyOf(uuid));
    return { uuid, content, children: childBlocks };
  }
  function materialize(block) { return newBlock(block.content, children(block).map(materialize)); }
  const ids = resolveJournalSections(target.blocks);
  // Nested managed sections are a migration problem, not permission to add another root.
  walk(target.blocks, (block, parent) => {
    if (parent && (PERIODS.some((period) => matches(block, period.title)) ||
      blockProperty(block, "routine-loaded") !== null || blockProperty(block, "routine-section") !== null ||
      blockProperty(block, "jalali-date") !== null || blockProperty(block, "jalali-section") !== null)) {
      fail("nested-managed-section");
    }
  });
  const dates = target.blocks.filter((block) => blockProperty(block, "jalali-date") !== null ||
    blockProperty(block, "jalali-section") === "[[Jalali Date Section]]" || blockTitle(block) === description.persian.label.toLowerCase());
  requireValue(dates.length <= 1, "duplicate-date-heading");
  let heading = dates[0];
  if (heading) {
    requireValue(!Object.values(ids).includes(heading.uuid), "conflicting-section");
    heading.content = jalaliHeadingContent(headingSource(heading.content), description.persian.label, description.persian.iso);
  } else {
    heading = newBlock(jalaliHeadingContent("", description.persian.label, description.persian.iso));
    target.blocks.unshift(heading);
  }
  const sections = {};
  for (const title of JOURNAL_SECTIONS) {
    let section = target.blocks.find((block) => block.uuid === ids[title]);
    if (!section) { section = newBlock(`## ${title}`); target.blocks.push(section); }
    sections[title] = section;
  }
  for (const { title, kind } of PERIODS) {
    sections[title].content = numberedSectionContent(headingSource(sections[title].content), title,
      kind === "weekly" ? description.persian.weekOfYear : description.persian.month);
  }
  for (const title of ["Focus", "Tasks"]) {
    const section = sections[title];
    section.children = children(section).filter((block) => {
      if (!PLACEHOLDERS.has(block.content.trim())) return true;
      // Legacy deletes the whole placeholder subtree; never discard attached notes.
      if (children(block).length) { warnings.push("placeholder-with-children-preserved"); return true; }
      return false;
    });
    if (!section.children.length) section.children.push(newBlock(""));
  }

  function findOwner(period) {
    const bounds = description[period.field], candidates = [];
    for (const page of source.pages) {
      const iso = journalIso(page.journalDay);
      walk(page.blocks, (block, parent) => {
        if (blockProperty(block, "routine-loaded") !== bounds.key) return;
        requireValue(!parent && matches(block, period.title), "invalid-period-owner");
        const ownerSections = resolveJournalSections(page.blocks);
        requireValue(ownerSections[period.title] === block.uuid, "invalid-period-owner");
        requireValue(iso >= bounds.start && iso <= bounds.end, "owner-outside-period");
        requireValue(iso <= description.gregorian.iso, "future-period-owner");
        candidates.push({ page, block });
      });
    }
    requireValue(candidates.length <= 1, "duplicate-period-owner");
    return candidates[0] ?? null;
  }
  function reconcileReferences(section, owner) {
    if (section.uuid === owner.uuid) return;
    const references = new Map(), plain = [];
    const legacyEmbed = `{{embed ((${owner.uuid}))}}`;
    function collect(block) {
      const ref = blockProperty(block, "routine-reference");
      requireValue(typeof ref === "string" && UUID.test(ref) &&
        block.content.trim() === `((${ref}))\nroutine-reference:: ${ref}`, "customized-reference");
      requireValue(!references.has(keyOf(ref)), "duplicate-routine-reference");
      references.set(keyOf(ref), block);
      children(block).forEach(collect);
    }
    for (const block of children(section)) {
      if (blockProperty(block, "routine-reference") !== null) collect(block);
      else if (block.content.trim() === legacyEmbed) {
        requireValue(!children(block).length, "customized-reference");
      } else plain.push(block);
    }
    function reference(block) {
      const existing = references.get(keyOf(block.uuid));
      const content = `((${block.uuid}))\nroutine-reference:: ${block.uuid}`;
      const result = existing ?? newBlock(content);
      result.content = content;
      result.children = children(block).map(reference);
      return result;
    }
    // Reuse reference UUIDs even when owner tasks move within the tree. Keep local
    // notes intact; only canonical generated reference blocks may be removed.
    section.children = [...plain, ...children(owner).map(reference)];
  }
  if (isToday) {
    for (const period of PERIODS) {
      const section = sections[period.title], bounds = description[period.field];
      const loaded = blockProperty(section, "routine-loaded");
      requireValue(loaded === null || loaded === bounds.key, "conflicting-loaded-period");
      let owner = findOwner(period);
      if (!owner) {
        requireValue(children(section).every((block) => !block.content.trim() && !children(block).length), "unmarked-routine-content");
        const defaults = source.routines[period.kind];
        if (defaults === null) warnings.push(`${period.kind}-routine-page-missing`);
        else {
          const copies = copyRoutineBlocks(defaults, period.kind === "weekly" ? "Week Routine" : "Month Routine");
          if (!copies.length) warnings.push(`${period.kind}-routine-page-empty`);
          else {
            walk(defaults, (block) => {
              for (const property of ["routine-loaded", "routine-reference", "routine-section", "jalali-date", "jalali-section"]) {
                requireValue(blockProperty(block, property) === null, "reserved-routine-property");
              }
              requireValue(!PERIODS.some((entry) => matches(block, entry.title)), "reserved-routine-section");
            });
            // Removing id/timestamp lines can expose a previously hidden title.
            walk(copies, (block) => {
              requireValue(!PERIODS.some((entry) => matches(block, entry.title)), "reserved-routine-section");
            });
            section.children = [...children(section), ...copies.map(materialize)];
            section.content = setBlockProperty(section.content, "routine-loaded", bounds.key);
            owner = { page: target, block: section };
          }
        }
      }
      owners[period.kind] = owner ? { page: owner.page.name, uuid: owner.block.uuid, key: bounds.key } : null;
      if (owner) reconcileReferences(section, owner.block);
    }
  }
  // Habits owns its content; recognize an existing root solely for legacy order.
  const habits = target.blocks.filter((block) => blockTitle(block) === "habits" ||
    blockProperty(block, "habit-section") === "[[Habit Section]]");
  requireValue(habits.length <= 1, "duplicate-feature-section");
  const ordered = [heading, sections.Focus, sections["Weekly tasks"], sections["Monthly tasks"],
    ...habits, sections.Tasks, sections.Notes, sections["End-of-day review"]];
  requireValue(new Set(ordered.map((block) => block.uuid)).size === ordered.length, "conflicting-section");
  const orderedIds = new Set(ordered.map((block) => block.uuid));
  let position = 0;
  // Only permute managed slots. Unknown roots stay in their original slots;
  // moving/reparenting arbitrary user blocks is not part of routine automation.
  target.blocks = target.blocks.map((block) => orderedIds.has(block.uuid) ? ordered[position++] : block);
  // The projected graph must be a valid next input too, including aggregate
  // node/size/depth bounds across definitions and generated copies.
  normalizedSnapshot(source);
  return { status: "planned", reason: null, before, nextJournal: target,
    changes: diffTrees(before.blocks, target.blocks), owners, warnings: [...new Set(warnings)],
    sections: resolveJournalSections(target.blocks), dateHeading: heading.uuid };
}

/**
 * Offline journal transition engine. invoke is the existing Calendar model transport;
 * no Editor/write adapter, scheduler, UI registration, or setup approval exists here.
 * Results contain private block data and must never be logged or displayed wholesale.
 * ownerScanComplete is a caller assertion, not proof of a graph-wide or atomic scan.
 */
export function createJournalEngine({ invoke, timeoutMs = 3000, createUuid = () => globalThis.crypto.randomUUID() }) {
  const calendar = createCalendarClient({ invoke, timeoutMs });
  let generation = 0, disposed = false;
  function invalidResult(reason) {
    return { version: 1, status: "blocked", reason, nextJournal: null, changes: [], owners: {} };
  }
  return {
    async plan(input) {
      if (disposed) return invalidResult("disposed");
      const current = ++generation;
      // Capture caller-owned data before yielding to any asynchronous work.
      let source;
      try { source = normalizedSnapshot(input); }
      catch (error) { return invalidResult(error instanceof PlanError ? error.message : "invalid-snapshot"); }
      await calendar.invalidate();
      if (disposed || current !== generation) return invalidResult("stale-context");
      try {
        const iso = await calendar.fromJournalDay(source.journalDay);
        const description = await calendar.describeDate(iso);
        const today = await calendar.describeToday();
        await calendar.getApiInfo();
        if (disposed || current !== generation) return invalidResult("stale-context");
        try {
          const result = transition(source, description, today, createUuid);
          if (disposed || current !== generation) return invalidResult("stale-context");
          return { version: 1, graphId: source.graphId, ...result };
        } catch (error) { return invalidResult(error instanceof PlanError ? error.message : "ambiguous-journal-data"); }
      } catch {
        return invalidResult(disposed || current !== generation ? "stale-context" : "calendar-unavailable");
      }
    },
    invalidate() { generation += 1; return calendar.invalidate(); },
    destroy() { disposed = true; generation += 1; return calendar.destroy(); },
  };
}
