// Real plugin source in Chromium with a strict, read-only SDK fixture.
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
        return graph.path === "/fixture/A" ? { uuid: "template-root" } : null;
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
    Editor: strict("Editor", {
      async getPage(name) {
        check(["Templates", "Week Routine", "Month Routine"].includes(name), "unexpected page lookup");
        calls.push(`page:${name}`);
        return graph.path === "/fixture/A" ? { name: name.toLowerCase() } : null;
      },
      async getPageBlocksTree(name) {
        check(["Week Routine", "Month Routine"].includes(name), "unexpected routine read");
        calls.push(`tree:${name}`);
        return [{ content: name, children: [{ content: "PRIVATE ROUTINE TEXT", children: [] }] }];
      },
      async getBlock(uuid, options) {
        check(uuid === "template-root" && options.includeChildren === true, "unexpected block read");
        calls.push("block");
        return { uuid, content: "daily-default", children: sections.map((content) => ({ content, children: [] })) };
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
    check(commands.size === 2 && commandRegistrations === 2, "expected exactly two commands");
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
    groups.push("automatic visible DOM, two commands, JR model/toolbar, read-only summaries");

    function safetyAndBounds(label) {
      const controls = [...dialog.querySelectorAll('button, a, input, select, [role="button"]')];
      check(controls.length === 2 && controls[0] === refresh && controls[1] === close, `${label}: unexpected action (Apply/Enable must not exist)`);
      check(refresh.textContent === "Refresh preview" && close.textContent === "Close", `${label}: read-only controls changed`);
      const bounds = dialog.getBoundingClientRect();
      check(bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1, `${label}: panel outside viewport ${JSON.stringify(bounds.toJSON())}`);
      check(dialog.scrollWidth <= dialog.clientWidth + 1, `${label}: horizontal panel overflow`);
      check(document.documentElement.scrollWidth <= innerWidth + 1, `${label}: horizontal document overflow`);
      check(getComputedStyle(dialog).overflowY === "auto", `${label}: long report cannot scroll`);
    }
    safetyAndBounds("wide");
    check(innerWidth === 1200 && dialog.getBoundingClientRect().width <= 760, "wide viewport sizing not exercised");
    window.frameElement.style.width = "360px";
    window.frameElement.style.height = "640px";
    await until(() => innerWidth === 360 && innerHeight === 640, "narrow frame resize");
    safetyAndBounds("narrow");
    check(dialog.scrollHeight > dialog.clientHeight, "narrow long report should scroll vertically");
    groups.push("wide 1200px and narrow 360px bounds; no Apply/Enable controls");

    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    check(document.activeElement === refresh, "forward focus wrap failed");
    refresh.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    check(document.activeElement === close, "backward focus wrap failed");
    close.click();
    check(!visible && !text().includes("weekly-20250315"), "Close did not hide/clear report");
    const readsBeforeReopen = calls.length;
    await open.action();
    check(visible && ready() && calls.length > readsBeforeReopen, "command reopen did not inspect afresh");
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check(!visible && !ready(), "Escape did not close/clear report");
    await model[anchor.dataset.onClick]();
    check(visible && ready() && document.activeElement === close, "toolbar model reopen failed");
    refresh.click();
    check(status().startsWith("Checking") && !text().includes("weekly-20250315"), "Refresh did not clear old snapshot immediately");
    await until(ready, "Refresh completion");
    groups.push("Close, Escape, command/model reopen, Refresh and keyboard focus");

    available = false;
    refresh.click();
    await until(ready, "dependency unavailable");
    check(text().includes("Unavailable:") && text().includes("Load Persian Calendar & Experience") && !text().includes("weekly-20250315"), "dependency failure retained stale period data or lacked guidance");
    await probe.action();
    check(notices.at(-1)?.type === "warning", "manual probe missing unavailable feedback");
    available = true;
    refresh.click();
    await until(ready, "dependency recovery");
    check(text().includes("Calendar API v1 date check succeeded") && text().includes("weekly-20250315"), "dependency did not recover");
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
    await until(ready, "graph B inspection");
    check(status().includes(maliciousName) && !dialog.querySelector("img") && !window.__jrInjected, "graph name was not rendered as literal text");
    check([...dialog.querySelectorAll(".jr-check strong")].every((node) => node.textContent.endsWith("— missing")), "graph B retained graph A checks");
    const graphBText = text();
    stale.resolve(structuredClone(date));
    await wait(20);
    check(text() === graphBText, "late graph A response replaced graph B snapshot");
    safetyAndBounds("narrow malicious name");
    groups.push("graph switch clears stale data, late response suppression, escaped graph name");

    close.click();
    graph = { name: "Graph C", path: "/fixture/C" };
    const graphReads = calls.filter((call) => call === "graph").length;
    emitGraph();
    await wait(20);
    check(!visible && calls.filter((call) => call === "graph").length === graphReads, "hidden setup inspected or reopened on graph change");
    await model.openJournalSetup();
    check(status().includes("Graph C"), "hidden graph switch not reflected on reopen");
    graphFailure = true;
    refresh.click();
    await until(() => status().startsWith("Cannot verify the current graph."), "graph error");
    check(!text().includes("PRIVATE HOST ERROR") && !text().includes("weekly-20250315"), "graph error leaked raw error or stale content");
    graphFailure = false;
    refresh.click();
    await until(ready, "graph error recovery");
    groups.push("hidden graph changes and sanitized inspection error/recovery");

    todayGate = deferred();
    const pendingCount = calls.filter((call) => call.endsWith("describeToday")).length;
    refresh.click();
    const pendingProbe = probe.action();
    await until(() => calls.filter((call) => call.endsWith("describeToday")).length >= pendingCount + 2, "both setup and probe pending before unload");
    const noticeCount = notices.length;
    await unload();
    await pendingProbe;
    check(!visible && !panel() && !overlay.isConnected && !style.isConnected, "unload retained visible setup DOM/style");
    check(listeners.size === 0 && unsubscribeCount === 2 && intervals.size === 0, "unload left subscriptions or polling alive");
    const callsAfterUnload = calls.length;
    const showsAfterUnload = showCount;
    const hidesAfterUnload = hideCount;
    todayGate.resolve(structuredClone(date));
    refresh.click();
    close.click();
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await model.openJournalSetup();
    await open.action();
    await probe.action();
    emitGraph();
    await unload();
    await wait(31_000);
    check(calls.length === callsAfterUnload && notices.length === noticeCount, "late response/callback/polling performed work after unload");
    check(showCount === showsAfterUnload && hideCount === hidesAfterUnload && !panel(), "retained UI listeners survived unload");
    check(unsubscribeCount === 2 && intervals.size === 0, "repeated unload was not idempotent");
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
    entryPoints: [path.resolve(__dirname, "../src/index.js")],
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
    console.log(`PASS: ${result.groups.length} browser groups; real bundled entry point, strict mocked SDK. Chromium fixture only—not live Logseq Desktop.`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
