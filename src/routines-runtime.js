import { createActivationStorage, graphIdentity } from "./activation-storage.js";
import { createCalendarClient } from "./calendar-client.js";
import { gregorianPeriods, localCivilDate, makePeriod, matchesPeriodMetadata } from "./period-model.js";
import { createPeriodSnapshot } from "./period-snapshot.js";
import { ensureRoutineHistory } from "./routine-history.js";
import { installDailyJournalTemplate, syncDailyTemplateContext } from "./daily-template.js";
import { applyDailyTemplateToToday } from "./daily-today.js";
import { DAILY_PRESENTATION_STYLE } from "./daily-presentation.js";
import { createPageWithTextProperties } from "./page-metadata.js";

const SETTINGS = "journal-routines:routines:v1:";
const SEEN = "journal-routines:period-seen:v1:";
const EXAMPLE_SEEN = "journal-routines:examples:v1:";
const INITIALIZATION = "journal-routines:initialization:v1:";
const KINDS = ["weekly", "monthly"];
const PERSIAN_MONTHS = Object.freeze(["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"]);
const DEFAULT_DEFINITIONS = Object.freeze({
  weekly: "Journal & Routines — Weekly definition",
  monthly: "Journal & Routines — Monthly definition",
});

// Logseq needs a nonempty parent block to open only the editable task subtree,
// without rendering the page-properties pre-block. The zero-width anchor has no heading text.
const SUMMARY_ANCHOR = "\u200B";
const EXAMPLES = Object.freeze({
  gregorian: {
    weekly: ["TODO Plan the week", "TODO Review the week"],
    monthly: ["TODO Set monthly goals", "TODO Review monthly progress"],
  },
  jalali: {
    weekly: ["TODO برنامه‌ریزی هفته", "TODO مرور کارهای هفته"],
    monthly: ["TODO تعیین هدف‌های ماه", "TODO مرور پیشرفت ماه"],
  },
});
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const EXAMPLE_RESOURCES = [["weekly", "period"], ["monthly", "period"],
  ["weekly", "definition"], ["monthly", "definition"]];
const defaults = () => ({ version: 1, enabled: false, onboarding: "pending", calendar: "gregorian", autoOpen: true,
  definitions: { ...DEFAULT_DEFINITIONS } });

function validateSettings(value) {
  if (value === null) return defaults();
  if (!value || value.version !== 1 || typeof value.enabled !== "boolean" ||
    typeof value.autoOpen !== "boolean" || !["gregorian", "jalali"].includes(value.calendar) ||
        (value.onboarding !== undefined && !["pending", "skipped", "completed"].includes(value.onboarding)) ||
    !value.definitions || KINDS.some((kind) => typeof value.definitions[kind] !== "string" ||
      !value.definitions[kind].trim()) ||
    value.definitions.weekly.trim().toLowerCase() === value.definitions.monthly.trim().toLowerCase()) {
    throw new Error("Invalid graph routines settings; definition pages must be distinct and settings valid.");
  }
  return { version: 1, enabled: value.enabled, calendar: value.calendar,
      onboarding: value.onboarding ?? "completed",
    autoOpen: value.autoOpen, definitions: { ...value.definitions } };
}

function nextDayDelay(now) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return Math.max(1000, Math.min(2_147_483_647, next.getTime() - now.getTime()));
}

/**
 * Only exact current resources are read automatically. Commands/UI belong to register.js.
 * Each request captures its generation AND graph before joining the write queue.
 * Already-dispatched SDK writes cannot be rolled back at a graph switch.
 */
