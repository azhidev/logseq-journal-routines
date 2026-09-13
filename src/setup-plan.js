export const SETUP_SECTIONS = ["Focus", "Weekly tasks", "Monthly tasks", "Tasks", "Notes", "End-of-day review"];
const PAGE_NAMES = ["Templates", "Week Routine", "Month Routine"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESERVE = [
  "Preserve existing template text, properties, UUIDs, section order, and Tasks/Notes content.",
  "Preserve all existing routine pages, tasks, completions, and block identities.",
  "Leave configuration, schedulers, owners, and current and historical journals unchanged.",
];
const REQUIREMENTS = [
  "Draft only, never execution-ready or approval: no executor or graph writes are provided.",
  "Before any future apply, perform thorough graph-wide template/section uniqueness and collision checks; global duplicate enumeration is not supported by these reads.",
  "Before any future apply, verify journal/template configuration and root-inclusion settings, period owners, and legacy automation; none are fully scanned here.",
  "Before any future apply, verify dependency compatibility/lifecycle, take a backup, refresh and revalidate the plan, and obtain explicit per-graph approval.",
  "The fingerprint covers only sampled graph identity, named page metadata, routine trees, and the global template lookup/tree; existing Templates contents and the rest of the graph are not read.",
  "Graph identity is sampled, not locked; concurrent edits and switches away and back between samples cannot be excluded. An ID is not authorization or a cache lease.",
];
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const slug = (value) => value.toLowerCase().replaceAll(" ", "-");

// Copy host data immediately, without invoking getters/toJSON or retaining mutable
// host references. Bounds also make cyclic/deep/oversized evidence fail closed.
export function snapshotSetupEvidence(value) {
  let nodes = 0;
  let size = 0;
  const ancestors = new Set();
  function copy(item, depth) {
    if (++nodes > 100000 || depth > 100) throw new Error("Unsupported setup evidence.");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      size += item.length;
      if (size > 8_000_000) throw new Error("Unsupported setup evidence.");
      // TextEncoder replaces lone surrogates; JSON escapes them before hashing.
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item !== "object" || ancestors.has(item)) throw new Error("Unsupported setup evidence.");
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) throw new Error("Unsupported setup evidence.");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error("Unsupported setup evidence.");
    const result = array ? [] : Object.create(null);
    if (array && (item.length > 10000 || keys.length !== item.length + 1)) throw new Error("Unsupported setup evidence.");
    for (const key of keys.sort()) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
          (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) {
        throw new Error("Unsupported setup evidence.");
      }
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  return copy(value, 0);
}

export function canonicalSetupJSON(value) {
  return JSON.stringify(snapshotSetupEvidence(value));
}

