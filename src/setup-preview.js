const SECTIONS = ["Focus", "Weekly tasks", "Monthly tasks", "Tasks", "Notes", "End-of-day review"];
const PAGES = [
  ["templates", "Templates"],
  ["week-routine", "Week Routine"],
  ["month-routine", "Month Routine"],
];
const LIMITATIONS = [
  "Existing pages and templates are user-owned review collisions, not permission to overwrite them.",
  "Only the named pages and global daily-default template are inspected; this is not a complete graph duplicate or owner scan.",
  "Active legacy automation is not detected by this preview.",
  "Read-only preview: no apply, graph writes, or migration is performed.",
  "Graph identity is sampled around reads, not locked; a switch away and back between samples cannot be detected.",
];
const OWNED = "User-owned review collision; no overwrite permission.";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError() {
  const error = new Error("Setup inspection was aborted; results were discarded.");
  error.name = "AbortError";
  return error;
}

// SDK reads cannot be cancelled remotely. Stop waiting locally, suppress late
// settlements, and never forward host errors (including AbortSignal.reason).
function boundedRead(invoke, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let active = true;
    let timer;
    function finish(result, aborted = false) {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (aborted) reject(abortError());
      else resolve(result);
    }
    function cancel() { finish(null, true); }
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => finish({ ok: false, reason: "Read timed out." }), timeoutMs);
    Promise.resolve().then(() => {
      if (active) return invoke();
    }).then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, reason: "Read failed or the supported API is unavailable." }),
    );
  });
}