export function createRoutinesRuntime({ sdk, storage = createActivationStorage(), now = () => new Date(),
  timers = globalThis, document = globalThis.document } = {}) {
  if (!sdk?.App?.getCurrentGraph || !sdk?.Editor?.getPage || !storage?.get || !storage?.set) {
    throw new TypeError("Routines require a Logseq SDK and get/set storage.");
  }
  let started = false, destroyed = false, generation = 0, context = null;
  let queue = Promise.resolve(), timer = null, offGraph = null, observing = false;
  let currentIds = null, lastDay = null, lastError = null, automatic = null, dailyTemplateWarning = null;
  const opened = new Set(), stopped = new Set(), clients = new Set();
  const sidebarRoots = new Map();
  function styleSidebarRoots() {
    if (typeof sdk.provideStyle !== "function") return;
    sdk.provideStyle({ key: "jr-sidebar-roots", style: [...sidebarRoots.values()].map(({ id, title }) => {
      const root = `#right-sidebar .ls-block[blockid="${id}"]`;
      const heading = `#right-sidebar .sidebar-item:has(.ls-block[blockid="${id}"]) > div > .sidebar-item-header .page-ref`;
      const cssText = (text) => JSON.stringify(text).replace(/</g, "\\3c ");
      const detailed = typeof title === "object";
      const caption = cssText(detailed ? title.label : title);
      // Presentation only: retain the native link, snapshot subtree and page identity.
      return `${root} > .block-main-container { display: none; }
        ${root} > .block-children-container { margin-left: 0; padding-left: 0; }
        ${root} > .block-children-container > .block-children-left-border { display: none; }
        ${heading} { font-size: 0; display: inline-flex; flex-direction: column; align-items: stretch;
          direction: ${detailed ? "rtl" : "ltr"}; line-height: 1.4; max-width: 100%; white-space: normal; }
        ${heading}::before { content: ${caption}; font-size: 1rem; unicode-bidi: isolate; }
        ${heading}::after { content: ${detailed ? cssText(title.range) : '""'}; font-size: 0.8rem;
          font-weight: 400; opacity: 0.75; direction: ${detailed ? title.rangeDirection : "ltr"};
          unicode-bidi: isolate; text-align: ${detailed ? "right" : "left"}; }`;
    }).join("\n") });
  }
  function clearSidebarStyles() {
    if (!sidebarRoots.size) return;
    sidebarRoots.clear();
    styleSidebarRoots();
  }

  function clearSchedule() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (observing) {
      document?.removeEventListener("visibilitychange", resume);
      document?.removeEventListener("resume", resume);
      observing = false;
    }
  }
  function invalidate() {
    generation++;
    clearSchedule();
    opened.clear();
    clearSidebarStyles();
    currentIds = null;
    lastDay = null;
    automatic = null;
    dailyTemplateWarning = null;
    for (const client of clients) void client.invalidate();
  }
  function active(ctx = context) { return !!ctx?.settings.enabled && !stopped.has(ctx.key); }
  function localGuard(ticket) {
    if (!started || destroyed) throw new Error("Routines runtime is not started.");
    if (ticket.generation !== generation) throw new Error("Routines work was cancelled; graph or activation changed.");
  }
  async function guard(ticket, requireEnabled = false) {
    localGuard(ticket);
    const identity = await graphIdentity(sdk);
    localGuard(ticket);
    if (identity.key !== ticket.key) throw new Error("Graph changed; routines work stopped.");
    if (requireEnabled && (context?.key !== ticket.key || !active())) throw new Error("Routines work was disabled for this session.");
    return identity;
  }
  async function checked(ticket, operation, requireEnabled = false) {
    await guard(ticket, requireEnabled);
    const result = await operation();
    await guard(ticket, requireEnabled);
    return result;
  }
  function capture(expectedGraphKey) {
    const token = generation;
    // Start the identity read NOW, not when earlier queued work finishes.
    const request = graphIdentity(sdk).then((identity) => {
      const ticket = { generation: token, key: identity.key };
      localGuard(ticket);
      if (expectedGraphKey !== undefined && expectedGraphKey !== identity.key) {
        throw new Error("Graph changed since setup; refresh setup before continuing.");
      }
      return ticket;
    });
    void request.catch(() => {});
    return request;
  }
  async function report(error, ticket) {
    try { await guard(ticket); } catch { return; }
    const text = error instanceof Error ? error.message : String(error);
    if (lastError === text) return;
    lastError = text;
    if (sdk.UI?.showMsg) {
      try { await checked(ticket, () => sdk.UI.showMsg(`Journal & Routines: ${text}`, "warning")); }
      catch { /* Reporting must not replace the original error or leak into another graph. */ }
    }
  }
  function enqueue(action, expectedGraphKey, request = capture(expectedGraphKey)) {
    const work = queue.then(async () => {
      const ticket = await request;
      try { await guard(ticket); return await action(ticket); }
      catch (error) { await report(error, ticket); throw error; }
    });
    queue = work.catch(() => {});
    return work;
  }
  async function identityContext(ticket, reload = false) {
    const identity = await guard(ticket);
    if (reload || context?.key !== ticket.key) {
      const settings = validateSettings(await checked(ticket, () => storage.get(SETTINGS + ticket.key)));
      if (context?.key !== ticket.key) {
        clearSchedule();
        opened.clear();
        clearSidebarStyles();
        currentIds = null;
        lastDay = null;
        lastError = null;
        dailyTemplateWarning = null;
      }
      if (context?.settings.calendar !== settings.calendar ||
        KINDS.some((kind) => context?.settings.definitions[kind] !== settings.definitions[kind])) {
        currentIds = null;
        lastDay = null;
      }
      const initialization = await checked(ticket, () => storage.get(INITIALIZATION + ticket.key));
      if (initialization !== null && (initialization?.version !== 1 ||
          !["pending", "verified"].includes(initialization.state) ||
          !["definitions", "periods", "examples"].includes(initialization.phase) ||
          !["gregorian", "jalali"].includes(initialization.calendar) ||
          typeof initialization.seedExamples !== "boolean" ||
          !initialization.definitions || !initialization.periods ||
          KINDS.some((kind) => typeof initialization.definitions[kind] !== "string" ||
            typeof initialization.periods[kind] !== "string"))) {
        throw new Error("Invalid routine initialization record; inspect setup before continuing.");
      }
      context = { key: ticket.key, name: identity.name, settings, initialization };
      if (!active()) clearSchedule();
    } else context.name = identity.name;
    return context;
  }
  async function save(ctx, settings, ticket) {
    await checked(ticket, () => storage.set(SETTINGS + ctx.key, settings));
    ctx.settings = settings;
  }
  function getStatus() {
    return { started, graphKey: context?.key ?? null, graphName: context?.name ?? null,
      enabled: active(), calendar: context?.settings.calendar ?? null,
            onboarding: context?.settings.onboarding ?? null,
      autoOpen: context?.settings.autoOpen ?? null,
      definitions: context ? { ...context.settings.definitions } : null,
      initialization: context?.initialization?.state ?? null,
      paused: !!context?.settings.enabled && stopped.has(context.key),
      error: lastError ?? (context?.initialization?.state === "pending"
        ? "Routine initialization is unfinished. Open Setup and explicitly retry; ambiguous writes will remain paused for inspection." : null),
      dailyTemplateWarning };
  }
  function refreshStatus() {
    return enqueue(async (ticket) => {
      await identityContext(ticket, true);
      // Reading setup status never initializes pages or grants activation.
      return getStatus();
    });
  }
  function skipOnboarding(expectedGraphKey) {
    return enqueue(async (ticket) => {
      const ctx = await identityContext(ticket);
      if (ctx.settings.onboarding === "pending") {
        await save(ctx, { ...ctx.settings, onboarding: "skipped" }, ticket);
      }
      return getStatus();
    }, expectedGraphKey);
  }
  function resume() {
    if (document?.visibilityState !== "hidden") void refreshAutomatic().catch(() => {});
  }
  function schedule(ticket) {
    if (ticket.generation !== generation || context?.key !== ticket.key) return;
    clearSchedule();
    if (!started || destroyed || !active()) return;
    if (document?.addEventListener) {
      document.addEventListener("visibilitychange", resume);
      document.addEventListener("resume", resume);
      observing = true;
    }
    timer = timers.setTimeout(() => {
      timer = null;
      if (ticket.generation === generation) void refreshAutomatic(ticket.key).catch(() => {});
    }, nextDayDelay(now()));
  }
  async function periods(calendar, ticket, date = now()) {
    if (calendar === "gregorian") {
      const selected = gregorianPeriods(date);
      const short = (iso) => new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "short", day: "numeric" })
        .format(new Date(`${iso}T12:00:00Z`));
      const weekly = `Week · ${short(selected.weekly.start)}–${short(selected.weekly.end)}`;
      const monthly = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
      return {
        weekly: { ...selected.weekly, displayTitle: weekly, pageName: `${weekly} — ${selected.weekly.start}` },
        monthly: { ...selected.monthly, displayTitle: monthly, pageName: `${monthly} — ${selected.monthly.start}` },
      };
    }
    const client = createCalendarClient({ invoke: (...args) =>
      checked(ticket, () => sdk.App.invokeExternalPlugin(...args)) });
    clients.add(client);
    try {
      const day = localCivilDate(date);
      const description = await client.describeDate(day);
      // The label is attached to a seven-day snapshot, not the day viewed. Resolve
      // the provider's week number at the Saturday boundary across Nowruz too.
      const weekStart = description.week.start === day ? description : await client.describeDate(description.week.start);
      const weekEnd = description.week.end === day ? description : await client.describeDate(description.week.end);
      await guard(ticket);
      const digits = new Intl.NumberFormat("fa-IR", { useGrouping: false });
      const weekly = `هفتهٔ ${digits.format(weekStart.persian.weekOfYear)} · ${digits.format(weekStart.persian.year)}`;
      const monthly = `${PERSIAN_MONTHS[description.persian.month - 1]} ${digits.format(description.persian.year)}`;
      const jalaliDay = (value) => `${digits.format(value.day)} ${PERSIAN_MONTHS[value.month - 1]}`;
      const weekRange = `${jalaliDay(weekStart.persian)} – ${jalaliDay(weekEnd.persian)}`;
      const gregorianDay = (iso) => new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC", month: "short", day: "numeric",
      }).format(new Date(`${iso}T12:00:00Z`));
      return {
        weekly: { ...makePeriod({ calendar, kind: "weekly", start: description.week.start, end: description.week.end,
          pageName: `${weekly} — ${description.week.start}` }), displayTitle: weekly,
          sidebarTitle: { label: `هفتهٔ ${digits.format(weekStart.persian.weekOfYear)}`,
            range: weekRange, rangeDirection: "rtl" } },
        monthly: { ...makePeriod({ calendar, kind: "monthly", start: description.month.start, end: description.month.end,
          pageName: `${monthly} — ${description.month.start}` }), displayTitle: monthly,
          sidebarTitle: { label: PERSIAN_MONTHS[description.persian.month - 1],
            range: `${gregorianDay(description.month.start)} – ${gregorianDay(description.month.end)}`,
            rangeDirection: "ltr" } }
      };
    } catch (error) {
      await guard(ticket);
      throw new Error(`Persian Calendar API unavailable/incompatible; enable or reload it and retry. ${error.message}`);
    } finally { clients.delete(client); await client.destroy(); }
  }
  async function ensurePeriod(ctx, period, ticket) {
    const marker = SEEN + ctx.key + ":" + period.id;
    const seen = await checked(ticket, () => storage.get(marker), true);
    const legacy = makePeriod({ calendar: period.calendar, kind: period.kind, start: period.start, end: period.end });
    if (seen !== null && seen !== true) {
      if (seen?.version !== 2 || typeof seen.pageName !== "string") {
        throw new Error(`Invalid saved creation marker for ${period.pageName}`);
      }
      // A provider display-label change does not change the civil period or its
      // stored page name. Ownership metadata still guards the exact resolved page.
      makePeriod({ calendar: period.calendar, kind: period.kind, start: period.start,
        end: period.end, pageName: seen.pageName });
    }
    // Probe only the two exact names for this period. Never recreate a renamed or
    // deliberately deleted page just because a different naming scheme is active.
    const candidates = seen === true ? [legacy.pageName] : seen ? [seen.pageName] :
      [period.pageName, legacy.pageName];
    const found = [];
    for (const name of new Set(candidates)) {
      const page = await checked(ticket, () => sdk.Editor.getPage(name), true);
      if (page === undefined) throw new Error(`Period lookup is ambiguous: ${name}`);
      if (page !== null) found.push({ name, page });
    }
    if (found.length > 1) throw new Error(`Both period page names exist for ${period.id}; inspect before continuing.`);
    const name = found[0]?.name ?? (seen === true ? legacy.pageName : seen?.pageName ?? period.pageName);
    const resolved = { ...period, pageName: name };
    const page = found[0]?.page ?? null;
    if (page === null && seen) throw new Error(`Previously attempted period is unavailable: ${name}. This graph path has a saved creation record, but the page cannot be found. Creation may have failed, or the page may have been renamed, deleted or lost during graph reload. Reusing an emptied graph folder retains this record. No automatic recreation; inspect the graph before continuing.`);
    if (page === null) {
      // Durable BEFORE any page write: ambiguous creation never refills a deleted page.
      await checked(ticket, () => storage.set(marker, { version: 2, pageName: name }), true);
    }
    const result = await createPeriodSnapshot({ sdk, period: resolved, definitionPage: ctx.settings.definitions[period.kind],
      displayTitle: name === legacy.pageName ? period.displayTitle : SUMMARY_ANCHOR,
      guard: () => guard(ticket, true), allowCreate: page === null });
    if (!seen && page !== null) await checked(ticket, () => storage.set(marker, { version: 2, pageName: name }), true);
    const actual = await checked(ticket, () => sdk.Editor.getPage(name), true);
    if (!actual || !Number.isSafeInteger(actual.id) || actual.id <= 0 || !matchesPeriodMetadata(actual.properties, period)) {
      throw new Error(`Period ownership or page ID cannot be verified: ${name}`);
    }
    return { ...result, id: actual.id, uuid: actual.uuid, period: resolved };
  }
  async function openPages(entries, ticket, force) {
    if (typeof sdk.Editor.openInRightSidebar !== "function") throw new Error("Native sidebar API unavailable.");
    if (entries.some((entry) => entry.viewUnavailable)) {
      throw new Error("Routine summary block could not be verified; open the period page manually to inspect it. No page was opened in the sidebar or rebuilt.");
    }
    // Logseq prepends newly opened panes: request month first to show week above it.
    for (const entry of [...entries].reverse()) {
      if (!force && opened.has(entry.period.id)) continue;
      const page = await checked(ticket, () => sdk.Editor.getPage(entry.period.pageName), true);
      if (!page || page.id !== entry.id || !matchesPeriodMetadata(page.properties, entry.period)) {
        throw new Error(`Period page changed before sidebar open: ${entry.period.pageName}`);
      }
      let target = entry.id;
      sidebarRoots.delete(entry.period.kind);
      if (entry.viewBlockId) {
        const block = await checked(ticket, () => sdk.Editor.getBlock(entry.viewBlockId), true);
        const label = block?.content?.split("\n").filter((line) => !/^\s*id::/i.test(line)).join("\n").trim();
        if (block?.uuid?.toLowerCase() !== entry.viewBlockId.toLowerCase() ||
          block.page?.id !== entry.id || block.parent?.id !== entry.id ||
          !UUID.test(entry.viewBlockId)) {
          throw new Error(`Routine summary block changed before sidebar open: ${entry.period.pageName}`);
        }
        target = entry.viewBlockId;
        if (["Tasks", SUMMARY_ANCHOR].includes(label)) {
          sidebarRoots.set(entry.period.kind, {
            id: target,
            title: entry.period.sidebarTitle ?? entry.period.pageName.replace(/ — \d{4}-\d{2}-\d{2}$/, ""),
          });
        }
      }
      styleSidebarRoots();
      if (await checked(ticket, () => sdk.Editor.openInRightSidebar(target), true) === false) {
        throw new Error("Sidebar open request failed.");
      }
      opened.add(entry.period.id);
    }
  }
  async function syncOptionalDailyTemplate(ctx, ticket) {
    try {
      await syncDailyTemplateContext({ sdk, storage, graphKey: ticket.key, guard: () => guard(ticket), settings: ctx.settings });
      dailyTemplateWarning = null;
    } catch (error) {
      await guard(ticket);
      dailyTemplateWarning = `Daily template context is unavailable; its task views may be outdated. ${error.message} Finish editing or inspect the template, then retry Install daily journal template. Routine settings are saved independently.`;
    }
  }
  async function saveInitialization(ctx, record, ticket) {
    await checked(ticket, () => storage.set(INITIALIZATION + ctx.key, record));
    const saved = await checked(ticket, () => storage.get(INITIALIZATION + ctx.key));
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error("Routine initialization record could not be verified.");
    ctx.initialization = record;
  }
  async function runCurrent(ticket, force = false, skipOpen = false, initializing = false, expectedPeriods = null) {
    const ctx = await identityContext(ticket);
    if (!active(ctx)) return getStatus();
    if (!initializing && ctx.initialization?.state === "pending") {
      throw new Error("Routine initialization is unfinished. Open Setup and explicitly retry; no automatic starter writes or sidebar opening were attempted.");
    }
    try {
      const date = now(), day = localCivilDate(date);
      if (!force && lastDay === day) return getStatus();
      const selected = await periods(ctx.settings.calendar, ticket, date);
      if (expectedPeriods && KINDS.some((kind) => expectedPeriods[kind] !== selected[kind].id)) {
        throw new Error("Current periods changed during initialization. Inspect the original attempt; no different periods were initialized.");
      }
      await syncOptionalDailyTemplate(ctx, ticket);
      if (!initializing) {
        const examples = await checked(ticket, () => storage.get(`${EXAMPLE_SEEN}${ctx.key}:${selected.weekly.id}:${selected.monthly.id}`), true);
        if (examples?.completed === false || (examples && (!Array.isArray(examples.pages) ||
            !Array.isArray(examples.attempted) || examples.pages.some((page, index) =>
              !Array.isArray(page.ids) || examples.attempted[index] !== page.ids.length)))) {
          throw new Error("Routine examples have an unfinished or ambiguous write. Inspect the original pages, then use More options → Add two examples per routine to explicitly verify the attempt; no automatic refill or sidebar opening was attempted.");
        }
      }
      await guard(ticket, true);
      const ids = KINDS.map((kind) => selected[kind].id);
      if (!force && currentIds?.every((id, i) => id === ids[i])) {
        lastDay = day;
        return getStatus();
      }
      const entries = [];
      for (const kind of KINDS) entries.push(await ensurePeriod(ctx, selected[kind], ticket));
      if ((initializing || skipOpen) && entries.some((entry) => entry.viewUnavailable)) {
        throw new Error("Routine summary block could not be verified; inspect the original period page. Initialization was not confirmed and no content was rebuilt.");
      }
      if (entries.some((entry) => !entry.viewBlockId)) {
        // A manually seeded v1 page has a summary outside its older creation plan.
        // Only the exact graph-local write marker can identify that summary; missing
        // markers simply fall back to the verified native page.
        const marker = await checked(ticket, () => storage.get(`${EXAMPLE_SEEN}${ctx.key}:${selected.weekly.id}:${selected.monthly.id}`), true);
        for (const [index, entry] of entries.entries()) {
          const saved = marker?.version === 1 && marker.pages?.[index];
          if (!entry.viewBlockId && saved?.name === entry.period.pageName && saved.uuid === entry.uuid?.toLowerCase() &&
            saved.id === entry.id && saved.plan?.version === 1 && saved.ids?.[0] === saved.viewBlockId &&
            marker.attempted?.[index] === saved.ids.length && UUID.test(saved.viewBlockId)) {
            entry.viewBlockId = saved.viewBlockId;
          }
        }
      }
      if (initializing && localCivilDate(now()) !== day) throw new Error("Current day changed during initialization; verification remains unfinished.");
      if (!skipOpen && (force || ctx.settings.autoOpen)) await openPages(entries, ticket, force);
      currentIds = ids;
      lastDay = day;
      lastError = null;
      if (!skipOpen && entries.some((entry) => entry.empty && entry.status !== "existing") && sdk.UI?.showMsg) {
        await checked(ticket, () => sdk.UI.showMsg("Journal & Routines: A routine definition is empty. Edit its definition page to affect future periods; this period stays empty.", "warning"), true);
      }
      return { ...getStatus(), periods: entries.map(({ period, status, empty }) => ({ period, status, empty })) };
    } finally { schedule(ticket); }
  }
  function refreshAutomatic(expectedGraphKey, trailing) {
    const day = trailing?.day ?? localCivilDate(now());
    if (automatic?.generation === generation) {
      // A resume/day event may arrive while yesterday's SDK operation is pending.
      // Retain one trailing check, capturing its graph at the EVENT, not execution.
      if (automatic.day !== day && automatic.trailing?.day !== day) {
        automatic.trailing = { day, request: capture(expectedGraphKey) };
      }
      return automatic.work;
    }
    const pending = { generation, day, trailing: null,
      work: enqueue((ticket) => runCurrent(ticket), expectedGraphKey, trailing?.request) };
    automatic = pending;
    void pending.work.finally(() => {
      if (automatic !== pending) return;
      automatic = null;
      if (pending.trailing) void refreshAutomatic(expectedGraphKey, pending.trailing).catch(() => {});
    }).catch(() => {});
    return pending.work;
  }
  async function start() {
    if (destroyed) throw new Error("Routines runtime was destroyed.");
    if (started) return getStatus();
    started = true;
    if (typeof sdk.provideStyle === "function") sdk.provideStyle({ key: "jr-daily-presentation", style: DAILY_PRESENTATION_STYLE });
    if (typeof sdk.App.onCurrentGraphChanged === "function") {
      offGraph = sdk.App.onCurrentGraphChanged(() => {
        invalidate();
        context = null;
        lastError = null;
        void refreshAutomatic().catch(() => {});
      });
    }
    try { return await refreshAutomatic(); }
    catch { return getStatus(); }
  }
  function definitionPage(page, name) {
    if (page === undefined) throw new Error(`Definition lookup is ambiguous: ${name}`);
    if (page && (page["journal?"] === true || page.isJournal === true ||
      (page.format != null && page.format !== "markdown"))) {
      throw new Error(`Definition must be an ordinary Markdown page: ${name}`);
    }
  }
  function configure(options, expectedGraphKey, { confirmCalendarChange = false } = {}) {
    // Snapshot options as well as graph identity: queued callers cannot mutate approval/data.
    let requested;
    try {
      if (!options || typeof options !== "object" || Array.isArray(options) ||
        Object.keys(options).some((key) => !["calendar", "autoOpen", "definitions"].includes(key))) {
        throw new TypeError("Expected calendar, autoOpen and/or definitions settings.");
      }
      if (Object.hasOwn(options, "definitions") && (!options.definitions ||
        typeof options.definitions !== "object" || Array.isArray(options.definitions) ||
        Object.keys(options.definitions).some((kind) => !KINDS.includes(kind)))) {
        throw new TypeError("Expected weekly/monthly definition page names.");
      }
      requested = structuredClone(options);
      if (requested.definitions) {
        for (const kind of Object.keys(requested.definitions)) {
          if (typeof requested.definitions[kind] === "string") requested.definitions[kind] = requested.definitions[kind].trim();
        }
      }
    } catch (error) { return Promise.reject(error); }
    return enqueue(async (ticket) => {
      const ctx = await identityContext(ticket);
      const settings = validateSettings({ ...ctx.settings, ...requested,
        definitions: { ...ctx.settings.definitions, ...requested.definitions } });
      const changedCalendar = settings.calendar !== ctx.settings.calendar;
      const changedDefinitions = KINDS.some((kind) => settings.definitions[kind] !== ctx.settings.definitions[kind]);
      if (ctx.initialization?.state === "pending" && (changedCalendar || changedDefinitions)) {
        throw new Error("Routine initialization is unfinished; inspect or retry it before changing calendar or definition pages.");
      }
      if (changedDefinitions && ctx.settings.enabled) throw new Error("Disable before selecting a different definition page; old snapshots stay unchanged.");
      if (changedCalendar && confirmCalendarChange !== true) throw new Error("Calendar switch requires explicit UI confirmation; no setting was changed.");
      if (changedCalendar && settings.calendar === "jalali") await periods(settings.calendar, ticket);
      if (changedDefinitions) {
        for (const kind of KINDS) {
          const name = settings.definitions[kind];
          definitionPage(await checked(ticket, () => sdk.Editor.getPage(name)), name);
        }
      }
      await save(ctx, settings, ticket);
      if (changedCalendar || changedDefinitions) { currentIds = null; lastDay = null; }
      if (changedCalendar || changedDefinitions) await syncOptionalDailyTemplate(ctx, ticket);
      lastError = null;
      // Configuration is settings-only. The UI awaits it before explicit Enable.
      return getStatus();
    }, expectedGraphKey);
  }
  function enable(expectedGraphKey) {
    return enqueue(async (ticket) => {
      const ctx = await identityContext(ticket);
      const selected = await periods(ctx.settings.calendar, ticket);
      let attempt = ctx.initialization?.state === "pending" ? ctx.initialization : null;
      if (attempt) {
        if (attempt.calendar !== ctx.settings.calendar || KINDS.some((kind) =>
            attempt.definitions[kind] !== ctx.settings.definitions[kind] || attempt.periods[kind] !== selected[kind].id)) {
          throw new Error("Unfinished initialization belongs to different settings or periods. Inspect the original routine pages; no new setup was started.");
        }
        if (attempt.phase === "definitions") {
          throw new Error("Definition creation outcome is ambiguous. Inspect the definition pages; setup will not adopt or recreate an interrupted definition write.");
        }
        for (const name of Object.values(attempt.definitions)) {
          const page = await checked(ticket, () => sdk.Editor.getPage(name));
          definitionPage(page, name);
          if (!page || !UUID.test(page.uuid) || !Number.isSafeInteger(page.id) || page.id <= 0) {
            throw new Error(`Previously initialized definition is unavailable: ${name}. Inspect the page; no automatic recreation was attempted.`);
          }
        }
      } else if (!active(ctx)) {
        const existing = {};
        for (const kind of KINDS) {
          const name = ctx.settings.definitions[kind];
          existing[kind] = await checked(ticket, () => sdk.Editor.getPage(name));
          definitionPage(existing[kind], name);
        }
        let seedExamples = KINDS.every((kind) => existing[kind] === null && ctx.settings.definitions[kind] === DEFAULT_DEFINITIONS[kind]);
        if (seedExamples) {
          for (const kind of KINDS) {
            const period = selected[kind];
            const legacy = makePeriod({ calendar: period.calendar, kind, start: period.start, end: period.end });
            if (await checked(ticket, () => storage.get(`${SEEN}${ctx.key}:${period.id}`)) !== null) seedExamples = false;
            for (const name of new Set([period.pageName, legacy.pageName])) {
              const page = await checked(ticket, () => sdk.Editor.getPage(name));
              if (page === undefined) throw new Error(`Period lookup is ambiguous: ${name}`);
              if (page !== null) seedExamples = false;
            }
          }
        }
        attempt = { version: 1, state: "pending", phase: "definitions", seedExamples,
          calendar: ctx.settings.calendar, definitions: { ...ctx.settings.definitions },
          periods: Object.fromEntries(KINDS.map((kind) => [kind, selected[kind].id])) };
        await saveInitialization(ctx, attempt, ticket);
        for (const kind of KINDS) {
          if (existing[kind] !== null) continue;
          const name = ctx.settings.definitions[kind];
          try {
            const page = await createPageWithTextProperties({ editor: sdk.Editor, name,
              properties: {}, guard: () => guard(ticket) });
            definitionPage(page, name);
          } catch (error) { throw new Error(`Definition creation outcome is ambiguous for ${name}: ${error.message}`); }
        }
        attempt = { ...attempt, phase: "periods" };
        await saveInitialization(ctx, attempt, ticket);
      }
      if (!active(ctx)) {
        await save(ctx, { ...ctx.settings, enabled: true }, ticket);
        stopped.delete(ctx.key);
      }
      if (attempt) {
        // Verification is not navigation: bypass caches but leave panes untouched.
        await runCurrent(ticket, true, true, true, attempt.periods);
        if (attempt.seedExamples) {
          attempt = { ...attempt, phase: "examples" };
          await saveInitialization(ctx, attempt, ticket);
          await insertExamples(ticket, attempt.periods);
        }
        await runCurrent(ticket, true, true, true, attempt.periods);
        await saveInitialization(ctx, { ...attempt, state: "verified" }, ticket);
      } else await runCurrent(ticket, true, true);
      if (ctx.settings.onboarding !== "completed") await save(ctx, { ...ctx.settings, onboarding: "completed" }, ticket);
      // Only the explicit Show action forces opening. Initialization honors autoOpen
      // and retains session tracking of panes the user manually closed.
      if (ctx.settings.autoOpen) {
        currentIds = null;
        lastDay = null;
        await runCurrent(ticket);
      }
      return getStatus();
    }, expectedGraphKey);
  }
  function disable(expectedGraphKey) {
    // Cancel immediately, including already-queued manual actions. Persistence failure
    // must NOT let a visibility event/reload of status restart automatic work this session.
    invalidate();
    if (context && (expectedGraphKey === undefined || expectedGraphKey === context.key)) stopped.add(context.key);
    const request = capture(expectedGraphKey);
    const stopRequest = request.then((ticket) => { stopped.add(ticket.key); return ticket; });
    void stopRequest.catch(() => {});
    return enqueue(async (ticket) => {
      const ctx = await identityContext(ticket);
      await save(ctx, { ...ctx.settings, enabled: false }, ticket);
      lastError = null;
      return getStatus();
    }, expectedGraphKey, stopRequest);
  }
  // Default starter definitions are seeded once on first Enable. The same
  // preflighted operation remains available explicitly for older empty periods.
  async function insertExamples(ticket, expectedPeriods = null) {
      const ctx = await identityContext(ticket);
      if (!active(ctx)) throw new Error("Enable routines for this graph before adding examples.");
      if (typeof sdk.Editor.getPageBlocksTree !== "function" || typeof sdk.Editor.getBlock !== "function" ||
        typeof sdk.Editor.insertBlock !== "function" || !globalThis.crypto?.subtle) {
        throw new Error("Example block verification or insertion is unavailable.");
      }
      const day = localCivilDate(now());
      const current = await periods(ctx.settings.calendar, ticket);
      if (expectedPeriods && KINDS.some((kind) => expectedPeriods[kind] !== current[kind].id)) {
        throw new Error("Current periods changed during initialization. Inspect the original attempt; no different periods were seeded.");
      }
      const selected = {};
      for (const kind of KINDS) selected[kind] = (await ensurePeriod(ctx, current[kind], ticket)).period;
      const resources = EXAMPLE_RESOURCES.map(([kind, type]) => ({ kind, type,
        name: type === "period" ? selected[kind].pageName : ctx.settings.definitions[kind],
        period: selected[kind], content: EXAMPLES[ctx.settings.calendar][kind] }));
      if (new Set(resources.map((resource) => resource.name.toLowerCase())).size !== 4) {
        throw new Error("Selected routine pages overlap; no examples were written.");
      }
      const identity = new Map();
      async function exampleId(resource, page, index, content = resource.content[index]) {
        const bytes = new TextEncoder().encode(JSON.stringify([ticket.key, resource.type, resource.kind,
          resource.name, page.uuid.toLowerCase(), index, content]));
        const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)).slice(0, 16);
        hash[6] = (hash[6] & 15) | 64;
        hash[8] = (hash[8] & 63) | 128;
        const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      function preBlock(block) {
        const flags = ["preBlock", "preBlock?", "pre-block?", "block/pre-block?"]
          .filter((key) => Object.hasOwn(block, key)).map((key) => block[key]);
        if (flags.some((flag) => typeof flag !== "boolean" || flag !== flags[0])) throw new Error("Ambiguous page header marker; no examples were written.");
        return flags[0] === true;
      }
      function properties(entity, keys) {
        const result = {};
        for (const field of ["properties", "block/properties"]) {
          if (!Object.hasOwn(entity, field)) continue;
          const source = entity[field];
          if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Malformed page properties; no examples were written.");
          for (const [name, value] of Object.entries(source)) {
            const key = keys.find((item) => name.toLowerCase() === item || name.toLowerCase() === item.replaceAll("-", ""));
            if (!key) continue;
            if (typeof value !== "string" || (Object.hasOwn(result, key) && result[key] !== value)) {
              throw new Error("Conflicting page properties; no examples were written.");
            }
            result[key] = value;
          }
        }
        return result;
      }
      function headerProperties(header, keys) {
        if (typeof header.content !== "string" || header.content.split("\n").some((line) => line.trim() && !/^\s*[^\s:]+::\s*.*$/.test(line))) {
          throw new Error("Page header contains content; no examples were written.");
        }
        const text = {};
        for (const line of header.content.split("\n")) {
          const match = /^\s*([^\s:]+)::\s*(.*?)\s*$/.exec(line);
          if (!match) continue;
          const key = keys.find((item) => match[1].toLowerCase() === item || match[1].toLowerCase() === item.replaceAll("-", ""));
          if (!key) continue;
          if (match[1].toLowerCase() !== key || Object.hasOwn(text, key)) throw new Error("Conflicting page header text; no examples were written.");
          text[key] = match[2];
        }
        const map = properties(header, keys);
        if (keys.some((key) => map[key] !== text[key])) throw new Error("Page header properties disagree with text; no examples were written.");
        return map;
      }
      function childUUID(child) {
        if (Array.isArray(child)) return child.length === 2 && child[0] === "uuid" && UUID.test(child[1]) ? child[1].toLowerCase() : null;
        return typeof child?.uuid === "string" ? child.uuid.toLowerCase() : null;
      }
      async function verifyBlock(block, id, content, page, parentId, leftId, children = 0) {
        const lines = typeof block?.content === "string" ? block.content.split("\n") : [];
        const plain = lines.filter((line) => !/^\s*id::\s*/i.test(line));
        const identities = lines.filter((line) => /^\s*id::\s*/i.test(line));
        if (!block || preBlock(block) || block.uuid?.toLowerCase() !== id ||
          !Number.isSafeInteger(block.id) || block.id <= 0 ||
          block.page?.id !== page.id || block.parent?.id !== parentId || block.left?.id !== leftId ||
          !Array.isArray(block.children) || block.children.length !== children ||
          plain.join("\n") !== content ||
          identities.length > 1 || (identities.length === 1 && identities[0].trim().toLowerCase() !== `id:: ${id}`)) {
          throw new Error("Selected page has content other than unchanged examples or its planned summary.");
        }
        const actual = await checked(ticket, () => sdk.Editor.getBlock(id, { includeChildren: true }), true);
        if (!actual || actual.id !== block.id || actual.uuid?.toLowerCase() !== id ||
          actual.content !== block.content || actual.page?.id !== page.id ||
          actual.parent?.id !== parentId || actual.left?.id !== leftId ||
          !Array.isArray(actual.children) || actual.children.length !== children ||
          actual.children.some((child, index) => !childUUID(child) || childUUID(child) !== childUUID(block.children[index]))) {
          throw new Error("Example block or planned summary changed during verification.");
        }
      }
      async function inspect(resource) {
        const page = await checked(ticket, () => sdk.Editor.getPage(resource.name), true);
        if (!page || !UUID.test(page.uuid) || !Number.isSafeInteger(page.id) || page.id <= 0 ||
          page.format !== "markdown" || page["journal?"] === true || page.isJournal === true) {
          throw new Error(`Selected ${resource.type} page is missing or unsupported: ${resource.name}`);
        }
        if (resource.type === "period" && !matchesPeriodMetadata(page.properties, resource.period)) {
          throw new Error(`Period ownership changed; no examples were written: ${resource.name}`);
        }
        const previous = identity.get(resource.name);
        if (previous && (previous.uuid !== page.uuid || previous.id !== page.id)) {
          throw new Error(`Selected page changed during example insertion: ${resource.name}`);
        }
        identity.set(resource.name, { uuid: page.uuid, id: page.id });
        const raw = await checked(ticket, () => sdk.Editor.getPageBlocksTree(page.uuid), true);
        if (!Array.isArray(raw)) throw new Error(`Cannot read selected page blocks: ${resource.name}`);
        const tree = [];
        for (const entry of raw) {
          const tuple = Array.isArray(entry);
          if (tuple && (entry.length !== 2 || entry[0] !== "uuid" || !UUID.test(entry[1]))) throw new Error("Ambiguous block reference; no examples were written.");
          const block = tuple ? await checked(ticket, () => sdk.Editor.getBlock(entry[1], { includeChildren: true }), true) : entry;
          if (!block || !UUID.test(block.uuid) || (tuple && block.uuid.toLowerCase() !== entry[1].toLowerCase())) {
            throw new Error("Ambiguous page block; no examples were written.");
          }
          tree.push(block);
        }
        const header = tree[0] && preBlock(tree[0]) ? tree.shift() : null;
        if (resource.type === "period" && !header || tree.some(preBlock)) throw new Error("Missing or misplaced page header; no examples were written.");
        if (header) {
          if (!UUID.test(header.uuid) || !Number.isSafeInteger(header.id) || header.id <= 0 ||
            header.uuid.toLowerCase() === page.uuid.toLowerCase() || header.id === page.id ||
            header.page?.id !== page.id || header.parent?.id !== page.id || header.left?.id !== page.id ||
            !Array.isArray(header.children ?? []) || (header.children ?? []).length ||
            header.format != null && header.format !== "markdown") {
            throw new Error("Invalid page header; no examples were written.");
          }
          const actual = await checked(ticket, () => sdk.Editor.getBlock(header.uuid, { includeChildren: true }), true);
          if (!actual || actual.id !== header.id || !preBlock(actual) ||
            actual.page?.id !== page.id || actual.parent?.id !== page.id || actual.left?.id !== page.id ||
            !Array.isArray(actual.children ?? []) || (actual.children ?? []).length) {
            throw new Error("Page header changed; no examples were written.");
          }
          if (resource.type === "period") {
            const keys = ["jr-period-id", "jr-calendar", "jr-kind", "jr-start", "jr-end", "jr-snapshot-plan", "jr-snapshot-state"];
            const pageMap = properties(page, keys.slice(0, -1));
            const map = headerProperties(actual, keys);
            if (!matchesPeriodMetadata(map, resource.period) ||
              keys.slice(0, -1).some((key) => pageMap[key] !== map[key])) {
              throw new Error(`Period ownership or plan changed: ${resource.name}`);
            }
            let plan;
            try { plan = JSON.parse(map["jr-snapshot-plan"]); } catch { /* fail closed below */ }
            const title = plan?.version === 2 ? plan.displayTitle : resource.period.displayTitle;
            if (![1, 2].includes(plan?.version) || !Array.isArray(plan.ids) ||
              plan.ids.length !== (plan.version === 2 ? 1 : 0) ||
              (plan.version === 2 && !UUID.test(plan.ids[0])) ||
              typeof title !== "string" || !title.trim() || title.trim() !== title ||
              /[\x00-\x1f\x7f]/.test(title) || /^\s*(?:TODO|DOING|NOW|LATER|WAITING|DONE|CANCELED|CANCELLED)\b/i.test(title) ||
              /^\s*[^\s:]+::/.test(title) || /^\s*:LOGBOOK:\s*$/i.test(title) || /^\s*(`{3,}|~{3,})/.test(title) ||
              !/^[\da-f]{64}$/.test(plan.hash) ||
              map["jr-snapshot-state"] !== (plan.version === 1 ? "empty" : "populated")) {
              throw new Error(`Period plan is not a completed empty snapshot: ${resource.name}`);
            }
            const planned = plan.version === 2 ? [{ parent: null, content: title }] : [];
            const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(planned)));
            const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
            if (fingerprint !== plan.hash) throw new Error(`Period plan does not describe an empty definition: ${resource.name}`);
            resource.plan = plan;
            resource.title = title;
          } else headerProperties(actual, []);
        } else if (resource.type === "definition" && Object.keys(page.properties ?? {}).length) {
          throw new Error("Definition properties have no verifiable header; no examples were written.");
        }
        const rootId = resource.type === "period" ? resource.plan.version === 2
          ? resource.plan.ids[0].toLowerCase() : await exampleId(resource, page, 0, resource.title) : null;
        const ids = await Promise.all(resource.content.map((content, index) =>
          exampleId(resource, page, resource.type === "period" ? index + 1 : index, content)));
        if (resource.type === "period" && resource.plan.version === 1) ids.unshift(rootId);
        const identities = [page.uuid.toLowerCase(), header?.uuid?.toLowerCase(),
          ...(resource.plan?.version === 1 ? [] : [rootId]), ...ids].filter(Boolean);
        if (new Set(identities).size !== identities.length) {
          throw new Error(`Example UUID collides with a page block: ${resource.name}`);
        }
        let root = null, examples = tree;
        if (resource.type === "period") {
          if (tree.length > 1 || (resource.plan.version === 2 && tree.length !== 1)) {
            throw new Error(`Unexpected content on selected page: ${resource.name}`);
          }
          root = tree[0] ?? null;
          if (root) {
            if (!Array.isArray(root.children) || root.children.length > 2) throw new Error(`Unexpected summary children: ${resource.name}`);
            await verifyBlock(root, rootId, resource.title, page, page.id, header.id, root.children.length);
            examples = [];
            for (const entry of root.children) {
              const id = childUUID(entry);
              if (!id) throw new Error(`Ambiguous summary child: ${resource.name}`);
              const block = Array.isArray(entry) ? await checked(ticket, () => sdk.Editor.getBlock(id, { includeChildren: true }), true) : entry;
              if (block?.uuid?.toLowerCase() !== id) throw new Error(`Summary child changed: ${resource.name}`);
              examples.push(block);
            }
          }
          if (resource.plan.version === 1) examples = root ? [root, ...examples] : [];
        }
        if (examples.length > ids.length) throw new Error(`Unexpected content on selected page: ${resource.name}`);
        for (const [index, block] of examples.entries()) {
          if (resource.type === "period" && resource.plan.version === 1 && index === 0) continue;
          const childIndex = resource.type === "period" && resource.plan.version === 1 ? index - 1 : index;
          const parentId = resource.type === "period" ? root.id : page.id;
          const leftId = childIndex ? examples[index - 1].id : resource.type === "period" ? root.id : header?.id ?? page.id;
          await verifyBlock(block, ids[index], resource.content[childIndex], page, parentId, leftId);
        }
        return { page, header, root, examples, ids, written: examples.length, viewBlockId: rootId };
      }
      async function preflight() {
        const states = [];
        for (const resource of resources) states.push(await inspect(resource));
        return states;
      }
      // Check all four BEFORE any write, then again before each insert. A failed or
      // ambiguous SDK write stops here; only a later explicit click can reconcile it.
      let states = await preflight();
      const markerKey = `${EXAMPLE_SEEN}${ticket.key}:${selected.weekly.id}:${selected.monthly.id}`;
      const pagesOf = (current) => current.map(({ page, ids, viewBlockId }, index) => ({
        name: resources[index].name, uuid: page.uuid.toLowerCase(), id: page.id, ids,
        ...(viewBlockId ? { viewBlockId, plan: {
          version: resources[index].plan.version, hash: resources[index].plan.hash, title: resources[index].title,
        } } : {}),
      }));
      const pages = pagesOf(states);
      const saved = await checked(ticket, () => storage.get(markerKey), true);
      let marker;
      if (saved === null) {
        // Existing exact-looking blocks without the marker are NOT evidence that
        // this action wrote them. Never adopt them or create more alongside them.
        if (states.some(({ written }) => written)) throw new Error("Unrecognized existing examples; no blocks were written.");
        marker = { version: 1, pages, attempted: [0, 0, 0, 0], completed: false };
        await checked(ticket, () => storage.set(markerKey, marker), true);
      } else {
        marker = saved;
      }
      async function verifyMarker() {
        const actual = await checked(ticket, () => storage.get(markerKey), true);
        if (!actual || actual.version !== 1 || JSON.stringify(actual.pages) !== JSON.stringify(pagesOf(states)) ||
          !Array.isArray(actual.attempted) || actual.attempted.length !== 4 ||
          actual.attempted.some((count, index) => !Number.isInteger(count) || count < 0 || count > pages[index].ids.length) ||
          JSON.stringify(actual.attempted) !== JSON.stringify(marker.attempted)) {
          throw new Error("Example attempt marker is missing or changed; no blocks were written.");
        }
        for (let r = 0; r < resources.length; r++) {
          if (states[r].written !== actual.attempted[r]) {
            throw new Error(`An attempted example was deleted or its write is ambiguous: ${resources[r].name}`);
          }
        }
      }
      await verifyMarker();
      let inserted = 0;
      for (let r = 0; r < resources.length; r++) {
        for (let i = states[r].written; i < states[r].ids.length; i++) {
          states = await preflight();
          if (localCivilDate(now()) !== day) throw new Error("Current day changed during example insertion; no further writes.");
          await verifyMarker();
          if (states[r].written !== i) throw new Error("Example page changed before insertion; no further writes.");
          const { page, header, root, examples, ids } = states[r];
          if (await checked(ticket, () => sdk.Editor.getBlock(ids[i]), true) !== null) {
            throw new Error("Example block UUID is occupied or lookup is ambiguous; no further writes.");
          }
          const period = resources[r].type === "period";
          const rootWrite = period && resources[r].plan.version === 1 && i === 0;
          const firstChild = period && (resources[r].plan.version === 1 ? i === 1 : i === 0);
          const anchor = rootWrite ? header.uuid : firstChild ? root.uuid : i ? examples[i - 1].uuid : header?.uuid ?? page.uuid;
          const content = rootWrite ? resources[r].title : resources[r].content[period && resources[r].plan.version === 1 ? i - 1 : i];
          // Persist intent BEFORE the uncancellable SDK write. If the write is lost
          // or the user deletes it, a retry pauses rather than refilling it.
          marker = { ...marker, attempted: marker.attempted.map((count, index) => index === r ? i + 1 : count) };
          await checked(ticket, () => storage.set(markerKey, marker), true);
          const persisted = await checked(ticket, () => storage.get(markerKey), true);
          if (JSON.stringify(persisted) !== JSON.stringify(marker)) throw new Error("Example write intent could not be verified.");
          const result = await checked(ticket, () => sdk.Editor.insertBlock(anchor, content, {
            sibling: rootWrite || !firstChild && Boolean(i || header),
            isPageBlock: !period && !i && !header, focus: false, customUUID: ids[i],
          }), true);
          if (result?.uuid?.toLowerCase() !== ids[i]) throw new Error("Example insert outcome is ambiguous; inspect the page before retrying.");
          states[r] = await inspect(resources[r]);
          if (states[r].written !== i + 1) throw new Error("Example insert could not be verified; inspect the page before retrying.");
          inserted++;
        }
      }
      states = await preflight();
      await verifyMarker();
      if (states.some((state) => state.written !== state.ids.length)) throw new Error("Routine examples are not fully verified; inspect the pages before continuing.");
      marker = { ...marker, completed: true };
      await checked(ticket, () => storage.set(markerKey, marker), true);
      if (JSON.stringify(await checked(ticket, () => storage.get(markerKey), true)) !== JSON.stringify(marker)) {
        throw new Error("Routine example completion could not be verified.");
      }
      return { graphKey: ticket.key, inserted, viewBlockIds: {
        weekly: pages[0].viewBlockId, monthly: pages[1].viewBlockId,
      } };
  }
  function addExamples(expectedGraphKey) {
    if (typeof expectedGraphKey !== "string" || !expectedGraphKey) {
      return Promise.reject(new TypeError("Add examples requires the selected graph key."));
    }
    return enqueue((ticket) => insertExamples(ticket), expectedGraphKey);
  }
  function showCurrent(expectedGraphKey) { return enqueue((ticket) => runCurrent(ticket, true), expectedGraphKey); }
  function openDefinition(kind) {
    if (!KINDS.includes(kind)) return Promise.reject(new TypeError("Unknown definition kind."));
    return enqueue(async (ticket) => {
      const ctx = await identityContext(ticket);
      if (typeof sdk.App.pushState !== "function") throw new Error("Page navigation unavailable.");
      const name = ctx.settings.definitions[kind];
      await checked(ticket, () => sdk.App.pushState("page", { name }));
      return name;
    });
  }
  function showHistory() {
    return enqueue(async (ticket) => {
      await identityContext(ticket);
      if (typeof sdk.App.pushState !== "function") throw new Error("Page navigation unavailable.");
      const page = await ensureRoutineHistory({ sdk, storage, graphKey: ticket.key, guard: () => guard(ticket) });
      await checked(ticket, () => sdk.App.pushState("page", { name: page.pageName }));
      return page;
    });
  }

  function installDailyTemplate(expectedGraphKey, { replaceExisting = false } = {}) {
    if (typeof expectedGraphKey !== "string" || !expectedGraphKey || typeof replaceExisting !== "boolean") {
      return Promise.reject(new TypeError("Daily template installation requires the selected graph and explicit replacement choice."));
    }
    return enqueue(async (ticket) => {
      const ctx = await identityContext(ticket);
      if (!active(ctx)) throw new Error("Enable routines in this graph before installing its optional daily template.");
      const result = await installDailyJournalTemplate({ sdk, storage, graphKey: ticket.key,
        guard: () => guard(ticket, true), settings: ctx.settings, replaceExisting });
      lastError = null;
      dailyTemplateWarning = null;
      if (sdk.UI?.showMsg) await checked(ticket, () => sdk.UI.showMsg(
        "Daily journal template installed. Logseq applies it to eligible empty journals from today onward; populated journals are unchanged. Verify config persistence after reload.", "success"), true);
      return { ...getStatus(), dailyTemplate: result };
    }, expectedGraphKey);
  }

  function applyDailyTemplateToday(expectedGraphKey, { skipUnavailable = false } = {}) {
    if (typeof expectedGraphKey !== "string" || !expectedGraphKey) return Promise.reject(new TypeError("Apply to today requires the selected graph key."));
    return enqueue(async (ticket) => {
      const ctx = await identityContext(ticket);
      if (!active(ctx)) throw new Error("Enable routines before applying the daily template to today.");
      let result;
      try {
        result = await applyDailyTemplateToToday({ sdk, storage, graphKey: ticket.key, guard: () => guard(ticket, true) });
      } catch (error) {
        await guard(ticket, true);
        if (!skipUnavailable || !["today-not-empty", "today-missing", "today-previous-attempt"].includes(error.code)) throw error;
        lastError = null;
        return { applied: false, reason: error.message };
      }
      lastError = null;
      if (typeof sdk.App.pushState === "function") await checked(ticket, () => sdk.App.pushState("page", { name: result.pageName }), true);
      return { ...result, applied: true };
    }, expectedGraphKey);
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    started = false;
    invalidate();
    if (typeof sdk.provideStyle === "function") sdk.provideStyle({ key: "jr-daily-presentation", style: "" });
    offGraph?.();
    for (const client of clients) await client.destroy();
    storage.close?.();
  }
  return { start, destroy, enable, disable, configure, refreshStatus, showCurrent,
    openDefinition, showHistory, addExamples, installDailyTemplate, applyDailyTemplateToday, skipOnboarding, getStatus };
}
