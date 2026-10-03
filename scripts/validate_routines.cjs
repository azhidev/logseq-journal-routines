#!/usr/bin/env node
"use strict";

// Browser/SDK fixture only: this does not validate actual Logseq sidebar panes,
// query evaluation/rendering, native template application/config persistence,
// Calendar transport, or IndexedDB durability.
const assert = require("node:assert/strict");
const { fixtureDOM, resolveChrome } = require("./browser-fixture.cjs");
const { mkdtempSync, writeFileSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

async function browserFixture(registerRoutines, createRoutinesRuntime) {
  const results = [];
  const output = document.getElementById("fixture-result");
  const errors = [];
  const onError = (event) => errors.push(String(event.error?.stack || event.message));
  const onRejection = (event) => errors.push(String(event.reason?.stack || event.reason));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const clone = (value) => structuredClone(value);
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  async function until(predicate, label) {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      check(performance.now() < deadline, `Timed out: ${label}; UI: ${document.querySelector('[role=alert]')?.textContent}`);
      check(!errors.length, errors.join("\n"));
      await delay(10);
    }
  }
  async function test(name, action) {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.stack || String(error) }); throw error; }
  }
  const button = (label) => {
    const node = [...document.querySelectorAll(".jr-routines button")].find((node) => node.textContent === label);
    check(node, `Missing button: ${label}`);
    return node;
  };
  async function click(label, { closes = false, error = false } = {}) {
    const node = button(label);
    if (node.closest(".jr-routines-advanced")?.hidden) button("More options").click();
    check(!node.disabled && !node.closest("[hidden]"), `Button unavailable: ${label}`);
    node.click();
    await until(() => closes ? !document.querySelector(".jr-routines") :
      document.querySelector('[role=dialog]')?.getAttribute("aria-busy") === "false", label);
    if (!error && !closes) equal(document.querySelector('[role=alert]').textContent, "", `${label} error`);
  }
  const field = (name) => document.querySelector(`[name="${name}"]`);
  function selectCalendar(value) {
    check(!field("calendar").disabled, "Calendar field disabled");
    field("calendar").value = value;
    field("calendar").dispatchEvent(new Event("change", { bubbles: true }));
  }

  const calls = [], records = new Map(), pages = new Map(), entities = new Map();
  const commands = new Map(), graphListeners = new Set(), timers = new Map();
  let toolbar, model;
  const listeners = new Map(), sidebar = new Set([900001]);
  let nextId = 100, nextUUID = 0, storageClosed = 0, unload, registration, runtime;
  let calendarAllowed = false, calendarFailure = false;
  const payload = '<img src=x onerror="window.fixtureInjected=true">';
  const graph = { path: "/fixture-only/journal-routines", name: `Smoke ${payload}` };
  const definitions = { weekly: `Weekly ${payload}`, monthly: "Monthly smoke routines" };
  const historyName = "Journal & Routines — History";
  const dailyTemplateName = "Journal & Routines — Daily";
  const dailyTemplatePage = "Journal & Routines — Daily template";
  const graphConfigs = { "default-templates": { journals: "Existing daily template", pages: "Existing page template", extra: "preserve me" },
    "preferred-format": "markdown" };
  const uuid = () => `00000000-0000-4000-8000-${String(++nextUUID).padStart(12, "0")}`;
  const log = (name, ...args) => calls.push([name, ...clone(args)]);
  const named = (name) => calls.filter((call) => call[0] === name);
  const writes = () => calls.filter((call) => ["createPage", "insertBlock", "updateBlock", "property", "setGraphConfigs"].includes(call[0]));
  const pageBy = (key) => typeof key === "string" ? pages.get(key.toLowerCase()) || entities.get(key) : entities.get(key);
  function pageEntity(page) {
    if (!page) return null;
    const { blocks, ...metadata } = page;
    return clone(metadata);
  }
  function addPage(name, properties = {}) {
    check(!pages.has(name.toLowerCase()), `Duplicate fixture page: ${name}`);
    const page = { id: ++nextId, uuid: uuid(), name: name.toLowerCase(), originalName: name,
      format: "markdown", "journal?": false, properties: clone(properties), blocks: [] };
    pages.set(page.name, page);
    entities.set(page.uuid, page); entities.set(page.id, page);
    // Logseq 0.10.15: properties create a distinct pre-block despite
    // createFirstBlock:false; getPageBlocksTree includes this header.
    if (Object.keys(properties).length) {
      const header = addBlock(page, page, propertyContent(properties));
      header.preBlock = true;
      header.properties = clone(properties);
    }
    return page;
  }
  function propertyContent(properties) {
    return Object.entries(properties).map(([key, value]) => `${key}:: ${value}`).join("\n");
  }
  function nativeProperties(content) {
    const properties = {};
    for (const line of content.split("\n")) {
      const match = /^([a-z][a-z0-9-]*):: (.+)$/.exec(line);
      if (!match) continue;
      check(!Object.hasOwn(properties, match[1]), "Duplicate native property");
      properties[match[1]] = match[1] === "template-including-parent" && match[2] === "false" ? false : match[2];
    }
    return properties;
  }
  const headerOf = (page) => page.blocks.find((block) => block.preBlock === true);
  const contentBlocks = (page) => page.blocks.filter((block) => block.preBlock !== true);
  function addBlock(page, parent, content, id = uuid(), index) {
    check(!entities.has(id), `Duplicate fixture UUID: ${id}`);
    const siblings = parent === page ? page.blocks : parent.children;
    index ??= siblings.length;
    const block = { id: ++nextId, uuid: id, content, properties: {}, children: [],
      page: { id: page.id }, parent: { id: parent.id },
      left: { id: index === 0 ? parent.id : siblings[index - 1].id } };
    siblings.splice(index, 0, block);
    if (siblings[index + 1]) siblings[index + 1].left.id = block.id;
    entities.set(block.uuid, block); entities.set(block.id, block);
    return block;
  }
  function blockEntity(block, includeChildren) {
    if (!block || block.blocks) return null;
    return clone({ ...block, children: includeChildren ? block.children.map((child) =>
      blockEntity(child, true)) : block.children.map((child) => ["uuid", child.uuid]) });
  }
  function strictAPI(name, methods) {
    return new Proxy(methods, { get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      log("unexpected", `${name}.${String(key)}`);
      throw new Error(`Fixture forbids unsupported/broad SDK API: ${name}.${String(key)}`);
    } });
  }
  const weeklySource = addPage(definitions.weekly);
  const external = addPage("Unrelated page");
  const externalBlock = addBlock(external, external, "DONE external task; never rewrite me");
  const sourceRoot = addBlock(weeklySource, weeklySource,
    `DONE Weekly review [[Reference]] ((${externalBlock.uuid}))\nid:: source-identity\ncompleted-at:: yesterday\ncustom:: source-only\nSCHEDULED: <2026-03-20 Fri>\nDEADLINE: <2026-03-21 Sat>\n:LOGBOOK:\nCLOCK: old\n:END:`);
  sourceRoot.properties = { id: sourceRoot.uuid, completedAt: "yesterday", custom: "source-only" };
  addBlock(weeklySource, sourceRoot, `WAITING Nested ${payload}\nCLOSED: [2026-03-20 Fri]`);
  addBlock(weeklySource, sourceRoot, "Plain nested note\n```text\ncustom:: literal code\nDONE literal code\n```");
  addBlock(weeklySource, weeklySource, "Non-task guidance #keep");
  const monthlySource = addPage(definitions.monthly);
  addBlock(monthlySource, monthlySource, "CANCELED Monthly review\ncompleted-at:: yesterday");
  const sourceBefore = JSON.stringify([weeklySource, monthlySource, external]);
  const existingTemplate = addPage("Existing daily template");
  const existingRoot = addBlock(existingTemplate, existingTemplate, "Existing daily content\ntemplate:: Existing daily template");
  existingRoot.properties = nativeProperties(existingRoot.content);
  addBlock(existingTemplate, existingRoot, "Keep my original template section");
  const populatedJournal = addPage("Mar 21st, 2026");
  populatedJournal["journal?"] = true;
  addBlock(populatedJournal, populatedJournal, "TODO Preserve today's populated journal");
  const emptyJournal = addPage("Mar 22nd, 2026");
  emptyJournal["journal?"] = true;
  const journalsBefore = JSON.stringify([populatedJournal, emptyJournal]);
  const existingTemplateBefore = JSON.stringify(existingTemplate);

  const storage = {
    async get(key) { check(!storageClosed, "Read after storage.close"); log("storage.get", key); return clone(records.get(key) ?? null); },
    async set(key, value) { check(!storageClosed, "Write after storage.close"); log("storage.set", key, value); records.set(key, clone(value)); },
    close() { storageClosed++; },
  };
  const sdk = {
    App: strictAPI("App", {
      async getCurrentGraph() { log("graph"); return clone(graph); },
      async getUserConfigs() { log("userConfigs"); return { enabledJournals: true, preferredFormat: "markdown" }; },
      async getCurrentGraphConfigs(key) {
        equal(key, "default-templates", "Only the native default-template map is read");
        log("getGraphConfigs", key); return clone(graphConfigs[key]);
      },
      async setCurrentGraphConfigs(config) {
        equal(Object.keys(config), ["default-templates"], "Only default templates may be configured");
        equal(config["default-templates"], { ...graphConfigs["default-templates"], journals: dailyTemplateName },
          "Journal default replacement preserves all sibling defaults");
        log("setGraphConfigs", config); Object.assign(graphConfigs, clone(config));
      },
      async getTemplate(name) {
        equal(name, dailyTemplateName, "Exact native template lookup");
        log("getTemplate", name);
        const roots = [...entities.values()].filter((entity, index, all) =>
          all.indexOf(entity) === index && !entity.blocks && entity.properties.template === name);
        check(roots.length <= 1, "Native template name must be unique");
        return roots.length ? blockEntity(roots[0], true) : null;
      },
      onCurrentGraphChanged(fn) { graphListeners.add(fn); return () => graphListeners.delete(fn); },
      registerCommandPalette(options, action) {
        check(!commands.has(options.key), "Duplicate command"); commands.set(options.key, action); log("command", options);
      },
      registerUIItem(type, options) {
        equal(type, "toolbar", "Launcher location"); toolbar = options;
      },
      async pushState(route, params) {
        equal(route, "page", "Native route"); check(pageBy(params.name)?.blocks, "Navigation must target an existing page");
        log("route", route, params);
      },
      async invokeExternalPlugin(target, ...args) {
        log("calendar", target, ...args);
        check(calendarAllowed, "Gregorian must not invoke Calendar");
        if (calendarFailure) throw new Error(`Provider unavailable ${payload}`);
        if (target === "persian-calendar.models.getApiInfo") {
          equal(args, [], "Calendar info arguments");
          return { id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"] };
        }
        equal(target, "persian-calendar.models.describeDate", "Calendar target");
        check(args.length === 1 && ["2026-03-21", "2026-03-27"].includes(args[0]), "Only current day and week endpoint sent to Calendar");
        const end = args[0] === "2026-03-27";
        // Fixed responses, not a conversion implementation.
        return {
          gregorian: { year: 2026, month: 3, day: end ? 27 : 21, iso: args[0], journalDay: end ? 20260327 : 20260321 },
          persian: { year: 1405, month: 1, day: end ? 7 : 1, iso: end ? "1405-01-07" : "1405-01-01", label: end ? "جمعه 7 فروردین 1405" : "شنبه 1 فروردین 1405", weekOfYear: 1 },
          week: { start: "2026-03-21", end: "2026-03-27", key: "weekly-20260321" },
          month: { start: "2026-03-21", end: "2026-04-20", key: "monthly-1405-01", financeKey: "1405-01" },
        };
      },
    }),
    Editor: strictAPI("Editor", {
      async getPage(key) { log("getPage", key); const page = pageBy(key); return page?.blocks ? pageEntity(page) : null; },
      async createPage(name, properties, options) {
        equal(options, { redirect: false, createFirstBlock: false, format: "markdown" }, "Safe page options");
        log("createPage", name, properties, options);
        check(properties == null || Object.keys(properties).length === 0, "Nonempty createPage properties cause the Bean regression");
        return pageEntity(addPage(name));
      },
      async getPageBlocksTree(key) {
        log("tree", key); const page = pageBy(key);
        check(page?.blocks, "Exact page tree target");
        // Exercise SDK tuple expansion as well as nested entity children.
        return page.blocks.map((block) => ["uuid", block.uuid]);
      },
      async getBlock(id, options = {}) { log("getBlock", id, options); return blockEntity(entities.get(id), options.includeChildren); },
      async newBlockUUID() { const id = uuid(); log("newBlockUUID", id); return id; },
      async insertBlock(anchor, content, options) {
        log("insertBlock", anchor, content, options);
        equal(Object.keys(options).sort(), ["customUUID", "focus", "isPageBlock", "sibling"], "Narrow insertion options");
        check(options.focus === false && typeof options.customUUID === "string", "Safe block options");
        const target = pageBy(anchor);
        check(target, "Insertion anchor exists");
        check(options.isPageBlock === !!target.blocks, "isPageBlock must match anchor");
        check(!target.blocks || !options.sibling, "Page anchor cannot be a sibling");
        const page = target.blocks ? target : entities.get(target.page.id);
        const parent = options.sibling ? entities.get(target.parent.id) : target;
        const siblings = parent === page ? page.blocks : parent.children;
        const index = options.sibling ? siblings.indexOf(target) + 1 : siblings.length;
        const block = addBlock(page, parent, content, options.customUUID, index);
        // Model Desktop appending the fresh custom UUID property, not source properties.
        block.content += `\nid:: ${block.uuid}`;
        block.properties = /^template:: /m.test(content) ? nativeProperties(block.content) : { id: block.uuid };
        return blockEntity(block, false);
      },
      async checkEditing() { log("checkEditing"); return false; },
      async updateBlock(id, content) {
        log("updateBlock", id, content);
        const block = entities.get(id);
        check(block && !block.blocks, "Metadata target must be a block");
        const page = entities.get(block.page.id);
        if (block.properties.template === dailyTemplateName) {
          check(page.originalName === dailyTemplatePage && page.properties["jr-daily-template-version"] === "v1" &&
            headerOf(page)?.properties["jr-daily-template-state"] === "ready", "Context save requires a ready owned template");
          check(contentBlocks(page)[0] === block && block.parent.id === page.id && block.left.id === headerOf(page).id &&
            !block.preBlock, "Context save targets only the native template root");
          const contextKeys = ["jr-daily-calendar", "jr-weekly-definition", "jr-monthly-definition"];
          const withoutContext = (text) => text.split("\n").filter((line) =>
            !contextKeys.some((key) => line.startsWith(`${key}:: `))).join("\n");
          equal(withoutContext(content), withoutContext(block.content), "Root save preserves all non-context text/properties");
          const properties = nativeProperties(content);
          for (const key of contextKeys) check(typeof properties[key] === "string", "Context property retained");
          check(["gregorian", "jalali"].includes(properties["jr-daily-calendar"]), "Supported root calendar");
          block.content = content;
          block.properties = properties;
          return;
        }
        check(page.blocks[0] === block && block.parent.id === page.id && block.left.id === page.id,
          "Metadata must target the first page root");
        equal(block.children, [], "Metadata has no children");
        const properties = {};
        for (const line of content.split("\n")) {
          const match = /^([a-z][a-z0-9-]*):: (.+)$/.exec(line);
          check(match, "Metadata text must contain only property lines");
          check(!Object.hasOwn(properties, match[1]), "Duplicate property");
          properties[match[1]] = match[2];
        }
        block.content = content;
        block.properties = properties;
        block.preBlock = true;
        page.properties = clone(properties);
      },
      async upsertBlockProperty(id, key, value) {
        log("property", id, key, value);
        const header = entities.get(id);
        check(header?.preBlock === true && !header.blocks, "Checkpoint must target the header block UUID, not the page UUID");
        check(["jr-snapshot-state", "jr-history-state", "jr-daily-template-state"].includes(key), "Unexpected property write");
        header.properties[key] = clone(value);
        header.content = propertyContent(header.properties);
        // Model direct SDK transactions: mutable page.properties remains stale.
      },
      async openInRightSidebar(id) {
        const target = entities.get(id);
        check(target && (target.blocks || typeof id === "string" && target.parent?.id === target.page?.id),
          "Sidebar requires an owned page or root block ID");
        log("sidebar", id); sidebar.add(id);
      },
    }),
    DB: strictAPI("DB", {
      async datascriptQuery(query, ...inputs) {
        check(query.includes("[?p :block/journal-day ?today]") && query.includes("[?p :block/journal? true]"), "Only native today lookup is allowed");
        equal(inputs, [":today"], "Native civil today input, never a formatted journal title");
        log("todayQuery", query, inputs);
        return []; // This fixture has no dated native today page; combined setup must preserve that.
      },
    }),
    UI: strictAPI("UI", { async showMsg(...args) { log("message", ...args); } }),
    beforeunload(fn) { check(!unload, "One unload handler"); unload = fn; },
    provideModel(value) { model = value; },
    showMainUI(options) { log("showUI", options); },
    hideMainUI(options) { log("hideUI", options); },
    setMainUIInlineStyle(style) { log("style", style); },
  };
  // Instrument the real document and real browser timeouts; only the runtime's
  // clock is fixed so current-period assertions are independent of host date/TZ.
  const addListener = document.addEventListener, removeListener = document.removeEventListener;
  document.addEventListener = function (event, fn, options) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn); return addListener.call(this, event, fn, options);
  };
  document.removeEventListener = function (event, fn, options) {
    listeners.get(event)?.delete(fn); return removeListener.call(this, event, fn, options);
  };
  const trackedTimers = {
    setTimeout(fn, ms) {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.set(id, ms); return id;
    },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
  };
  const countListeners = (event) => listeners.get(event)?.size || 0;
  const allListeners = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  const periods = () => [...pages.values()].filter((page) => page.properties["jr-period-id"]);
  const period = (calendar, kind) => periods().find((page) =>
    page.properties["jr-calendar"] === calendar && page.properties["jr-kind"] === kind);
  const flatten = (blocks) => blocks.flatMap((block) => [block, ...flatten(block.children)]);
  const content = (block) => block.content.replace(`\nid:: ${block.uuid}`, "");
  const saved = () => records.get(`journal-routines:routines:v1:${runtime.getStatus().graphKey}`);
  const safeDOM = () => {
    check(!document.querySelector(".jr-routines img, .jr-routines script"), "Untrusted text became HTML");
    check(!window.fixtureInjected, "Untrusted text executed");
  };
  async function register() {
    runtime = createRoutinesRuntime({ sdk, storage, document, timers: trackedTimers, now: () => new Date(2026, 2, 21, 12) });
    registration = await registerRoutines(sdk, { document, runtime });
  }
  async function reload() {
    await registration.destroy();
    equal(storageClosed, 1, "Previous runtime closed its storage handle once");
    equal(graphListeners.size, 0, "Previous registration released graph listeners");
    equal(timers.size, 0, "Previous runtime released timers");
    equal(allListeners(), 0, "Previous view/runtime released document listeners");
    check(!document.querySelector(".jr-routines"), "Previous view removed before re-registration");
    // Reopen a fake storage handle over the same durable records, and use a fresh
    // command registry/unload hook as a new plugin SDK registration would.
    storageClosed = 0;
    commands.clear(); unload = null;
    await register();
  }
  let failure;
  try {
    await test("register/start automatically welcomes a fresh graph without activation or graph writes", async () => {
      await register();
      equal([...commands.keys()], ["setup", "show", "history", "definition-weekly", "definition-monthly", "disable"].map((key) => `journal-routines-${key}`), "Registered commands");
      equal(writes().length, 0, "No startup writes"); equal(named("calendar").length, 0, "No startup Calendar");
      equal(records.size, 0, "No startup storage writes"); equal(timers.size, 0, "No disabled schedule");
      equal(graphListeners.size, 2, "Registration and runtime graph listeners");
      equal(toolbar.key, "journal-routines-open", "Toolbar key");
      check(toolbar.template.includes('data-on-click="openJournalRoutinesSetup"'), "Toolbar model binding");
      check(toolbar.template.includes('aria-label="Open Journal &amp; Routines"'), "Toolbar accessible label");
      equal(document.querySelectorAll(".jr-routines").length, 1, "Fresh welcome mounts automatically once");
      equal(runtime.getStatus().onboarding, "pending", "Fresh graph onboarding is pending");
      check(!runtime.getStatus().enabled, "Welcome does not activate routines");
      check(document.querySelector(".jr-routines").textContent.includes("Welcome to Journal & Routines"), "Welcome heading");
      check(!button("Create my first routine system").disabled, "Explicit creation is available");
      check(!field("autoOpen").disabled, "Auto-open preference is available before creation");
      equal(named("showUI").length, 1, "Automatic welcome uses native showMainUI once");
      equal(named("sidebar").length, 0, "Welcome opens no routine panes"); safeDOM();
    });
    await test("Skip for now persists only a graph-local dismissal without activation", async () => {
      const before = JSON.stringify([...pages.values()]);
      await click("Skip for now", { closes: true });
      equal(saved().onboarding, "skipped", "Skip persisted in graph settings");
      check(!saved().enabled && !runtime.getStatus().enabled, "Skip does not enable routines");
      equal(runtime.getStatus().onboarding, "skipped", "Runtime reflects dismissal");
      equal(JSON.stringify([...pages.values()]), before, "Skip preserves all graph content");
      equal(writes().length, 0, "Skip performs no graph/config writes");
      equal(named("sidebar").length, 0, "Skip opens no sidebar");
      equal(timers.size, 0, "Skip starts no schedule");
    });
    await test("skipped welcome stays dismissed across runtime reload and re-registration", async () => {
      const shows = named("showUI").length, before = JSON.stringify([...records]);
      await reload();
      equal(runtime.getStatus().onboarding, "skipped", "Reload reads graph-local dismissal");
      equal(JSON.stringify([...records]), before, "Reload does not rewrite dismissal or metadata");
      check(!document.querySelector(".jr-routines"), "Skipped graph stays quiet after reload");
      equal(named("showUI").length, shows, "No automatic showMainUI after skipping");
      equal(writes().length, 0, "Skipped reload creates no graph resources");
      equal(named("sidebar").length, 0, "Skipped reload opens no panes");
    });
    await test("toolbar launcher reopens skipped setup and closes without graph writes", async () => {
      await model.openJournalRoutinesSetup();
      equal(document.querySelectorAll(".jr-routines").length, 1, "Toolbar opened one setup view");
      equal(writes().length, 0, "Toolbar setup is read-only");
      await click("Close", { closes: true });
    });
    await test("setup command mounts real DOM with safe text and no activation", async () => {
      await commands.get("journal-routines-setup")();
      equal(document.querySelectorAll(".jr-routines").length, 1, "One setup view");
      equal(document.querySelector('[role=status]').textContent, "Disabled", "Initial status");
      check(document.querySelector(".jr-routines").textContent.includes(graph.name), "Graph name rendered literally");
      check(document.activeElement === field("calendar"), "Initial focus");
      equal(named("showUI").length, 3, "Fresh welcome, toolbar reopen and palette use native showMainUI");
      equal(runtime.getStatus().onboarding, "skipped", "Explicit reopening preserves dismissal until initialization");
      check(!button("Set up this graph").disabled, "Skipped setup still offers explicit initialization");
      equal(writes().length, 0, "Opening setup is read-only"); safeDOM();
    });
    await test("Save Gregorian settings persists graph-scoped choices without enabling", async () => {
      field("weeklyDefinition").value = definitions.weekly;
      field("monthlyDefinition").value = definitions.monthly;
      field("autoOpen").checked = false;
      await click("Save settings");
      equal(saved(), { version: 1, enabled: false, calendar: "gregorian", onboarding: "skipped", autoOpen: false, definitions }, "Saved settings");
      check(/^[a-f0-9]{64}$/.test(runtime.getStatus().graphKey), "Stable hashed graph identity");
      equal(writes().length, 0, "Save creates no graph resources");
      equal(named("sidebar").length, 0, "Save opens no sidebar"); equal(timers.size, 0, "Save starts no timer");
    });
    await test("existing saved installation suppresses welcome even without an onboarding field", async () => {
      // Model settings saved before onboarding existed; no migration is required.
      const key = `journal-routines:routines:v1:${runtime.getStatus().graphKey}`;
      const skipped = clone(saved()), existing = clone(skipped); delete existing.onboarding;
      records.set(key, existing);
      const shows = named("showUI").length, before = JSON.stringify([...records]);
      await reload();
      equal(runtime.getStatus().onboarding, "completed", "Existing settings suppress first-run onboarding");
      check(!document.querySelector(".jr-routines"), "Existing installation does not mount welcome");
      equal(named("showUI").length, shows, "Existing installation makes no automatic UI request");
      equal(JSON.stringify([...records]), before, "Reading existing settings is not a storage migration");
      equal(writes().length, 0, "Existing disabled installation remains graph-read-only");
      await commands.get("journal-routines-setup")();
      check(!button("Set up this graph").disabled, "Existing installation can explicitly reopen setup");
      equal(field("autoOpen").checked, false, "Reload preserves auto-open opt-out");
      // Restore the skipped fixture preferences so the next scenario exercises
      // skipped -> completed through real initialization, not just legacy defaults.
      records.set(key, skipped);
      await reload();
      equal(runtime.getStatus().onboarding, "skipped", "Skipped preferences restored for initialization scenario");
      check(!document.querySelector(".jr-routines"), "Restored dismissal still suppresses welcome");
      await commands.get("journal-routines-setup")();
    });
    await test("explicit Enable initializes current Gregorian periods but respects autoOpen=false", async () => {
      await click("Enable");
      check(saved().enabled && runtime.getStatus().enabled, "Enable persisted and active");
      equal(document.querySelector('[role=status]').textContent, "Enabled", "Enabled UI");
      equal(periods().length, 2, "Exactly two periods");
      for (const [kind, start, end] of [["weekly", "2026-03-16", "2026-03-22"], ["monthly", "2026-03-01", "2026-03-31"]]) {
        const page = period("gregorian", kind);
        check(page, `Missing ${kind}`);
        equal(page.originalName, `${kind === "weekly" ? "Week · Mar 16–Mar 22" : "March 2026"} — ${start}`, "Localized-first, bound-qualified page name");
        for (const [key, value] of Object.entries({ "jr-calendar": "gregorian", "jr-kind": kind,
          "jr-start": start, "jr-end": end, "jr-period-id": `journal-routines:gregorian:${kind}:${start}:${end}` })) {
          equal(page.properties[key], value, key);
          equal(headerOf(page).properties[key], value, `Header immutable ${key}`);
        }
        equal(headerOf(page).properties["jr-snapshot-state"], "populated", "Authoritative header state");
        equal(page.properties["jr-snapshot-state"], "ready:0", "Mutable page state deliberately stale");
        const plan = JSON.parse(page.properties["jr-snapshot-plan"]);
        equal(plan.ids, flatten(contentBlocks(page)).map((block) => block.uuid), "Durable clone identities excluding header");
        check(/^[a-f0-9]{64}$/.test(plan.hash), "Snapshot fingerprint");
      }
      equal(saved().onboarding, "completed", "Successful initialization persists onboarding completion");
      equal(runtime.getStatus().onboarding, "completed", "Runtime reports completed initialization");
      equal(saved().autoOpen, false, "Initialization preserves auto-open opt-out");
      equal(named("sidebar").length, 0, "Enable does not auto-open opted-out panes");
      check(document.querySelector(".jr-routines-feedback").textContent.includes("routines are ready"), "Standalone Enable provides completion feedback");
      check(!button("Open my routines").hidden && !button("Open my routines").disabled, "Standalone Enable offers explicit sidebar handoff");
      check(sidebar.has(900001), "Unrelated sidebar pane preserved");
      equal(named("calendar").length, 0, "Entire Gregorian flow made zero Calendar calls");
      equal(named("createPage").length, 2, "Existing definitions reused; no other page creation");
      check(!pageBy(historyName), "History not generated automatically");
      equal(timers.size, 1, "One day-boundary timeout");
      check([...timers.values()][0] > 60 * 60 * 1000, "No short polling timer");
      equal(countListeners("visibilitychange"), 1, "Visibility listener"); equal(countListeners("resume"), 1, "Resume listener");
    });
    await test("enabled reload stays quiet with autoOpen=false; Open my routines explicitly opens native panes", async () => {
      const before = JSON.stringify(periods()), count = writes().length, shows = named("showUI").length;
      await reload();
      check(runtime.getStatus().enabled, "Enabled graph resumes after reload");
      equal(runtime.getStatus().onboarding, "completed", "Completion survives reload");
      equal(named("showUI").length, shows, "Completed graph does not automatically reopen setup");
      equal(named("sidebar").length, 0, "Enabled startup respects auto-open opt-out");
      equal(JSON.stringify(periods()), before, "Startup reuses initialized snapshots");
      equal(writes().length, count, "Startup does not rewrite snapshots");
      await commands.get("journal-routines-setup")();
      const todayQueries = named("todayQuery").length, configs = clone(graphConfigs);
      field("includeDaily").click();
      check(!field("includeDaily").checked, "Repeated initialization is routines only");
      await click("Set up this graph");
      equal(saved().autoOpen, false, "Repeated setup preserves auto-open opt-out");
      equal(named("sidebar").length, 0, "Repeated setup still respects opt-out");
      equal(writes().length, count, "Repeated setup performs no graph/config writes");
      equal(JSON.stringify(periods()), before, "Repeated setup preserves initialized snapshots");
      equal(named("todayQuery").length, todayQueries, "Routine-only setup performs no today lookup");
      equal(graphConfigs, configs, "Routine-only setup preserves native daily defaults");
      await click("Open my routines", { closes: true });
      equal(named("sidebar").map((call) => call[1]),
        [period("gregorian", "monthly"), period("gregorian", "weekly")].map((page) => contentBlocks(page)[0].uuid),
        "Explicit handoff opens native summary blocks month first so week is above it");
      equal(JSON.stringify(periods()), before, "Explicit handoff preserves initialized tasks");
      equal(writes().length, count, "Explicit handoff creates no duplicate resources");
      check(sidebar.has(900001), "Explicit handoff preserves unrelated pane");
      await commands.get("journal-routines-setup")();
    });
    await test("optional examples refuse to overwrite populated periods and definitions", async () => {
      const before = JSON.stringify(periods()), count = writes().length;
      await click("Add two Persian examples per routine", { error: true });
      check(/completed empty snapshot|content other than unchanged examples/.test(document.querySelector('[role=alert]').textContent),
        "Existing routine content is protected");
      equal(JSON.stringify(periods()), before, "No routine content was changed");
      equal(writes().length, count, "No example write on populated pages");
    });
    await test("TODO clones have fresh identities, correct nesting and stripped source properties", async () => {
      const weekly = period("gregorian", "weekly"), monthly = period("gregorian", "monthly");
      const weekSummary = contentBlocks(weekly)[0], monthSummary = contentBlocks(monthly)[0];
      equal(contentBlocks(weekly).map(content), ["\u200B"], "Week label belongs in page title, not body");
      equal(contentBlocks(monthly).map(content), ["\u200B"], "Month label belongs in page title, not body");
      equal(weekSummary.children.map(content), [`TODO Weekly review [[Reference]] ((${externalBlock.uuid}))`, "Non-task guidance #keep"], "Weekly roots under summary");
      equal(weekSummary.children[0].children.map(content), [`TODO Nested ${payload}`, "Plain nested note\n```text\ncustom:: literal code\nDONE literal code\n```"], "Nested task/prose/code policy");
      equal(monthSummary.children.map(content), ["TODO Monthly review"], "Monthly TODO normalization");
      const cloned = [...flatten(contentBlocks(weekly)), ...flatten(contentBlocks(monthly))];
      equal(new Set(cloned.map((block) => block.uuid)).size, 7, "Fresh summary and clone UUIDs");
      const sourceIds = new Set([...flatten(weeklySource.blocks), ...flatten(monthlySource.blocks)].map((block) => block.uuid));
      for (const block of cloned) {
        check(!sourceIds.has(block.uuid), "Source UUID not copied");
        equal(block.properties, { id: block.uuid }, "Only fresh identity property");
        check(block.page.id === weekly.id || block.page.id === monthly.id, "Clone owns correct page");
      }
      equal(weekSummary.children[0].parent.id, weekSummary.id, "Task roots follow the summary");
      equal(weekSummary.children[1].left.id, weekSummary.children[0].id, "Root sibling order");
      equal(weekSummary.left.id, headerOf(weekly).id, "Summary follows metadata header");
      equal(JSON.stringify([weeklySource, monthlySource, external]), sourceBefore, "Definitions/referenced block untouched"); safeDOM();
    });
    await test("idle browser has no repeated SDK calls or graph writes", async () => {
      const before = calls.length;
      await delay(100);
      equal(calls.length, before, "Idle SDK/storage call count");
      check(!named("getPage").some((call) => call[1] === historyName), "No background history lookup");
    });
    await test("Show current reuses snapshots and preserves completion/deletion edits", async () => {
      const weekly = period("gregorian", "weekly");
      const task = contentBlocks(weekly)[0].children[0];
      task.content = task.content.replace(/^TODO/, "DONE");
      const removed = task.children.pop();
      entities.delete(removed.uuid); entities.delete(removed.id);
      const before = JSON.stringify(periods()), count = writes().length;
      await click("Show current", { closes: true });
      equal(JSON.stringify(periods()), before, "No task reset/refill"); equal(writes().length, count, "No repeated snapshot writes");
      equal(named("sidebar").length, 4, "Explicit Show requests both native pages again");
      equal(sidebar.size, 3, "Fixture sidebar deduplicates page identities");
      equal(countListeners("keydown"), 0, "Closed view releases keyboard listener");
      check(named("hideUI").length > 0, "Navigation hides setup");
    });
    await test("History button creates native query page only on demand and pushState navigates", async () => {
      await commands.get("journal-routines-setup")();
      check(!pageBy(historyName), "Still no history page");
      await click("History", { closes: true });
      const history = pageBy(historyName);
      equal(history.properties, { id: headerOf(history).uuid, "jr-history-version": "v1", "jr-history-state": "initializing" }, "History page retains stale mutable state");
      equal(headerOf(history).properties, { id: headerOf(history).uuid, "jr-history-version": "v1", "jr-history-state": "ready" }, "History header ownership/state");
      equal(history.blocks.length, 3, "Header plus two native query sections");
      equal(contentBlocks(history).length, 2, "Two native query sections excluding header");
      equal(contentBlocks(history)[0].left.id, headerOf(history).id, "First history query follows header");
      for (const [index, kind] of ["weekly", "monthly"].entries()) {
        const query = content(contentBlocks(history)[index]);
        check(query.includes("#+BEGIN_QUERY") && query.includes("#+END_QUERY"), "Native query syntax emitted");
        check(query.includes(`[(= ?kind "${kind}")]`), "Kind filter");
        check(query.includes('#{"gregorian" "jalali"}') && query.includes("[(= ?id ?expected)]"), "Both calendars, ownership filter");
        check(query.includes(":find (pull ?p [*])") && query.includes("(compare b a)"), "Original page results, descending sort expression");
      }
      equal(named("route").at(-1), ["route", "page", { name: historyName }], "Native history navigation");
      const before = JSON.stringify(history), count = writes().length;
      await commands.get("journal-routines-history")();
      equal(JSON.stringify(history), before, "History reused"); equal(writes().length, count, "No history repopulation");
    });
    await test("definition button navigates to selected native page without writes", async () => {
      await commands.get("journal-routines-setup")();
      const count = writes().length;
      await click("Open weekly definition", { closes: true });
      equal(named("route").at(-1), ["route", "page", { name: definitions.weekly }], "Definition navigation");
      equal(writes().length, count, "Navigation does not write");
    });
    await test("calendar confirmation gates Save; Cancel has no side effects", async () => {
      await commands.get("journal-routines-setup")();
      const before = calls.length, state = clone(saved());
      selectCalendar("jalali");
      check(!document.querySelector(".jr-routines-confirmation").hidden, "Confirmation visible");
      check(button("Save settings").disabled, "Cannot save unconfirmed switch");
      button("Save settings").click();
      await click("Cancel calendar change");
      equal(field("calendar").value, "gregorian", "Cancel restores Gregorian");
      equal(calls.length, before, "Cancel made no SDK/storage calls"); equal(saved(), state, "Cancel unchanged settings");
      equal(named("calendar").length, 0, "Gregorian including cancellation never invoked Calendar");
    });
    await test("confirmed unavailable Calendar fails closed and error text is safe", async () => {
      calendarAllowed = true; calendarFailure = true;
      const state = clone(saved()), count = writes().length;
      selectCalendar("jalali"); await click("Confirm calendar change");
      check(!button("Save settings").disabled, "Confirmation allows submission");
      await click("Save settings", { error: true });
      check(document.querySelector('[role=alert]').textContent.includes(payload), "Provider error rendered literally");
      equal(saved(), state, "Failed switch keeps Gregorian settings"); equal(writes().length, count, "Failed switch writes no pages");
      safeDOM(); calendarFailure = false;
      await click("Close", { closes: true });
      await commands.get("journal-routines-setup")();
      equal(field("calendar").value, "gregorian", "Reopened authoritative calendar");
    });
    await test("confirmed Jalali switch creates current periods and preserves Gregorian history", async () => {
      const old = JSON.stringify(periods()), sidebarRequests = named("sidebar").length;
      selectCalendar("jalali");
      // Prior approval must not survive the failed submission/reopened view.
      check(button("Save settings").disabled, "Fresh confirmation required");
      button("Confirm calendar change").click();
      equal(saved().calendar, "gregorian", "Confirmation alone is not a save");
      await click("Save settings");
      equal(saved().calendar, "jalali", "Jalali persisted"); equal(periods().length, 4, "Two additional calendar-qualified periods");
      equal(saved().autoOpen, false, "Jalali switch preserves auto-open opt-out");
      equal(named("sidebar").length, sidebarRequests, "Jalali initialization needs no automatic sidebar opening");
      equal(JSON.stringify(periods().filter((page) => page.properties["jr-calendar"] === "gregorian")), old, "Old periods preserved byte-for-byte");
      equal(period("jalali", "weekly").properties["jr-start"], "2026-03-21", "Saturday start");
      equal(period("jalali", "weekly").properties["jr-end"], "2026-03-27", "Friday end");
      equal(period("jalali", "monthly").properties["jr-end"], "2026-04-20", "Provider month bounds");
      check(named("calendar").some((call) => call[1] === "persian-calendar.models.describeDate"), "Real Calendar client used fake transport");
    });
    await test("daily template UI refuses silent replacement then installs native sections with explicit approval", async () => {
      const before = JSON.stringify([...pages.values()]), count = writes().length, oldPeriods = JSON.stringify(periods());
      check(!field("replaceExisting").checked, "Replacement approval starts unchecked");
      await click("Install daily journal template", { error: true });
      check(document.querySelector('[role=alert]').textContent.includes("Explicitly approve replacement"), "Existing default requires approval");
      equal(writes().length, count, "Refusal has no graph or config writes");
      equal(JSON.stringify([...pages.values()]), before, "Refusal preserves all pages");
      equal(graphConfigs["default-templates"].journals, "Existing daily template", "Refusal preserves current default");
      field("replaceExisting").click();
      const hidden = named("hideUI").length;
      await click("Install daily journal template");
      check(document.querySelector(".jr-routines"), "Installation keeps setup open");
      equal(named("hideUI").length, hidden, "Installation does not navigate or hide setup");
      check(!field("replaceExisting").checked, "Replacement approval reset after installation");
      const page = pageBy(dailyTemplatePage), root = contentBlocks(page)[0];
      equal(page.blocks.length, 2, "Only header and native template root at page level");
      equal(headerOf(page).properties["jr-daily-template-state"], "ready", "Template header checkpoint ready");
      equal(root.properties.template, dailyTemplateName, "Native template root registration");
      equal(root.properties["template-including-parent"], false, "Native parent is excluded");
      equal(root.properties["jr-daily-calendar"], "jalali", "Installed context matches current calendar");
      equal(root.properties["jr-weekly-definition"], `page-uuid:${weeklySource.uuid}`, "Weekly definition context");
      equal(root.properties["jr-monthly-definition"], `page-uuid:${monthlySource.uuid}`, "Monthly definition context");
      equal(root.children.map(content), ["## 🎯 Focus", "## ☑️ Tasks", "## 🚩 Priority A", "## ⏳ Pending", "## 📅 This week"], "Five native sections");
      check(root.children.every((section) => section.children.length === 1), "Each section has its native content child");
      check(root.children.slice(2).every((section) => content(section.children[0]).includes("#+BEGIN_QUERY")), "Task sections use native queries");
      equal(graphConfigs, { "default-templates": { journals: dailyTemplateName, pages: "Existing page template", extra: "preserve me" },
        "preferred-format": "markdown" }, "Config map and unrelated top-level settings preserved");
      equal(JSON.stringify([...pages.values()].filter((item) => item !== page)), before, "Only optional template page added; other pages unchanged");
      equal(JSON.stringify(periods()), oldPeriods, "No routine period changes");
      equal(JSON.stringify([populatedJournal, emptyJournal]), journalsBefore, "No writes to populated or empty journals");
      equal(JSON.stringify(existingTemplate), existingTemplateBefore, "Original default template content preserved");
    });
    await test("repeated daily template installation preserves native content and performs no writes", async () => {
      const before = JSON.stringify([...pages.values()]), config = clone(graphConfigs), count = writes().length;
      check(!field("replaceExisting").checked, "Repeat does not reuse replacement approval");
      await click("Install daily journal template");
      equal(writes().length, count, "No repeat graph or config writes");
      equal(JSON.stringify([...pages.values()]), before, "No template/journal/task rewriting on repeat");
      equal(graphConfigs, config, "No repeated default configuration change");
      check(document.querySelector(".jr-routines"), "Repeat keeps setup open");
    });
    await test("primary setup combines routines and daily installation, with an accurate missing-today result", async () => {
      const count = writes().length, before = JSON.stringify([...pages.values()]);
      check(field("includeDaily").checked, "Daily template is explicitly selected by default");
      await click("Set up this graph");
      equal(writes().length, count, "Existing resources and missing today are not rewritten/created");
      equal(JSON.stringify([...pages.values()]), before, "Combined setup preserves graph content");
      equal(named("todayQuery").length, 1, "Only one native today lookup, not a historical inventory");
      check(document.querySelector(".jr-routines-feedback").textContent.includes("Today was left unchanged"), "Partial completion is reported accurately");
      check(document.querySelector(".jr-routines-feedback").textContent.includes("Open today"), "Missing today has a native-navigation instruction");
      check(document.querySelector(".jr-routines"), "Setup retains the result rather than silently closing");
    });
    await test("routine-only primary setup does not install or apply a daily template", async () => {
      const count = writes().length, todayQueries = named("todayQuery").length, configs = clone(graphConfigs);
      field("includeDaily").click(); await click("Set up this graph");
      equal(named("todayQuery").length, todayQueries, "Opt-out performs no today lookup");
      equal(writes().length, count, "Opt-out does not write template or journal blocks");
      equal(graphConfigs, configs, "Opt-out preserves the existing daily default");
      check(document.querySelector(".jr-routines-feedback").textContent.includes("daily journal default was left unchanged"), "Routine-only success is explicit");
    });
    await test("switch back reuses original Gregorian tasks without Calendar invocation", async () => {
      const before = JSON.stringify(periods()), count = writes().length, calendarCalls = named("calendar").length;
      const root = contentBlocks(pageBy(dailyTemplatePage))[0], sections = JSON.stringify(root.children);
      const configs = clone(graphConfigs), sidebarRequests = named("sidebar").length;
      selectCalendar("gregorian"); await click("Confirm calendar change"); await click("Save settings");
      equal(saved().autoOpen, false, "Gregorian switch preserves auto-open opt-out");
      equal(named("sidebar").length, sidebarRequests, "Gregorian switch does not automatically open opted-out panes");
      equal(saved().calendar, "gregorian", "Switched back"); equal(JSON.stringify(periods()), before, "Both calendars retained");
      equal(writes().slice(count).map((call) => [call[0], call[1]]), [["updateBlock", root.uuid]], "Only the owned template root context is saved");
      equal(root.properties["jr-daily-calendar"], "gregorian", "Template context follows calendar switch");
      equal(JSON.stringify(root.children), sections, "Template section content and identities are never rewritten");
      equal(graphConfigs, configs, "Calendar switch does not change default settings");
      equal(named("calendar").length, calendarCalls, "Gregorian switch needs no provider");
      check(contentBlocks(period("gregorian", "weekly"))[0].children[0].content.startsWith("DONE"), "Completion preserved");
    });
    await test("Disable persists off, cancels timers/listeners and preserves pages/sidebar", async () => {
      const before = JSON.stringify([...pages.values()]), panes = [...sidebar];
      await click("Disable");
      check(!runtime.getStatus().enabled && !saved().enabled, "Disabled persisted");
      equal(timers.size, 0, "Disable cleared day timer");
      equal(countListeners("visibilitychange") + countListeners("resume"), 0, "Disable removed automatic listeners");
      equal(JSON.stringify([...pages.values()]), before, "Disable deletes no graph data"); equal([...sidebar], panes, "Disable leaves all panes alone");
      const count = calls.length;
      document.dispatchEvent(new Event("resume")); document.dispatchEvent(new Event("visibilitychange"));
      await delay(50); equal(calls.length, count, "Disabled lifecycle events do no work");
      equal(graphListeners.size, 2, "Graph listeners retained until unload");
    });
    await test("SDK unload destroys active runtime, DOM, listeners and storage; stale controls inert", async () => {
      await click("Enable");
      equal(timers.size, 1, "Re-enable schedules runtime before unload");
      const before = JSON.stringify([...pages.values()]), staleButton = button("Save settings"), count = named("createPage").length;
      await unload();
      equal(timers.size, 0, "Unload cleared active timer"); equal(graphListeners.size, 0, "Unload graph cleanup");
      equal(allListeners(), 0, "Unload removes all view/runtime document listeners"); equal(storageClosed, 1, "Storage closed once");
      check(!document.querySelector(".jr-routines"), "Unload removes real view");
      check(![...document.querySelectorAll("style")].some((style) => style.textContent.includes(".jr-routines")), "Unload removes view CSS");
      check(!runtime.getStatus().started, "Runtime stopped");
      const callsBefore = calls.length;
      staleButton.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      document.dispatchEvent(new Event("resume"));
      for (const command of commands.values()) await command();
      await model.openJournalRoutinesSetup();
      await unload(); await delay(50);
      equal(calls.length, callsBefore, "Stale controls/commands/toolbar and repeated unload are inert");
      equal(storageClosed, 1, "Idempotent storage cleanup"); equal(named("createPage").length, count, "No reinitialization");
      equal(JSON.stringify([...pages.values()]), before, "Unload retains graph content"); check(sidebar.has(900001), "Unrelated pane retained");
    });
    await test("fixture stayed exact-page, metadata-only, with no hidden browser errors", async () => {
      equal(named("unexpected"), [], "No broad graph scans or unsupported SDK calls");
      check(named("createPage").every((call) => call[2] === null), "Metadata pages created with null properties");
      const root = contentBlocks(pageBy(dailyTemplatePage))[0];
      equal(named("updateBlock").filter((call) => call[1] !== root.uuid).length, 6, "Four period, history and daily-template headers parsed from text");
      equal(named("updateBlock").filter((call) => call[1] === root.uuid).length, 1, "Only one template context save");
      equal(named("checkEditing").length, 8, "Six bootstrap editing checks and two guarded context editing checks");
      equal(named("setGraphConfigs").length, 1, "Only explicit installation changes the native default");
      equal(JSON.stringify([populatedJournal, emptyJournal]), journalsBefore, "Fixture journals remain untouched throughout");
      equal(JSON.stringify(existingTemplate), existingTemplateBefore, "Replaced default content remains intact throughout");
      const allowed = new Set([definitions.weekly, definitions.monthly, historyName, dailyTemplatePage,
        ...periods().flatMap((page) => [page.originalName,
          `Journal & Routines — ${page.properties["jr-calendar"]} ${page.properties["jr-kind"]} — ${page.properties["jr-start"]} to ${page.properties["jr-end"]}`])]);
      check(named("getPage").every((call) => allowed.has(call[1])), "Only selected definition/current/history exact pages read");
      check(named("tree").every((call) => allowed.has(entities.get(call[1])?.originalName)), "No unrelated tree reads");
      const metadata = JSON.stringify([...records]);
      check(!metadata.includes("Weekly review") && !metadata.includes("Monthly review") && !metadata.includes(graph.path), "Storage has no task copies or raw graph path");
      equal(JSON.stringify([weeklySource, monthlySource, external]), sourceBefore, "Source/unrelated data remains intact");
      equal(errors, [], "No browser errors/unhandled rejections"); safeDOM();
    });
  } catch (error) { failure = error.stack || String(error); }
  finally {
    try { if (registration) await registration.destroy(); else if (runtime) await runtime.destroy(); }
    catch (error) { failure ||= `Cleanup: ${error.stack || error}`; }
    for (const id of timers.keys()) clearTimeout(id);
    document.addEventListener = addListener; document.removeEventListener = removeListener;
    window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection);
    output.textContent = encodeURIComponent(JSON.stringify({ fixtureOnly: true, results, failure,
      summary: { tests: results.length, passed: results.filter((result) => result.passed).length,
        sdkCalls: calls.length, pagesCreated: named("createPage").length, sidebarRequests: named("sidebar").length,
        calendarInvocations: named("calendar").length } }));
    output.dataset.complete = "true";
  }
}