export function matchesSetupSection(content, section) {
  const actual = content.split("\n", 1)[0].replace(/^\s*#+\s*/, "").trim().toLowerCase();
  const expected = section.toLowerCase();
  return actual === expected ||
    (["Weekly tasks", "Monthly tasks"].includes(section) && actual.startsWith(`${expected} — `));
}

function validTree(tree) {
  if (!Array.isArray(tree)) return false;
  const pending = [...tree];
  const uuids = new Set();
  while (pending.length) {
    const block = pending.pop();
    if (!isRecord(block) || typeof block.content !== "string" || !UUID.test(block.uuid) ||
        uuids.has(block.uuid.toLowerCase()) || uuids.size >= 10000 ||
        (Object.hasOwn(block, "properties") && !isRecord(block.properties))) return false;
    uuids.add(block.uuid.toLowerCase());
    // Omitted children are the SDK's leaf representation, not an unresolved tuple.
    if (Object.hasOwn(block, "children")) {
      if (!Array.isArray(block.children)) return false;
      pending.push(...block.children);
    }
  }
  return true;
}

function propertyValues(block, property) {
  const normalized = property.replaceAll("-", "");
  const values = Object.entries(block.properties ?? {})
    .filter(([key]) => key.toLowerCase().replaceAll("-", "") === normalized)
    .map(([, value]) => value);
  const lines = block.content.split("\n");
  const textValues = lines.flatMap((line) => {
    const match = /^\s*([^\s:]+)::\s*(.*?)\s*$/.exec(line);
    return match && match[1].toLowerCase().replaceAll("-", "") === normalized ? [match[2]] : [];
  });
  return { values: [...values, ...textValues], duplicate: textValues.length > 1 || values.length > 1 };
}

function templateBlockers(root) {
  const blockers = [];
  const definition = propertyValues(root, "template");
  if (!definition.values.length || definition.duplicate || definition.values.some((value) => value !== "daily-default")) {
    blockers.push("The fetched template definition is missing, conflicting, or ambiguous.");
  }
  const inclusion = propertyValues(root, "template-including-parent");
  if (!inclusion.values.length || inclusion.duplicate || inclusion.values.some((value) => value !== false && value !== "false")) {
    blockers.push("Template root inclusion is not explicitly and consistently false; safe direct-child append cannot be established.");
  }
  const pending = [{ block: root, depth: 0 }];
  const matches = new Map(SETUP_SECTIONS.map((section) => [section, []]));
  while (pending.length) {
    const { block, depth } = pending.pop();
    if (depth > 0 && propertyValues(block, "template").values.includes("daily-default")) {
      blockers.push("Another daily-default definition appears inside the sampled template tree.");
    }
    for (const section of SETUP_SECTIONS) {
      if (matchesSetupSection(block.content, section)) matches.get(section).push(depth);
    }
    for (const child of block.children ?? []) pending.push({ block: child, depth: depth + 1 });
  }
  for (const depths of matches.values()) {
    if (depths.length > 1 || depths.some((depth) => depth !== 1)) {
      blockers.push("Duplicate, nested, or root-level matching sections prevent unambiguous direct-child append.");
      break;
    }
  }
  return { blockers, missing: SETUP_SECTIONS.filter((section) => !matches.get(section).length) };
}

export function blockedSetupPlan(reason) {
  return {
    version: 1, id: null, status: "blocked", changes: [], preserve: [...PRESERVE],
    blockers: reason ? [reason] : [], requirements: [...REQUIREMENTS],
  };
}

/** Internal evidence v1 contains only results of the inspector's existing reads.
 * Raw source data never leaves this function in the returned public plan.
 */
export async function createSetupPlan({ report, evidence }) {
  const plan = blockedSetupPlan();
  const incomplete = () => {
    plan.changes = [];
    plan.blockers.push("Unsupported, unreadable, incomplete, or non-hashable setup evidence; refresh and review before planning.");
    return plan;
  };
  let source;
  try {
    source = snapshotSetupEvidence(evidence);
    if (report?.version !== 1 || JSON.stringify(report.sections) !== JSON.stringify(SETUP_SECTIONS) ||
        !["available", "unavailable"].includes(report.calendar?.state) || source.version !== 1 ||
        !isRecord(source.graph) || typeof source.graph.path !== "string" || !source.graph.path.trim() ||
        typeof source.graph.name !== "string" || !source.graph.name.trim() || !isRecord(source.pages) ||
        !isRecord(source.template) || !Array.isArray(report.checks)) return incomplete();
    const expectedStates = new Map();
    for (const name of PAGE_NAMES) {
      const entry = source.pages[name];
      if (!isRecord(entry) || !entry.page?.ok) return incomplete();
      const page = entry.page.value;
      if (page !== null && (!isRecord(page) || typeof page.name !== "string" || page.name.toLowerCase() !== name.toLowerCase() ||
          (Object.hasOwn(page, "properties") && !isRecord(page.properties)))) return incomplete();
      if (page !== null && name !== "Templates" && (!entry.tree?.ok || !validTree(entry.tree.value))) return incomplete();
      expectedStates.set(slug(name), page === null ? ["missing"] : name === "Templates" ? ["existing"] : ["existing", "warning"]);
    }
    if (!source.template.lookup?.ok) return incomplete();
    const lookup = source.template.lookup.value;
    let root = null;
    if (lookup !== null) {
      if (!isRecord(lookup) || !UUID.test(lookup.uuid) || !source.template.tree?.ok) return incomplete();
      root = source.template.tree.value;
      if (!validTree([root]) || root.uuid !== lookup.uuid) return incomplete();
    }
    expectedStates.set("daily-default", root ? ["existing"] : ["missing"]);
    for (const section of SETUP_SECTIONS) expectedStates.set(`section-${slug(section)}`, ["existing", "missing", "warning"]);
    if (report.checks.length !== expectedStates.size || new Set(report.checks.map((check) => check.id)).size !== expectedStates.size ||
        report.checks.some((check) => !expectedStates.get(check.id)?.includes(check.state))) return incomplete();

    if (report.calendar.state !== "available") plan.blockers.push("Calendar dependency is unavailable; future setup must wait for validated dependency checks.");
    const analysis = root ? templateBlockers(root) : null;
    if (analysis) plan.blockers.push(...analysis.blockers);
    const change = (id, kind, title, target, content, placement, reason) => plan.changes.push({ id, kind, title, target, content, placement, reason });
    for (const name of PAGE_NAMES.slice(1)) {
      if (source.pages[name].page.value === null) {
        change(`create-${slug(name)}`, "create-page", `Create ${name}`, `page:${name}`, "", "Create an empty page with no blocks.", "The named routine page is missing; no sample or active tasks are added.");
      }
    }
    if (!root) {
      if (source.pages.Templates.page.value === null) {
        change("create-templates", "create-page", "Create Templates", "page:Templates", "", "Create an empty page before adding the new template.", "Templates is needed only as the destination for the missing daily-default template.");
      }
      const content = "- یادداشت روزانه\n  template:: daily-default\n  template-including-parent:: false\n" + SETUP_SECTIONS.map((section) => `  - ## ${section}`).join("\n");
      change("create-daily-default", "create-template", "Create daily-default", "page:Templates", content,
        "Append one new top-level template block after all existing page blocks; the six headings are its direct children, in the listed order.",
        "Global lookup found no daily-default template; propose only six empty headings, without tasks or review prompts.");
    } else {
      for (const section of analysis.missing) {
        change(`append-${slug(section)}`, "append-section", `Add ${section}`, `block:${root.uuid}`, `## ${section}`,
          "Append as a new last direct child of the identified template block, in plan order; do not rewrite, reparent, or reorder existing blocks.",
          "This expected heading is absent from the sampled daily-default template tree.");
      }
    }
    if (plan.blockers.length) plan.changes = [];
    else plan.status = "draft";
  } catch {
    return incomplete();
  }
  try {
    const bytes = new TextEncoder().encode(canonicalSetupJSON({ evidence: source, plan }));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    if (!(digest instanceof ArrayBuffer) || digest.byteLength !== 32) throw new Error("Invalid digest.");
    plan.id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    plan.status = "blocked";
    plan.changes = [];
    plan.blockers.push("Native SHA-256 fingerprinting is unavailable or failed; no identifiable plan can be proposed.");
  }
  return plan;
}