function title(content) {
  return content.split("\n", 1)[0].replace(/^\s*#+\s*/, "").trim().toLowerCase();
}

// A tuple/unexpanded child is not an empty tree. Fail closed rather than
// reporting missing sections or zero routines from an incomplete response.
function inspectTree(tree) {
  if (!Array.isArray(tree) || tree.length > 10000) return null;
  const pending = [...tree];
  const seen = new Set();
  const uuids = new Set();
  const blocks = [];
  while (pending.length) {
    const block = pending.pop();
    if (!record(block) || typeof block.content !== "string" || seen.has(block) || blocks.length >= 10000) return null;
    if (block.uuid !== undefined) {
      if (typeof block.uuid !== "string" || !block.uuid.trim() || uuids.has(block.uuid)) return null;
      uuids.add(block.uuid);
    }
    seen.add(block);
    blocks.push(block);
    if (block.children !== undefined) {
      if (!Array.isArray(block.children) || pending.length + block.children.length > 10000) return null;
      pending.push(...block.children);
    }
  }
  return blocks;
}

function routineCounts(tree, pageName) {
  // Match the legacy page-title wrapper convention without copying or cleaning
  // any source block in place. Property-only blocks are not routine entries.
  const roots = tree.flatMap((block) => title(block.content) === pageName.toLowerCase()
    ? block.children ?? [] : [block]);
  const available = roots.filter((block) => block.content.split("\n")
    .some((line) => line.trim() && !/^\s*[^\s:]+::/.test(line))).length;
  return { available, empty: roots.length - available };
}

/**
 * Bounded, read-only setup inspection. timeoutMs applies to each read, including
 * graph identity reads. sections lists expected titles, not graph content.
 * The supplied createCalendarClient owns date validation and fresh discovery.
 */
export async function inspectSetup({ sdk, calendar, signal, timeoutMs = 3000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Setup timeoutMs must be a positive integer no greater than 2147483647.");
  }
  if (signal?.aborted) throw abortError();
  const read = (invoke) => boundedRead(invoke, signal, timeoutMs);
  async function graphInfo() {
    const result = await read(() => sdk.App.getCurrentGraph());
    if (!result.ok) throw new Error(`Cannot verify the current graph. ${result.reason}`);
    if (result.value === null) throw new Error("No graph is open. Open a file graph before inspecting setup.");
    const graph = result.value;
    if (!record(graph) || typeof graph.path !== "string" || !graph.path.trim()) {
      throw new Error("Setup inspection requires a file graph with a nonempty path.");
    }
    if (typeof graph.name !== "string" || !graph.name.trim()) {
      throw new Error("The current graph returned an invalid name.");
    }
    // Snapshot primitives: hosts may reuse and mutate AppGraphInfo objects.
    return { name: graph.name, path: graph.path };
  }
  const graph = await graphInfo();
  async function verifyGraph() {
    const current = await graphInfo();
    if (current.path !== graph.path) throw new Error("The current graph changed during setup inspection; results were discarded.");
  }
  async function checkedRead(invoke) {
    await verifyGraph();
    const result = await read(invoke);
    await verifyGraph();
    return result;
  }

  const checks = [];
  const warnings = [...LIMITATIONS];
  function add(id, label, state, detail) {
    checks.push({ id, title: label, state, detail });
    if (state === "warning" || state === "unavailable") warnings.push(`${label}: ${detail}`);
  }

  const date = await checkedRead(() => calendar.describeToday());
  // The real client validates the full description. This guard also makes a
  // missing/miswired client unavailable without manufacturing calendar values.
  const validDate = date.ok && record(date.value) &&
    ["gregorian", "persian", "week", "month"].every((key) => record(date.value[key]));
  const calendarResult = validDate
    ? { state: "available", today: date.value }
    : { state: "unavailable", reason: date.ok ? "Calendar returned no validated description." : date.reason };
  if (!validDate) warnings.push(`Calendar unavailable: ${calendarResult.reason} No period data is inferred.`);

  for (const [id, name] of PAGES) {
    const page = await checkedRead(() => sdk.Editor.getPage(name));
    if (!page.ok) {
      add(id, name, "unavailable", page.reason);
    } else if (page.value === null) {
      add(id, name, "missing", "Named page was not found; no page was created.");
    } else if (!record(page.value) || typeof page.value.name !== "string" || page.value.name.toLowerCase() !== name.toLowerCase()) {
      add(id, name, "unavailable", "Named page lookup returned a malformed or mismatched response.");
    } else if (name === "Templates") {
      add(id, name, "existing", OWNED);
    } else {
      const tree = await checkedRead(() => sdk.Editor.getPageBlocksTree(name));
      const blocks = tree.ok ? inspectTree(tree.value) : null;
      if (!blocks) {
        add(id, name, "unavailable", `${OWNED} ${tree.ok ? "Routine tree is malformed, incomplete, or exceeds the inspection limit." : tree.reason}`);
      } else {
        const counts = routineCounts(tree.value, name);
        add(id, name, counts.available ? "existing" : "warning",
          `${OWNED} Routine entries: ${counts.available} available, ${counts.empty} empty (top-level entries after page-title wrappers).`);
      }
    }
  }

  const template = await checkedRead(() => sdk.App.getTemplate("daily-default"));
  let sectionState = "unavailable";
  let sectionDetail = "Template section inspection is unavailable.";
  let blocks = null;
  if (!template.ok) {
    add("daily-default", "daily-default", "unavailable", template.reason);
  } else if (template.value === null) {
    add("daily-default", "daily-default", "missing", "Global template lookup found no daily-default template; nothing was created.");
    sectionState = "missing";
    sectionDetail = "The daily-default template was not found; this expected section cannot be supplied by it.";
  } else if (!record(template.value) || typeof template.value.uuid !== "string" || !template.value.uuid.trim()) {
    add("daily-default", "daily-default", "unavailable", "Global template lookup returned a malformed response or no UUID.");
  } else {
    add("daily-default", "daily-default", "existing", `${OWNED} Found via supported global template lookup.`);
    const uuid = template.value.uuid;
    const tree = await checkedRead(() => sdk.Editor.getBlock(uuid, { includeChildren: true }));
    if (tree.ok && record(tree.value) && tree.value.uuid === uuid) blocks = inspectTree([tree.value]);
    if (!blocks) {
      sectionDetail = tree.ok ? "Template tree is missing, malformed, incomplete, or exceeds the inspection limit." : tree.reason;
    }
  }
  for (const section of SECTIONS) {
    const id = `section-${section.toLowerCase().replaceAll(" ", "-")}`;
    if (!blocks) {
      add(id, section, sectionState, sectionDetail);
      continue;
    }
    const expected = section.toLowerCase();
    const count = blocks.filter((block) => {
      const actual = title(block.content);
      return actual === expected ||
        (["Weekly tasks", "Monthly tasks"].includes(section) && actual.startsWith(`${expected} — `));
    }).length;
    add(id, section, count === 0 ? "missing" : count === 1 ? "existing" : "warning",
      count === 0 ? "Expected section was not found in the daily-default tree; no section was added." :
        count === 1 ? "One matching section in the daily-default tree. User-owned; review before any changes." :
          `${count} matching sections in the daily-default tree; possible duplicate sections require review.`);
  }
  await verifyGraph();
  if (signal?.aborted) throw abortError();
  return { version: 1, graph: { name: graph.name }, calendar: calendarResult, checks, sections: [...SECTIONS], warnings };
}