async function main() {
  const chrome = resolveChrome();
  assert.ok(chrome && existsSync(chrome), `Chrome not found: ${chrome}`);
  const temp = mkdtempSync(join(tmpdir(), "journal-routines-smoke-"));
  try {
    const bundle = esbuild.buildSync({
      stdin: { contents: `import { registerRoutines } from './src/register.js';\nimport { createRoutinesRuntime } from './src/routines-runtime.js';\n(${browserFixture.toString()})(registerRoutines, createRoutinesRuntime);`,
        resolveDir: resolve(__dirname, ".."), sourcefile: "routines-browser-fixture.js", loader: "js" },
      bundle: true, platform: "browser", format: "iife", target: "chrome120", write: false,
    });
    writeFileSync(join(temp, "fixture.js"), bundle.outputFiles[0].contents);
    const html = join(temp, "fixture.html");
    writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><title>Journal & Routines — fixture only</title></head><body><pre id="fixture-result">RUNNING</pre><script src="fixture.js"></script></body></html>');
    const { stdout, stderr } = await fixtureDOM(chrome, join(temp, "profile"), pathToFileURL(html).href,
      "document.getElementById('fixture-result')?.dataset.complete === 'true'", 45000);
    const match = stdout.match(/<pre\b[^>]*id="fixture-result"[^>]*data-complete="true"[^>]*>([^<]*)<\/pre>/);
    assert.ok(match, `Browser fixture did not report completion.\n${stdout.slice(-4000)}\n${stderr}`);
    const report = JSON.parse(decodeURIComponent(match[1]));
    console.log("Journal & Routines browser smoke — FIXTURE ONLY (fake SDK/storage; not Logseq sidebar/query rendering)");
    for (const [index, result] of report.results.entries()) {
      console.log(`${result.passed ? "ok" : "not ok"} ${index + 1} - ${result.name}`);
      if (!result.passed) console.error(result.error);
    }
    console.log(`Tests: ${report.summary.tests}; passed: ${report.summary.passed}; failed: ${report.summary.tests - report.summary.passed}`);
    console.log(`Fixture pages created: ${report.summary.pagesCreated}; native sidebar requests: ${report.summary.sidebarRequests}; Calendar invocations (Jalali tests): ${report.summary.calendarInvocations}`);
    assert.equal(report.failure, undefined, report.failure);
    assert.equal(report.fixtureOnly, true);
    assert.equal(report.summary.tests, 26, "All smoke scenarios must run");
    assert.equal(report.summary.passed, 26, "All smoke scenarios must pass");
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
