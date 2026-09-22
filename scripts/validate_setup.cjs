// Legacy preview components in Chromium with a strict, read-only SDK fixture.
// Production activation is covered by validate_activation.cjs.
// This does not exercise the SDK bridge or claim live Logseq Desktop validation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

async function browserFixture(source) {
  const groups = [];
  const errors = [];
  const unexpected = [];
  const commands = new Map();
  const toolbar = [];
  const listeners = new Set();
  const intervals = new Set();
  const notices = [];
  const calls = [];
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = (...args) => {
    const id = nativeInterval(...args);
    intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => { intervals.delete(id); nativeClearInterval(id); };
  window.addEventListener("error", (event) => errors.push(event.error?.stack || event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason?.stack || event.reason)));
  console.error = (...args) => errors.push(args.map(String).join(" "));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = (ms = 0) => new Promise((resolve) => nativeTimeout(resolve, ms));
  async function until(predicate, label) {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await wait(10);
    }
    throw new Error(`Timed out: ${label}`);
  }
  function deferred() {
    let resolve;
    const promise = new Promise((yes) => { resolve = yes; });
    return { promise, resolve };
  }
  function strict(name, methods) {
    return new Proxy(methods, {
      get(target, key) {
        if (Object.hasOwn(target, key)) return target[key];
        const message = `${name}.${String(key)}`;
        unexpected.push(message);
        throw new Error(`Unexpected SDK access: ${message}`);
      },
      set(_target, key) {
        unexpected.push(`${name}.${String(key)} assignment`);
        throw new Error("SDK mutation is forbidden");
      },
    });
  }
  const info = { id: "persian-calendar", version: 1, capabilities: ["describe-date", "describe-today", "from-journal-day"] };
  // Plain wire fixtures, not a second Calendar implementation or a live clock.
  const date = {
    gregorian: { year: 2025, month: 3, day: 21, iso: "2025-03-21", journalDay: 20250321 },
    persian: { year: 1404, month: 1, day: 1, iso: "1404-01-01", label: "جمعه 1 فروردین 1404", weekOfYear: 1 },
    week: { start: "2025-03-15", end: "2025-03-21", key: "weekly-20250315" },
    month: { start: "2025-03-21", end: "2025-04-20", key: "monthly-1404-01", financeKey: "1404-01" },
  };
  const sections = ["Focus", "Weekly tasks", "Monthly tasks", "Tasks", "Notes", "End-of-day review"];
  const uuid = (n) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
  const block = (n, content, children = []) => ({ uuid: uuid(n), content, properties: {}, children });
  const privateNote = 'PRIVATE NOTE <img src=x onerror="window.__jrInjected=true"> ' + "private-content-".repeat(40);
  const templateRoot = block(1, "PRIVATE ROOT\ntemplate:: daily-default\ntemplate-including-parent:: false",
    ["Tasks", "Notes"].map((section, i) => block(i + 2, `## ${section}`, [block(i + 20, privateNote)])));
  templateRoot.properties = { template: "daily-default", "template-including-parent": false, custom: "PRIVATE PROPERTY" };
  let complete = false;
  const routineTrees = Object.fromEntries(["Week Routine", "Month Routine"].map((name, i) => [name,
    [block(50 + i * 2, name, [block(51 + i * 2, "DONE PRIVATE ROUTINE TEXT")])],
  ]));
  let engineMode = false, engineTreeGate;
  const dbListeners = new Set();
  const enginePages = [
    { id: 200, uuid: uuid(200), name: "private today", "journal?": true, journalDay: 20250321 },
    { id: 201, uuid: uuid(201), name: "private prior", "journal?": true, journalDay: 20250320 },
    { id: 202, uuid: uuid(202), name: "week routine", "journal?": false },
    { id: 203, uuid: uuid(203), name: "month routine", "journal?": false },
    { id: 204, uuid: uuid(204), name: "private other", "journal?": false },
  ];
  const engineTrees = new Map([
    [uuid(200), [block(210, "## Tasks", [block(211, "PRIVATE engine note")])]],
    [uuid(201), [block(212, "## Weekly tasks\nroutine-loaded:: weekly-20250315", [block(213, "DONE PRIVATE owner task")])]],
    [uuid(202), [block(214, "TODO PRIVATE weekly default")]],
    [uuid(203), [block(215, "TODO PRIVATE monthly default")]],
    [uuid(204), [block(216, "PRIVATE unrelated note")]],
  ]);
  let graph = { name: "Graph A", path: "/fixture/A" };
  let available = true;
  let graphFailure = false;
  let todayGate;
  let model;
  let unload;
  let startup;
  let visible = false;
  let showCount = 0;
  let hideCount = 0;
  let unsubscribeCount = 0;
  let unloadRegistrations = 0;
  let commandRegistrations = 0;
  const panel = () => document.querySelector(".jr-panel");
  const text = () => panel()?.textContent || "";
  const status = () => document.querySelector('[role="status"]')?.textContent || "";
  const ready = () => status().startsWith("Inspection complete for ");
  const emitGraph = () => { for (const callback of listeners) callback(); };
  const sdk = strict("sdk", {
    ready(callback) {
      check(!startup, "entry point called ready twice");
      startup = Promise.resolve().then(callback);
      return startup;
    },
    beforeunload(callback) { unloadRegistrations += 1; unload = callback; },
    provideModel(value) { check(!model, "duplicate model"); model = value; },
    setMainUIInlineStyle(value) {
      check(value.position === "fixed" && value.inset === "0" && value.width === "100%" && value.height === "100%", "main UI does not fill its host");
    },
    showMainUI(options) {
      check(options?.autoFocus === true, "open should autofocus");
      visible = true;
      showCount += 1;
      document.body.style.visibility = "visible";
    },
    hideMainUI(options) {
      check(options === undefined || options.restoreEditingCursor === true, "close cursor restoration missing");
      visible = false;
      hideCount += 1;
      document.body.style.visibility = "hidden";
    },
    UI: strict("UI", { showMsg: async (message, type) => { notices.push({ message, type }); } }),
    App: strict("App", {
      registerCommandPalette(options, action) {
        commandRegistrations += 1;
        check(!commands.has(options.key), "duplicate command key");
        commands.set(options.key, { options, action });
      },
      registerUIItem(type, options) { toolbar.push({ type, options }); },
      onCurrentGraphChanged(callback) {
        listeners.add(callback);
        return () => {
          check(listeners.delete(callback), "graph listener unsubscribed twice");
          unsubscribeCount += 1;
        };
      },
      async getCurrentGraph() {
        calls.push("graph");
        if (graphFailure) throw new Error("PRIVATE HOST ERROR");
        return { ...graph };
      },
      async getTemplate(name) {
        check(name === "daily-default", "unexpected template read");
        calls.push("template");
        return graph.path === "/fixture/A" ? { uuid: templateRoot.uuid } : null;
      },
      async invokeExternalPlugin(target, ...args) {
        calls.push(target);
        const method = target.replace("persian-calendar.models.", "");
        const expected = { getApiInfo: [], describeToday: [], describeDate: ["2025-03-21"], fromJournalDay: [20250321] };
        if (!target.startsWith("persian-calendar.models.") || !Object.hasOwn(expected, method)) {
          unexpected.push(target);
          throw new Error(`Unexpected external model: ${target}`);
        }
        check(JSON.stringify(args) === JSON.stringify(expected[method]), `unexpected ${method} arguments`);
        if (!available) throw new Error("provider not loaded");
        if (method === "getApiInfo") return structuredClone(info);
        if (method === "fromJournalDay") return "2025-03-21";
        if (method === "describeToday" && todayGate) return todayGate.promise;
        return structuredClone(date);
      },
    }),
    DB: strict("DB", {
      onChanged(callback) { dbListeners.add(callback); return () => dbListeners.delete(callback); },
    }),
    Editor: strict("Editor", {
      async getAllPages() {
        check(engineMode, "full graph scan ran without explicit command");
        calls.push("engine-inventory");
        return structuredClone(enginePages);
      },
      async getPage(name) {
        if (engineMode) {
          check(["Week Routine", "Month Routine"].includes(name), "unexpected engine page lookup");
          return structuredClone(enginePages.find((page) => page.name === name.toLowerCase()) ?? null);
        }
        check(["Templates", "Week Routine", "Month Routine"].includes(name), "unexpected page lookup");
        calls.push(`page:${name}`);
        return graph.path === "/fixture/A" && (name === "Templates" || complete)
          ? { name: name.toLowerCase(), uuid: uuid(80 + name.length), properties: { custom: "PRIVATE PAGE PROPERTY" } } : null;
      },
      async getPageBlocksTree(name) {
        if (engineMode) {
          check(typeof name === "string" && engineTrees.has(name), "invalid engine tree identity");
          calls.push("engine-tree");
          if (engineTreeGate) await engineTreeGate.promise;
          return structuredClone(engineTrees.get(name));
        }
        check(["Week Routine", "Month Routine"].includes(name), "unexpected routine read");
        calls.push(`tree:${name}`);
        check(graph.path === "/fixture/A" && complete, "tree read for a missing routine page");
        return structuredClone(routineTrees[name]);
      },
      async getBlock(uuid, options) {
        check(graph.path === "/fixture/A" && uuid === templateRoot.uuid && options.includeChildren === true, "unexpected block read");
        calls.push("block");
        return structuredClone(templateRoot);
      },
    }),
  });
  window.logseq = sdk;
  const result = window.parent.document.querySelector("#result");
  try {
    const script = document.createElement("script");
    script.textContent = source;
    document.head.appendChild(script);
    check(startup, "entry point never called SDK ready");
    await startup;
    await until(ready, "automatic setup inspection");
    const dialog = panel();
    const overlay = document.querySelector(".jr-overlay");
    const [refresh, close] = dialog.querySelectorAll("button");
    const style = [...document.head.querySelectorAll("style")].find((node) => node.textContent.includes(".jr-overlay"));
    check(visible && showCount === 1 && getComputedStyle(dialog).visibility === "visible", "setup not visibly opened on load");
    check(dialog.getAttribute("role") === "dialog" && dialog.getAttribute("aria-modal") === "true", "dialog semantics missing");
    check(document.activeElement === close, "initial close focus missing");
    check(text().includes("Journal & Routines — Setup preview") && text().includes("Journal automation is not enabled"), "read-only setup heading missing");
    check(document.querySelectorAll(".jr-check").length === 10, "expected four setup checks and six sections");
    check(text().includes("User-owned review collision") && !text().includes("PRIVATE ROUTINE TEXT"), "collision summary leaked source content or disappeared");
    check(text().includes("2025-03-21") && text().includes("1404-01-01") && text().includes("weekly-20250315") && text().includes("monthly-1404-01"), "Calendar values missing");
    check(commands.size === 3 && commandRegistrations === 3, "expected exactly three commands");
    const engineCommand = commands.get("journal-routines-inspect-engine");
    check(engineCommand?.options.label === "Journal & Routines: Inspect today's journal engine (read-only)", "engine command missing");
    check(!calls.includes("engine-inventory") && dbListeners.size === 0, "engine must remain idle at startup");
    const open = commands.get("journal-routines-setup-preview");
    const probe = commands.get("journal-routines-check-calendar");
    check(open?.options.label === "Journal & Routines: Open setup preview (read-only)", "setup command missing");
    check(probe?.options.label === "Journal & Routines: Check Calendar dependency (read-only)", "probe command missing");
    check(toolbar.length === 1 && toolbar[0].type === "toolbar" && toolbar[0].options.key === "journal-routines-setup", "JR toolbar missing");
    const toolbarMarkup = document.createElement("template");
    toolbarMarkup.innerHTML = toolbar[0].options.template;
    const anchor = toolbarMarkup.content.querySelector("a");
    check(anchor?.textContent === "JR" && anchor.dataset.onClick === "openJournalSetup", "JR model binding missing");
    check(typeof model?.openJournalSetup === "function" && open.action === model.openJournalSetup, "model and command do not share open action");
    check(unloadRegistrations === 1 && listeners.size === 2 && intervals.size === 1, "combined lifecycle hooks missing");
    check(notices.length === 0, "startup should not show command feedback");
    groups.push("automatic visible DOM, three commands, lazy engine, JR model/toolbar, read-only summaries");

    const planArea = () => dialog.querySelector(".jr-plan");
    const planRows = () => [...dialog.querySelectorAll("[data-plan-change]")];
    const fingerprint = () => dialog.querySelector("[data-plan-id]")?.textContent;
    function comparison(expected) {
      const messages = {
        new: "New inspection. Refresh preview to compare the sampled sources again.",
        unchanged: "Same sampled sources and plan as the previous inspection. This is not whole-graph validation or permission to apply.",
        changed: "The sampled sources or plan changed. The previous draft is superseded; review the current draft below.",
        unavailable: "A comparable fingerprint is unavailable. Do not rely on the previous draft; refresh after resolving blockers.",
      };
      const node = dialog.querySelector("[data-plan-comparison]");
      check(node?.dataset.planComparison === expected && node.textContent === messages[expected], `expected ${expected} comparison, got ${node?.textContent}`);
    }
    function identifiablePlan() {
      const node = dialog.querySelector("[data-plan-id]");
      check(/^[a-f0-9]{64}$/.test(fingerprint()) && node.dataset.planId === fingerprint(), "native SHA-256 fingerprint missing or malformed");
      return fingerprint();
    }
    function noPlan(label) {
      check(!planArea() && !fingerprint() && !dialog.querySelector("[data-plan-comparison]") && planRows().length === 0, `${label}: stale plan or comparison retained`);
    }
    function additions(ids) {
      check(JSON.stringify(planRows().map((row) => row.dataset.planChange)) === JSON.stringify(ids), `wrong additions: ${planRows().map((row) => row.dataset.planChange).join(", ")}`);
      check(planArea()?.textContent.includes(`Proposed additions (${ids.length})`), "addition count missing");
    }
    function blocked(reason) {
      check(planArea()?.textContent.includes("Blocked — resolve the review findings") && planArea().textContent.includes(reason), "blocked plan/reason missing");
      additions([]);
      check(planArea().textContent.includes("No additions proposed while this plan is blocked."), "blocked empty-state missing");
      safetyAndBounds("blocked plan");
    }
    function safetyAndBounds(label) {
      const controls = [...dialog.querySelectorAll('button, a, input, textarea, select, [contenteditable], [role="button"]')];
      check(controls.length === 2 && controls[0] === refresh && controls[1] === close, `${label}: unexpected action (Apply/Enable must not exist)`);
      check(refresh.textContent === "Refresh preview" && close.textContent === "Close", `${label}: read-only controls changed`);
      const bounds = dialog.getBoundingClientRect();
      check(bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1, `${label}: panel outside viewport ${JSON.stringify(bounds.toJSON())}`);
      check(dialog.scrollWidth <= dialog.clientWidth + 1, `${label}: horizontal panel overflow`);
      check(document.documentElement.scrollWidth <= innerWidth + 1, `${label}: horizontal document overflow`);
      check(getComputedStyle(dialog).overflowY === "auto", `${label}: long report cannot scroll`);
      for (const node of dialog.querySelectorAll("pre, [data-plan-id]")) {
        check(node.scrollWidth <= node.clientWidth + 1, `${label}: fingerprint/content overflow`);
        for (const rect of node.getClientRects()) check(rect.left >= bounds.left && rect.right <= bounds.right + 1, `${label}: fingerprint/content outside panel`);
      }
      check(!text().includes("PRIVATE") && !dialog.innerHTML.includes("/fixture/") && !dialog.querySelector("img, script") && !window.__jrInjected, `${label}: private note/property/path or executable markup rendered`);
      check(unexpected.length === 0, `${label}: forbidden SDK access: ${unexpected.join(", ")}`);
      if (planArea()) {
        for (const warning of ["What stays unchanged", "Tasks/Notes content", "current and historical journals unchanged", "Required before any future apply", "backup", "explicit per-graph approval", "not authorization", "no executor or graph writes"]) {
          check(planArea().textContent.includes(warning), `${label}: missing plan safety text: ${warning}`);
        }
      }
    }
    const partialIds = ["create-week-routine", "create-month-routine", "append-focus", "append-weekly-tasks", "append-monthly-tasks", "append-end-of-day-review"];
    function partialPlan() {
      additions(partialIds);
      check(planArea().textContent.includes("Draft for review only — not approved or executable."), "draft warning missing");
      for (const [i, name] of ["Week Routine", "Month Routine"].entries()) {
        const row = planRows()[i];
        check(row.querySelector("strong").textContent === `Create ${name}` && row.textContent.includes(`Target: page:${name}`), "routine page target/title missing");
        check(row.querySelector("pre").textContent === "(Empty page — no blocks or sample tasks)" && row.textContent.includes("Create an empty page with no blocks."), "routine proposal contains tasks");
      }
      for (const [i, section] of ["Focus", "Weekly tasks", "Monthly tasks", "End-of-day review"].entries()) {
        const row = planRows()[i + 2];
        check(row.querySelector("strong").textContent === `Add ${section}` && row.querySelector("pre").textContent === `## ${section}`, "wrong proposed heading/content");
        check(row.textContent.includes(`Target: block:${templateRoot.uuid}`) && row.textContent.includes("last direct child") && row.textContent.includes("do not rewrite, reparent, or reorder"), "heading target/append-only placement missing");
      }
      check(!calls.some((call) => call.startsWith("tree:")), "partial graph read nonexistent routine trees");
    }
    partialPlan();
    comparison("new");
    const firstFingerprint = identifiablePlan();
    groups.push("valid Tasks/Notes template: two empty routine pages, four exact append-only headings, native fingerprint and safety copy");
    safetyAndBounds("wide");
    check(innerWidth === 1200 && dialog.getBoundingClientRect().width <= 760, "wide viewport sizing not exercised");
    window.frameElement.style.width = "360px";
    window.frameElement.style.height = "640px";
    await until(() => innerWidth === 360 && innerHeight === 640, "narrow frame resize");
    safetyAndBounds("narrow");
    check(dialog.scrollHeight > dialog.clientHeight, "narrow long report should scroll vertically");
    groups.push("wide 1200px and narrow 360px bounds, long native fingerprint; only Refresh/Close controls");

    async function refreshPlan(label) {
      refresh.click();
      check(status().startsWith("Checking"), `${label}: checking state missing`);
      noPlan(label);
      await until(ready, label);
      safetyAndBounds(label);
    }
    await refreshPlan("unchanged sampled sources");
    partialPlan();
    comparison("unchanged");
    check(identifiablePlan() === firstFingerprint, "unchanged source changed fingerprint");
    templateRoot.children[1].children[0].content += " PRIVATE SOURCE EDIT";
    await refreshPlan("private note source edit");
    partialPlan();
    comparison("changed");
    const editedFingerprint = identifiablePlan();
    check(editedFingerprint !== firstFingerprint, "private note edit did not change fingerprint");
    await refreshPlan("stable edited source");
    comparison("unchanged");
    check(identifiablePlan() === editedFingerprint, "edited source fingerprint is unstable");
    groups.push("Refresh clears draft synchronously; new/unchanged/changed comparison tracks private source edits without rendering them");

    templateRoot.children.push(block(90, "## Tasks"));
    await refreshPlan("ambiguous duplicate template heading");
    blocked("Duplicate, nested, or root-level matching sections");
    comparison("changed");
    check(identifiablePlan() !== editedFingerprint, "ambiguous evidence fingerprint not updated");
    templateRoot.children.pop();
    // The inspector can summarize a string UUID, but the planner must reject it.
    const noteUuid = templateRoot.children[1].children[0].uuid;
    templateRoot.children[1].children[0].uuid = "invalid-note-uuid";
    await refreshPlan("incomplete evidence without fingerprint");
    blocked("Unsupported, unreadable, incomplete, or non-hashable setup evidence");
    comparison("unavailable");
    check(!fingerprint() && !planArea().textContent.includes(editedFingerprint), "unhashable evidence retained old fingerprint");
    check(planArea().textContent.includes("Plan fingerprint unavailable"), "unhashable evidence lacks explicit fingerprint status");
    templateRoot.children[1].children[0].uuid = noteUuid;
    await refreshPlan("comparable evidence recovery");
    partialPlan();
    comparison("unavailable");
    check(identifiablePlan() === editedFingerprint, "restored evidence did not restore fingerprint");
    await refreshPlan("comparison baseline after recovery");
    comparison("unchanged");
    groups.push("ambiguous template blocks all additions; invalid evidence removes fingerprint; recovery does not compare against stale draft");

    complete = true;
    templateRoot.children.push(...sections.filter((section) => !["Tasks", "Notes"].includes(section)).map((section, i) => block(30 + i, `## ${section}`)));
    await refreshPlan("complete customized graph");
    additions([]);
    comparison("changed");
    const completeFingerprint = identifiablePlan();
    check(planArea().textContent.includes("Draft for review only") && planArea().textContent.includes("No additions needed within the inspected scope. Existing content stays unchanged."), "complete graph empty-state missing or blocked");
    check([...dialog.querySelectorAll(".jr-check strong")].every((node) => node.textContent.endsWith("— existing")), "complete graph checks are not all existing");
    check(calls.includes("tree:Week Routine") && calls.includes("tree:Month Routine") && text().includes("Routine entries: 1 available, 0 empty"), "valid routine trees not inspected");
    await refreshPlan("complete graph unchanged");
    comparison("unchanged");
    check(identifiablePlan() === completeFingerprint, "complete graph fingerprint unstable");
    groups.push("complete customized template and routine trees: no additions, unchanged content, stable fingerprint");

    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    check(document.activeElement === refresh, "forward focus wrap failed");
    refresh.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    check(document.activeElement === close, "backward focus wrap failed");
    close.click();
    check(!visible && !text().includes("weekly-20250315"), "Close did not hide/clear report");
    noPlan("Close");
    const readsBeforeReopen = calls.length;
    await open.action();
    check(visible && ready() && calls.length > readsBeforeReopen, "command reopen did not inspect afresh");
    comparison("new");
    check(identifiablePlan() === completeFingerprint, "reopen changed unchanged evidence");
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check(!visible && !ready(), "Escape did not close/clear report");
    noPlan("Escape");
    await model[anchor.dataset.onClick]();
    check(visible && ready() && document.activeElement === close, "toolbar model reopen failed");
    comparison("new");
    refresh.click();
    check(status().startsWith("Checking") && !text().includes("weekly-20250315"), "Refresh did not clear old snapshot immediately");
    noPlan("Refresh");
    await until(ready, "Refresh completion");
    comparison("unchanged");
    check(text().includes("Preview build: 0.3.0"), "loaded preview build is not identifiable");
    // Model/command opens must reset independently of our Close handler. This
    // also covers repeated host-dispatched opens after an inspection completes.
    for (const reopen of [() => model[anchor.dataset.onClick](), () => open.action()]) {
      await reopen();
      comparison("new");
      check(identifiablePlan() === completeFingerprint, "explicit open changed unchanged evidence");
      await refreshPlan("comparison after explicit open");
      comparison("unchanged");
    }
    groups.push("Close, Escape, command/model open reset without Close, Refresh comparison, build label and keyboard focus");

    // Missing routine pages would require additions if Calendar were available.
    complete = false;
    available = false;
    refresh.click();
    await until(ready, "dependency unavailable");
    check(text().includes("Unavailable:") && text().includes("Load Persian Calendar & Experience") && !text().includes("weekly-20250315"), "dependency failure retained stale period data or lacked guidance");
    blocked("Calendar dependency is unavailable");
    check(dialog.querySelector('[data-check="week-routine"] strong').textContent.endsWith("— missing") && dialog.querySelector('[data-check="month-routine"] strong').textContent.endsWith("— missing"), "dependency blocker did not exercise otherwise-needed routine additions");
    comparison("changed");
    check(identifiablePlan() !== completeFingerprint, "dependency blocker did not change plan fingerprint");
    await probe.action();
    check(notices.at(-1)?.type === "warning", "manual probe missing unavailable feedback");
    complete = true;
    available = true;
    refresh.click();
    await until(ready, "dependency recovery");
    check(text().includes("Calendar API v1 date check succeeded") && text().includes("weekly-20250315"), "dependency did not recover");
    comparison("changed");
    check(identifiablePlan() === completeFingerprint && planArea().textContent.includes("Draft for review only"), "dependency recovery did not restore draft");
    await probe.action();
    check(notices.at(-1)?.type === "success", "manual probe missing recovery feedback");
    groups.push("dependency unavailable/recovery and diagnostic command feedback");

    todayGate = deferred();
    const beforePending = calls.filter((call) => call.endsWith("describeToday")).length;
    refresh.click();
    await until(() => calls.filter((call) => call.endsWith("describeToday")).length > beforePending, "pending graph A read");
    const stale = todayGate;
    todayGate = undefined;
    const maliciousName = '<img src=x onerror="window.__jrInjected=true"> Graph B';
    graph = { name: maliciousName, path: "/fixture/B" };
    emitGraph();
    check(status().startsWith("Checking") && !text().includes("User-owned review collision") && !text().includes("weekly-20250315"), "graph switch did not clear stale data synchronously");
    noPlan("graph switch");
    await until(ready, "graph B inspection");
    check(status().includes(maliciousName) && !dialog.querySelector("img") && !window.__jrInjected, "graph name was not rendered as literal text");
    check([...dialog.querySelectorAll(".jr-check strong")].every((node) => node.textContent.endsWith("— missing")), "graph B retained graph A checks");
    comparison("new");
    const graphBFingerprint = identifiablePlan();
    check(graphBFingerprint !== completeFingerprint, "graph switch retained old fingerprint");
    additions(["create-week-routine", "create-month-routine", "create-templates", "create-daily-default"]);
    const freshTemplate = planRows()[3];
    const freshContent = "- یادداشت روزانه\n  template:: daily-default\n  template-including-parent:: false\n  - ## Focus\n  - ## Weekly tasks\n  - ## Monthly tasks\n  - ## Tasks\n  - ## Notes\n  - ## End-of-day review";
    check(freshTemplate.querySelector("pre").textContent === freshContent, "fresh template multiline content/indentation changed");
    check(freshTemplate.textContent.includes("Target: page:Templates") && freshTemplate.textContent.includes("after all existing page blocks") && freshTemplate.textContent.includes("direct children"), "fresh template append placement missing");
    check(getComputedStyle(freshTemplate.querySelector("pre")).whiteSpace === "pre-wrap", "multiline proposal does not preserve whitespace/wrap long lines");
    check(planRows().slice(0, 3).every((row) => row.querySelector("pre").textContent === "(Empty page — no blocks or sample tasks)"), "fresh graph proposes sample tasks");
    safetyAndBounds("narrow fresh multiline template and long fingerprint");
    groups.push("fresh graph: three empty pages and exact multiline six-heading template, append placement and narrow content wrapping");
    const graphBText = text();
    stale.resolve(structuredClone(date));
    await wait(20);
    check(text() === graphBText && fingerprint() === graphBFingerprint, "late graph A response replaced graph B snapshot/plan");
    comparison("new");
    await refreshPlan("graph B comparison baseline");
    comparison("unchanged");
    check(identifiablePlan() === graphBFingerprint, "late graph A response contaminated comparison baseline");
    safetyAndBounds("narrow malicious name");
    groups.push("graph switch clears stale data, late response suppression, escaped graph name");

    // Closing during an outstanding inspection must discard its draft and baseline.
    todayGate = deferred();
    const beforeClose = calls.filter((call) => call.endsWith("describeToday")).length;
    refresh.click();
    await until(() => calls.filter((call) => call.endsWith("describeToday")).length > beforeClose, "pending read before Close");
    close.click();
    noPlan("Close during pending inspection");
    todayGate.resolve(structuredClone(date));
    todayGate = undefined;
    await wait(20);
    check(!visible && !ready(), "late closed inspection reopened report");
    noPlan("late closed inspection");
    await model.openJournalSetup();
    comparison("new");
    check(identifiablePlan() === graphBFingerprint, "close/reopen retained stale pending plan");
    close.click();
    noPlan("Close before hidden graph switch");
    graph = { name: "Graph C", path: "/fixture/C" };
    const graphReads = calls.filter((call) => call === "graph").length;
    emitGraph();
    await wait(20);
    check(!visible && calls.filter((call) => call === "graph").length === graphReads, "hidden setup inspected or reopened on graph change");
    await model.openJournalSetup();
    check(status().includes("Graph C"), "hidden graph switch not reflected on reopen");
    comparison("new");
    check(identifiablePlan() !== graphBFingerprint, "hidden graph switch retained graph B fingerprint");
    graphFailure = true;
    refresh.click();
    await until(() => status().startsWith("Cannot verify the current graph."), "graph error");
    check(!text().includes("PRIVATE HOST ERROR") && !text().includes("weekly-20250315"), "graph error leaked raw error or stale content");
    noPlan("graph error");
    graphFailure = false;
    refresh.click();
    await until(ready, "graph error recovery");
    comparison("new");
    identifiablePlan();
    safetyAndBounds("graph error recovery");
    groups.push("hidden graph changes and sanitized inspection error/recovery");

    engineMode = true;
    const engineSource = JSON.stringify([...engineTrees]);
    check(await engineCommand.action() === undefined, "command exposed private engine projection");
    check(notices.at(-1)?.type === "success" && notices.at(-1).message.includes("Scanned: 5 pages, 2 journals") &&
      notices.at(-1).message.includes("weekly existing, monthly new") && notices.at(-1).message.includes("no writes"), "engine summary missing");
    check(!JSON.stringify(notices).includes("PRIVATE") && JSON.stringify([...engineTrees]) === engineSource, "engine leaked or mutated source");
    check(dbListeners.size === 0 && listeners.size === 2, "engine scan leaked listeners");
    engineTrees.get(uuid(204))[0].content += "\nroutine-loaded:: weekly-20250315";
    await engineCommand.action();
    check(notices.at(-1).type === "warning" && notices.at(-1).message.includes("Multiple period owners"), "misplaced duplicate owner not blocked");
    engineTrees.get(uuid(204))[0].content = "PRIVATE unrelated note";
    engineTreeGate = deferred();
    const treeReads = calls.filter((call) => call === "engine-tree").length;
    const noticeBeforeEdit = notices.length;
    const dirty = engineCommand.action();
    await until(() => calls.filter((call) => call === "engine-tree").length > treeReads, "engine pending tree");
    for (const callback of dbListeners) callback({ blocks: [], txData: [] });
    await dirty;
    engineTreeGate.resolve(); engineTreeGate = undefined;
    await wait(20);
    check(notices.length === noticeBeforeEdit && dbListeners.size === 0 && listeners.size === 2, "dirty scan published or leaked");
    engineMode = false;
    groups.push("manual real-graph adapter/engine command: complete read-only scan, private summary, collision and DB-edit cancellation");

    todayGate = deferred();
    const pendingCount = calls.filter((call) => call.endsWith("describeToday")).length;
    refresh.click();
    const pendingProbe = probe.action();
    const pendingJournal = engineCommand.action();
    await until(() => calls.filter((call) => call.endsWith("describeToday")).length >= pendingCount + 3, "setup, probe and engine pending before unload");
    const noticeCount = notices.length;
    await unload();
    await pendingProbe;
    await pendingJournal;
    check(!visible && !panel() && !overlay.isConnected && !style.isConnected, "unload retained visible setup DOM/style");
    noPlan("pending unload");
    check(listeners.size === 0 && dbListeners.size === 0 && unsubscribeCount >= 2 && intervals.size === 0, "unload left subscriptions or polling alive");
    const callsAfterUnload = calls.length;
    const unsubscribesAfterUnload = unsubscribeCount;
    const showsAfterUnload = showCount;
    const hidesAfterUnload = hideCount;
    todayGate.resolve(structuredClone(date));
    refresh.click();
    close.click();
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await model.openJournalSetup();
    await open.action();
    await engineCommand.action();
    await probe.action();
    emitGraph();
    await unload();
    await wait(31_000);
    check(calls.length === callsAfterUnload && notices.length === noticeCount, "late response/callback/polling performed work after unload");
    check(showCount === showsAfterUnload && hideCount === hidesAfterUnload && !panel(), "retained UI listeners survived unload");
    check(unsubscribeCount === unsubscribesAfterUnload && intervals.size === 0, "repeated unload was not idempotent");
    groups.push("combined pending unload, DOM/style/listener/timer cleanup, inert late callbacks");
    check(unexpected.length === 0, `forbidden SDK accesses: ${unexpected.join(", ")}`);
    check(errors.length === 0, `browser errors: ${errors.join("; ")}`);
    result.textContent = encodeURIComponent(JSON.stringify({ passed: true, groups, unexpected, errors }));
  } catch (error) {
    result.textContent = encodeURIComponent(JSON.stringify({ passed: false, groups, error: error.stack || String(error), unexpected, errors }));
  }
}

async function main() {
  const chrome = process.argv[2];
  assert.ok(chrome, "Usage: node scripts/validate_setup.cjs /path/to/chrome");
  const build = await esbuild.build({
    stdin: {
      contents: `import { registerProbe } from './register.js';
        import { createSetupController } from './setup-controller.js';
        import { createJournalInspector } from './journal-inspector.js';
        logseq.ready(() => registerProbe(logseq, {
          setup: createSetupController({sdk: logseq, document}),
          journal: createJournalInspector({sdk: logseq}),
        }));`,
      resolveDir: path.resolve(__dirname, "../src"),
      loader: "js",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    plugins: [{
      name: "fixture-sdk-stub",
      setup(builder) {
        builder.onResolve({ filter: /^@logseq\/libs$/ }, () => ({ path: "sdk", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "// The fixture supplies window.logseq.", loader: "js" }));
      },
    }],
  });
  const source = build.outputFiles[0].text;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-journal-setup-"));
  try {
    // A same-origin frame gives real 1200px/360px layout viewports in one Chrome run.
    const frame = `<!doctype html><meta charset="utf-8"><body><script>(${browserFixture.toString()})(${JSON.stringify(source).replaceAll("<", "\\u003c")});</script>`;
    const html = `<!doctype html><meta charset="utf-8"><pre id="result"></pre><iframe style="width:1200px;height:820px;border:0" title="Plugin UI fixture"></iframe><script>document.querySelector('iframe').srcdoc = ${JSON.stringify(frame).replaceAll("<", "\\u003c")};</script>`;
    const file = path.join(temp, "setup.html");
    fs.writeFileSync(file, html);
    const output = execFileSync(chrome, [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--window-size=1300,1000", `--user-data-dir=${path.join(temp, "profile")}`,
      "--no-first-run", "--virtual-time-budget=40000", "--dump-dom", pathToFileURL(file).href,
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const match = output.match(/<pre id="result">([^<]+)<\/pre>/);
    assert.ok(match, "Browser setup fixture did not finish within the virtual-time budget");
    const result = JSON.parse(decodeURIComponent(match[1]));
    for (const group of result.groups) console.log(`PASS: ${group}`);
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
    console.log(`PASS: ${result.groups.length} browser groups; legacy preview harness, strict mocked SDK. Chromium fixture only—not live Logseq Desktop.`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
