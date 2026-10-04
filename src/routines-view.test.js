import assert from "node:assert/strict";
import test from "node:test";
import { mountRoutinesView } from "./routines-view.js";

// Only the DOM surface the view uses; HTML sinks fail rather than silently pass.
class EventTarget {
  listeners = new Map();
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, props = {}) {
    const event = { target: this, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...props };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
}
class Element extends EventTarget {
  constructor(document, tag) {
    super();
    Object.assign(this, { document, tagName: tag, children: [], attributes: {},
      disabled: false, hidden: false, checked: false, value: "", text: "" });
  }
  set innerHTML(_) { throw new Error("Unsafe HTML sink"); }
  set outerHTML(_) { throw new Error("Unsafe HTML sink"); }
  insertAdjacentHTML() { throw new Error("Unsafe HTML sink"); }
  set textContent(value) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = String(value);
  }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  get isConnected() { return this.document.head.contains(this) || this.document.body.contains(this); }
  get visible() { return !this.hidden && (!this.parent || this.parent.visible); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  querySelectorAll(selector) {
    const tags = selector.split(",").map((tag) => tag.trim());
    return this.children.flatMap((child) => [
      ...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  click() {
    if (this.disabled || !this.visible) return;
    if (this.type === "checkbox") { this.checked = !this.checked; this.dispatch("change"); }
    this.dispatch("click");
  }
  focus() {
    if (this.disabled || !this.visible || !this.isConnected) return;
    this.document.activeElement = this;
    this.document.dispatch("focusin", { target: this });
  }
}
const ready = (overrides = {}) => ({
  started: true, graphKey: "graph:a", graphName: "Graph A", enabled: false,
  calendar: "gregorian", autoOpen: true,
  definitions: { weekly: "Weekly routines", monthly: "Monthly routines" },
  paused: false, error: null, ...overrides,
});
function fixture(handlers = {}) {
  const document = new EventTarget();
  document.createElement = (tag) => new Element(document, tag);
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  const previous = document.body.appendChild(document.createElement("button"));
  previous.focus();
  const calls = [];
  const defaults = Object.fromEntries([
    "onSave", "onEnable", "onQuickSetup", "onDisable", "onShowCurrent", "onShowHistory", "onAddExamples",
    "onInstallDailyTemplate", "onApplyDailyTemplateToday", "onOpenDefinition", "onRefresh", "onClose", "onSkip",
  ].map((name) => [name, (...args) => { calls.push([name, ...args]); }]));
  const view = mountRoutinesView(document, { ...defaults, ...handlers });
  const overlay = document.body.children[1], panel = overlay.children[0];
  const buttons = panel.querySelectorAll("button");
  const button = (text) => {
    const result = buttons.find((node) => node.textContent === text);
    assert.ok(result, `Missing button: ${text}`);
    return result;
  };
  const inputs = panel.querySelectorAll("input, select");
  const input = (name) => inputs.find((node) => node.name === name);
  button("More options").click();
  const calendar = input("calendar");
  return { document, previous, calls, view, overlay, panel, buttons, inputs, button, input, calendar,
    confirmation: button("Confirm calendar change").parent,
    error: panel.querySelectorAll("p").find((node) => node.attributes.role === "alert"),
    select(value) { calendar.value = value; calendar.dispatch("change"); },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function listenerCount(node) {
  return [...node.listeners.values()].reduce((count, handlers) => count + handlers.size, 0) +
    (node.children || []).reduce((count, child) => count + listenerCount(child), 0);
}

test("welcome explains routines, provides a creation action and allows skipping without initialization", async () => {
  const h = fixture(); h.view.render(ready({ onboarding: "pending" }));
  assert.match(h.panel.textContent, /Welcome to Journal & Routines/);
  assert.match(h.panel.textContent, /recurring weekly and monthly routines/);
  assert.match(h.panel.textContent, /Existing routine pages are reused, never overwritten/);
  assert.deepEqual(h.calls, []);
  h.button("Create my first routine system").click(); await tick();
  assert.equal(h.calls[0][0], "onQuickSetup");
  assert.equal(h.calls[0][2], "graph:a");
  h.button("Skip for now").click(); await tick();
  assert.deepEqual(h.calls.at(-1), ["onSkip", "graph:a"]);
  h.view.render(ready({ onboarding: "skipped" }));
  assert.equal(h.button("Set up this graph").disabled, false);
  h.view.destroy();
});

test("welcome skip and Escape cannot race a pending initialization; completion opens the workflow", async () => {
  const pending = deferred();
  const h = fixture({ onQuickSetup: () => pending.promise });
  h.view.render(ready({ onboarding: "pending" }));
  h.button("Create my first routine system").click();
  assert.equal(h.button("Skip for now").disabled, true);
  h.document.dispatch("keydown", { key: "Escape" });
  assert.deepEqual(h.calls, []);
  pending.resolve(); await tick();
  h.view.render(ready({ onboarding: "completed", enabled: true, setupMessage: "Routines are ready." }));
  h.button("Open my routines").click(); await tick();
  assert.deepEqual(h.calls, [["onShowCurrent"]]);
  h.view.destroy();
});

test("initialization evidence prevents a disabled prior attempt from being presented as a fresh welcome", () => {
  const h = fixture();
  for (const initialization of ["pending", "verified"]) {
    h.view.render(ready({ onboarding: "pending", initialization, error: initialization === "pending" ? "Routine initialization is unfinished." : null }));
    assert.doesNotMatch(h.panel.textContent, /Welcome to Journal & Routines/);
    assert.equal(h.button("Set up this graph").disabled, false);
    assert.equal(h.button("Close").disabled, false);
    if (initialization === "pending") assert.equal(h.error.hidden, false);
  }
  h.view.destroy();
});

test("mount is inert, native and accessible, with concise setup guidance and no graph writes", () => {
  const h = fixture();
  assert.deepEqual(Object.keys(h.view).sort(), ["destroy", "focus", "render"]);
  assert.deepEqual(h.calls, []);
  assert.equal(h.document.activeElement, h.previous);
  assert.equal(h.panel.attributes.role, "dialog");
  assert.equal(h.panel.attributes["aria-modal"], "true");
  assert.equal(h.panel.attributes["aria-labelledby"], h.panel.children[0].id);
  assert.equal(h.panel.querySelectorAll("p").find((node) => node.attributes.role === "status").attributes["aria-live"], "polite");
  assert.ok(h.inputs.every((node) => node.parent.tagName === "label"));
  assert.match(h.panel.textContent, /Early build.*Desktop.*unverified/);
  assert.match(h.panel.textContent, /both default definition pages are new.*two Persian TODOs/);
  assert.match(h.panel.textContent, /one current week and month snapshot/);
  assert.match(h.panel.textContent, /No journal edits/);
  assert.match(h.panel.textContent, /Edit definitions before Enable/);
  assert.match(h.panel.textContent, /no refill of deleted tasks/);
  assert.match(h.panel.textContent, /Jalali requires a compatible Persian Calendar/);
  assert.deepEqual(h.calendar.children.map((node) => node.value), ["gregorian", "jalali"]);
  assert.ok(h.inputs.every((node) => node.disabled));
  assert.equal(h.button("Save settings").disabled, true);
  assert.equal(h.button("Enable").disabled, true);
  assert.equal(h.button("Add two Persian examples per routine").disabled, true);
  assert.equal(h.button("Disable").disabled, true);
  assert.equal(h.button("Refresh").disabled, false);
  assert.equal(h.button("Close").disabled, false);
  assert.equal(h.confirmation.hidden, true);
  h.view.destroy();
});

test("authoritative status safely renders graph, error, enabled state and input values", () => {
  const h = fixture(), injection = '<img src=x onerror="alert(1)">';
  h.view.render(ready({ graphName: injection, error: injection, enabled: true, autoOpen: false }));
  assert.match(h.panel.textContent, /Enabled — attention required/);
  assert.ok(h.panel.textContent.includes(`Graph: ${injection}`));
  assert.equal(h.error.textContent, injection);
  assert.equal(h.error.hidden, false);
  assert.equal(h.panel.querySelectorAll("img").length, 0);
  assert.equal(h.input("weeklyDefinition").value, "Weekly routines");
  assert.equal(h.input("monthlyDefinition").value, "Monthly routines");
  assert.equal(h.input("weeklyDefinition").disabled, true);
  assert.equal(h.input("monthlyDefinition").disabled, true);
  assert.equal(h.calendar.disabled, false);
  assert.equal(h.input("autoOpen").disabled, false);
  assert.equal(h.input("autoOpen").checked, false);
  assert.equal(h.button("Enable").disabled, true);
  assert.equal(h.button("Show current").disabled, false);
  assert.equal(h.button("Add two Persian examples per routine").disabled, false);
  h.view.render(ready({ paused: true }));
  assert.match(h.panel.textContent, /Disabled — paused/);
  assert.equal(h.error.hidden, true);
  assert.equal(h.input("weeklyDefinition").disabled, false);
  assert.equal(h.button("Show current").disabled, true);
  assert.equal(h.button("Add two Persian examples per routine").disabled, true);
  assert.equal(h.button("History").disabled, false);
  h.view.destroy();
});

test("quick setup exposes one explicit primary action and collapses manual controls", async () => {
  const h = fixture(); h.button("More options").click();
  const primary = h.button("Set up this graph");
  h.view.render(ready());
  assert.equal(h.input("includeDaily").checked, true);
  assert.equal(h.button("Enable").visible, false);
  assert.equal(h.button("Install daily journal template").visible, false);
  assert.equal(h.input("calendar").visible, true);
  h.input("replaceExisting").click(); primary.click(); await tick();
  assert.deepEqual(h.calls[0], ["onQuickSetup", { calendar: "gregorian", autoOpen: true,
    definitions: { weekly: "Weekly routines", monthly: "Monthly routines" } }, "graph:a", {},
    { dailyTemplate: true, replaceExisting: true }]);
  assert.equal(h.input("replaceExisting").checked, false);
  h.input("includeDaily").click(); primary.click(); await tick();
  assert.equal(h.calls[1][4].dailyTemplate, false);
  h.view.render(ready({ enabled: true, setupMessage: "All set <unsafe>" }));
  const feedback = h.panel.querySelectorAll("p").find((node) => node.className === "jr-routines-feedback");
  assert.equal(feedback.textContent, "All set <unsafe>"); assert.equal(feedback.hidden, false);
});

test("primary setup locks duplicate actions and requires calendar approval", async () => {
  const work = deferred(), calls = [];
  const h = fixture({ onQuickSetup: (...args) => { calls.push(args); return work.promise; } });
  h.view.render(ready()); h.select("jalali");
  const primary = h.button("Set up this graph"); assert.equal(primary.disabled, true);
  h.button("Confirm calendar change").click(); primary.click();
  assert.equal(primary.textContent, "Setting up…"); assert.equal(primary.disabled, true);
  primary.dispatch("click"); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2], { confirmCalendarChange: true });
  work.resolve(); await tick(); assert.equal(primary.disabled, true, "render/save must confirm the authoritative calendar first");
  h.view.render(ready({ calendar: "jalali", enabled: true })); assert.equal(primary.disabled, false);
});

test("existing graph exposes daily selection and one apply action without opening advanced tools", async () => {
  const h = fixture(); h.button("More options").click();
  h.view.render(ready({ enabled: true, autoOpen: false }));
  const primary = h.button("Apply selected options");
  assert.equal(primary.visible, true);
  assert.equal(h.input("includeDaily").visible, true);
  assert.equal(h.button("Save settings").visible, false);
  assert.equal(h.button("Install daily journal template").visible, false);
  assert.match(h.panel.textContent, /Daily journals \(optional\)/);
  assert.match(h.input("includeDaily").parent.textContent, /Use the daily journal template \(recommended\)/);
  assert.match(h.panel.textContent, /two empty editable blocks each/);
  assert.ok(h.input("includeDaily").attributes["aria-describedby"]);
  h.input("includeDaily").click();
  assert.match(h.panel.textContent, /daily template and all existing journals stay unchanged/);
  primary.click(); await tick();
  assert.deepEqual(h.calls, [["onQuickSetup", { calendar: "gregorian", autoOpen: false,
    definitions: { weekly: "Weekly routines", monthly: "Monthly routines" } }, "graph:a", {},
    { dailyTemplate: false, replaceExisting: false }]]);
  h.view.render(ready({ enabled: true, setupMessage: "Routines are ready. Daily default unchanged." }));
  assert.equal(h.input("includeDaily").checked, false, "same-graph render retains selection");
  const feedback = h.panel.querySelectorAll("p").find((node) => node.className === "jr-routines-feedback");
  assert.equal(feedback.hidden, false);
  assert.equal(feedback.attributes["aria-live"], "polite");
  h.view.render(ready({ graphKey: "graph:b", enabled: true }));
  assert.equal(h.input("includeDaily").checked, true, "selection never leaks across graphs");
  assert.equal(feedback.hidden, true);
  h.view.destroy();
});

test("existing-graph apply communicates busy state and consumes replacement approval", async () => {
  const work = deferred(), calls = [];
  const h = fixture({ onQuickSetup: (...args) => { calls.push(args); return work.promise; } });
  h.view.render(ready({ enabled: true }));
  const primary = h.button("Apply selected options");
  h.input("replaceExisting").click(); primary.click();
  assert.equal(primary.textContent, "Applying…");
  assert.equal(primary.disabled, true);
  primary.dispatch("click");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][3], { dailyTemplate: true, replaceExisting: true });
  assert.equal(h.input("replaceExisting").checked, false);
  work.reject(new Error("Existing default was preserved")); await tick();
  assert.equal(primary.textContent, "Apply selected options");
  assert.match(h.error.textContent, /default was preserved/);
  h.view.destroy();
});

test("Save and Enable each pass options, captured graph key and configure-compatible approval", async () => {
  const h = fixture();
  h.view.render(ready());
  h.input("weeklyDefinition").value = "  My week  ";
  h.input("monthlyDefinition").value = "My month";
  h.input("autoOpen").click();
  h.button("Save settings").click();
  const options = { calendar: "gregorian", autoOpen: false,
    definitions: { weekly: "My week", monthly: "My month" } };
  assert.deepEqual(h.calls, [["onSave", options, "graph:a", {}]]);
  await tick();
  h.button("Enable").click();
  assert.deepEqual(h.calls[1], ["onEnable", options, "graph:a", {}]);
  assert.equal(Object.hasOwn(h.calls[1][3], "confirmCalendarChange"), false);
  // The view never enables separately, infers success, or renders a callback result.
  await tick();
  assert.equal(h.button("Enable").disabled, false);
  assert.equal(h.calls.length, 2);
  h.view.destroy();
});

test("definition validation rejects empty and case-insensitive duplicate names without handlers", () => {
  const h = fixture();
  h.view.render(ready());
  for (const value of ["  ", " monthly ROUTINES "]) {
    h.input("weeklyDefinition").value = value;
    h.button("Save settings").click();
    h.button("Enable").click();
    assert.deepEqual(h.calls, []);
    assert.match(h.error.textContent, /distinct, non-empty/);
    assert.equal(h.panel.attributes["aria-busy"], "false");
  }
  h.view.destroy();
});

test("calendar switch has one inline confirmation; Cancel restores saved calendar without a call", async () => {
  const h = fixture();
  h.view.render(ready());
  h.select("jalali");
  assert.equal(h.confirmation.hidden, false);
  assert.match(h.confirmation.textContent, /gregorian to jalali/);
  assert.match(h.confirmation.textContent, /history are preserved.*no conversions/);
  assert.equal(h.button("Save settings").disabled, true);
  assert.equal(h.button("Enable").disabled, true);
  h.button("Save settings").dispatch("click");
  h.button("Enable").dispatch("click");
  assert.deepEqual(h.calls, []);
  h.button("Cancel calendar change").click();
  assert.equal(h.calendar.value, "gregorian");
  assert.equal(h.confirmation.hidden, true);
  assert.deepEqual(h.calls, []);
  h.select("jalali");
  h.button("Confirm calendar change").click();
  assert.equal(h.confirmation.hidden, true);
  assert.equal(h.button("Enable").disabled, false);
  assert.deepEqual(h.calls, []);
  h.button("Enable").click();
  assert.deepEqual(h.calls[0], ["onEnable", {
    calendar: "jalali", autoOpen: true,
    definitions: { weekly: "Weekly routines", monthly: "Monthly routines" },
  }, "graph:a", { confirmCalendarChange: true }]);
  await tick();
  h.view.render(ready({ calendar: "jalali", enabled: true }));
  h.select("gregorian");
  h.button("Cancel calendar change").click();
  assert.equal(h.calendar.value, "jalali");
  h.select("gregorian");
  h.button("Confirm calendar change").click();
  h.button("Save settings").click();
  assert.equal(h.calls[1][1].calendar, "gregorian");
  assert.deepEqual(h.calls[1][3], { confirmCalendarChange: true });
  h.view.destroy();
});

test("selection edits, refresh and every authoritative render revoke approval, including mutated graph status", async () => {
  const h = fixture(), state = ready();
  h.view.render(state);
  h.select("jalali");
  h.button("Confirm calendar change").click();
  h.select("gregorian");
  h.select("jalali");
  assert.equal(h.button("Save settings").disabled, true);
  h.button("Confirm calendar change").click();
  h.button("Refresh").click();
  await tick();
  assert.equal(h.button("Save settings").disabled, true);
  h.button("Confirm calendar change").click();
  h.view.render(state);
  assert.equal(h.calendar.value, "gregorian");
  h.select("jalali");
  assert.equal(h.button("Save settings").disabled, true);
  h.button("Confirm calendar change").click();
  state.graphKey = "graph:b";
  state.graphName = "Graph B";
  h.view.render(state);
  h.select("jalali");
  h.button("Save settings").dispatch("click");
  assert.deepEqual(h.calls, [["onRefresh"]]);
  h.button("Confirm calendar change").click();
  h.button("Save settings").click();
  assert.equal(h.calls[1][2], "graph:b");
  h.view.destroy();
});

test("daily template installation is optional, graph-pinned and explicitly authorizes replacement", async () => {
  const h = fixture(), install = h.button("Install daily journal template");
  assert.equal(install.disabled, true);
  assert.equal(h.input("replaceExisting").checked, false);
  assert.match(h.panel.textContent, /Install separately from Enable/);
  assert.match(h.panel.textContent, /Focus and Tasks/);
  assert.match(h.panel.textContent, /Priority A shows unfinished priority-A tasks, excluding WAITING/);
  assert.match(h.panel.textContent, /Pending shows WAITING tasks/);
  assert.match(h.panel.textContent, /This week shows original weekly routine tasks and tasks scheduled or due this week, without copying/);
  assert.match(h.panel.textContent, /eligible empty today\/future journals, not populated journals/);
  assert.match(h.panel.textContent, /never replaced without your approval/);
  assert.match(h.panel.textContent, /Replace an existing default journal template \(its content is preserved\)/);
  h.view.render(ready());
  install.dispatch("click");
  assert.equal(install.disabled, true);
  assert.deepEqual(h.calls, []);
  h.button("Enable").click();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "onEnable");
  assert.equal(install.disabled, true);
  h.view.render(ready({ enabled: true }));
  install.click();
  assert.deepEqual(h.calls[1], ["onInstallDailyTemplate", "graph:a", { replaceExisting: false }]);
  await tick();
  h.input("replaceExisting").click();
  install.click();
  assert.deepEqual(h.calls[2], ["onInstallDailyTemplate", "graph:a", { replaceExisting: true }]);
  assert.equal(h.input("replaceExisting").checked, false);
  await tick();
  assert.equal(h.panel.isConnected, true);
  assert.equal(h.calls.some(([name]) => name === "onClose"), false);
  h.view.destroy();
});

test("daily template installer blocks unsaved calendar changes and resets replacement approval on status or graph render", () => {
  const h = fixture(), install = h.button("Install daily journal template"), approval = h.input("replaceExisting");
  const state = ready({ enabled: true });
  h.view.render(state);
  approval.click();
  assert.equal(approval.checked, true);
  h.view.render(state);
  assert.equal(approval.checked, false);
  approval.click();
  state.graphKey = "graph:b";
  h.view.render(state);
  assert.equal(approval.checked, false);
  h.select("jalali");
  assert.equal(install.disabled, true);
  assert.equal(approval.disabled, true);
  install.dispatch("click");
  h.button("Confirm calendar change").click();
  assert.equal(install.disabled, true);
  install.dispatch("click");
  assert.deepEqual(h.calls, []);
  h.select("gregorian");
  assert.equal(install.disabled, false);
  install.click();
  assert.deepEqual(h.calls, [["onInstallDailyTemplate", "graph:b", { replaceExisting: false }]]);
  h.view.destroy();
});

test("daily template installation locks busy controls and reports failures without retaining replacement approval", async () => {
  const work = deferred(), calls = [];
  const h = fixture({ onInstallDailyTemplate: (...args) => { calls.push(args); return work.promise; } });
  h.view.render(ready({ enabled: true }));
  h.input("replaceExisting").click();
  const install = h.button("Install daily journal template");
  install.click();
  assert.equal(h.panel.attributes["aria-busy"], "true");
  assert.equal(install.disabled, true);
  assert.equal(h.button("Apply daily template to today").disabled, true);
  h.button("Apply daily template to today").dispatch("click");
  assert.equal(h.input("replaceExisting").disabled, true);
  assert.equal(h.button("Save settings").disabled, true);
  install.dispatch("click");
  h.button("History").dispatch("click");
  h.view.render(ready({ enabled: true }));
  assert.equal(install.disabled, true);
  assert.equal(h.button("Disable").disabled, false);
  assert.equal(h.button("Close").disabled, false);
  assert.deepEqual(calls, [["graph:a", { replaceExisting: true }]]);
  work.resolve();
  await tick();
  assert.equal(install.disabled, false);
  assert.equal(h.input("replaceExisting").checked, false);
  h.view.destroy();

  const failed = fixture({ onInstallDailyTemplate: () => { throw new Error("Default template already exists"); } });
  failed.view.render(ready({ enabled: true }));
  failed.input("replaceExisting").click();
  failed.button("Install daily journal template").click();
  await tick();
  assert.equal(failed.error.textContent, "Default template already exists");
  assert.equal(failed.button("Install daily journal template").disabled, false);
  assert.equal(failed.input("replaceExisting").checked, false);
  failed.view.destroy();
});

test("apply-to-today is a separate graph-scoped action gated on enabled saved calendar", async () => {
  const h = fixture(), apply = h.button("Apply daily template to today");
  assert.equal(apply.disabled, true);
  assert.match(h.panel.textContent, /native default applies to eligible future pages but may skip today’s preexisting blank block/);
  assert.match(h.panel.textContent, /actual native today only if its journal is empty or has one blank block; populated journals are refused/);
  assert.match(h.panel.textContent, /Install may refresh icons and compact queries in untouched generated template sections, but preserves user edits/);
  assert.ok(apply.parent.children.indexOf(apply) > apply.parent.children.indexOf(h.button("Install daily journal template")));
  h.view.render(ready());
  apply.dispatch("click");
  assert.deepEqual(h.calls, []);
  h.view.render(ready({ enabled: true }));
  h.select("jalali");
  assert.equal(apply.disabled, true);
  apply.dispatch("click");
  h.button("Confirm calendar change").click();
  assert.equal(apply.disabled, true, "confirmation is not a saved calendar change");
  apply.dispatch("click");
  assert.deepEqual(h.calls, []);
  h.select("gregorian");
  h.input("replaceExisting").click();
  apply.click();
  assert.deepEqual(h.calls, [["onApplyDailyTemplateToday", "graph:a"]], "replacement checkbox is not an apply argument");
  await tick();
  h.view.render(ready({ graphKey: "graph:b", enabled: true }));
  apply.click();
  assert.deepEqual(h.calls[1], ["onApplyDailyTemplateToday", "graph:b"]);
  await tick();
  h.view.render(ready({ enabled: false }));
  assert.equal(apply.disabled, true);
  h.view.destroy();
});

test("apply-to-today busy lock blocks duplicate/cross-action work and preserves errors in setup", async () => {
  const work = deferred(), calls = [];
  const h = fixture({ onApplyDailyTemplateToday: (...args) => { calls.push(args); return work.promise; } });
  h.view.render(ready({ enabled: true }));
  const apply = h.button("Apply daily template to today");
  apply.click();
  assert.equal(h.panel.attributes["aria-busy"], "true");
  for (const label of ["Apply daily template to today", "Install daily journal template", "Save settings", "History", "Refresh"]) {
    assert.equal(h.button(label).disabled, true);
    h.button(label).dispatch("click");
  }
  assert.deepEqual(calls, [["graph:a"]]);
  assert.deepEqual(h.calls, []);
  assert.equal(h.button("Disable").disabled, false);
  assert.equal(h.button("Close").disabled, false);
  work.reject(new Error("Today’s journal is populated"));
  await tick();
  assert.equal(h.error.textContent, "Today’s journal is populated");
  assert.equal(apply.disabled, false);
  assert.equal(h.panel.isConnected, true);
  h.view.destroy();
});

test("stale apply-to-today completion cannot unlock or report against another graph's action", async () => {
  const first = deferred(), second = deferred(), calls = [];
  const h = fixture({ onApplyDailyTemplateToday: (...args) => {
    calls.push(args); return calls.length === 1 ? first.promise : second.promise;
  } });
  h.view.render(ready({ enabled: true }));
  h.button("Apply daily template to today").click();
  h.view.render(ready({ enabled: true, graphKey: "graph:b" }));
  assert.equal(h.button("Apply daily template to today").disabled, false);
  h.button("Apply daily template to today").click();
  assert.deepEqual(calls, [["graph:a"], ["graph:b"]]);
  first.reject(new Error("Stale graph A"));
  await tick();
  assert.equal(h.error.hidden, true);
  assert.equal(h.button("Apply daily template to today").disabled, true);
  second.resolve();
  await tick();
  assert.equal(h.button("Apply daily template to today").disabled, false);
  h.view.destroy();
});

test("all navigation, refresh, disable and close callbacks use the documented arguments", async () => {
  const h = fixture();
  h.view.render(ready({ enabled: true }));
  for (const label of ["Show current", "Add two Persian examples per routine", "History", "Open weekly definition", "Open monthly definition", "Refresh", "Disable", "Close"]) {
    h.button(label).click();
    await tick();
  }
  assert.deepEqual(h.calls, [
    ["onShowCurrent"], ["onAddExamples", "graph:a"], ["onShowHistory"], ["onOpenDefinition", "weekly"],
    ["onOpenDefinition", "monthly"], ["onRefresh"], ["onDisable", "graph:a"], ["onClose"],
  ]);
  h.view.destroy();
});

test("async busy lock blocks duplicate work across renders but Disable and Close interrupt immediately", async () => {
  const work = deferred(), stop = deferred(), calls = [];
  const h = fixture({
    onEnable: (...args) => { calls.push(["enable", ...args]); return work.promise; },
    onDisable: (...args) => { calls.push(["disable", ...args]); return stop.promise; },
    onClose: () => { calls.push(["close"]); },
  });
  h.view.render(ready());
  h.button("Enable").click();
  assert.equal(h.panel.attributes["aria-busy"], "true");
  h.view.render(ready());
  assert.ok(h.inputs.every((node) => node.disabled));
  for (const label of ["Enable", "Save settings", "Install daily journal template", "Apply daily template to today", "History", "Refresh", "Open weekly definition"]) {
    assert.equal(h.button(label).disabled, true);
    h.button(label).dispatch("click");
  }
  assert.equal(calls.length, 1);
  assert.equal(h.button("Disable").disabled, false);
  assert.equal(h.button("Close").disabled, false);
  h.button("Disable").click();
  h.button("Disable").click();
  assert.deepEqual(calls[1], ["disable", "graph:a"]);
  assert.equal(calls.length, 2);
  h.button("Close").click();
  assert.deepEqual(calls[2], ["close"]);
  work.reject(new Error("Cancelled enable"));
  await tick();
  assert.equal(h.error.hidden, true);
  assert.equal(h.button("Save settings").disabled, true);
  stop.resolve();
  await tick();
  assert.equal(h.panel.attributes["aria-busy"], "false");
  assert.equal(h.button("Save settings").disabled, false);
  h.view.destroy();
});

test("a graph switch releases old busy state; old completion cannot unlock or report against new work", async () => {
  const first = deferred(), second = deferred(), calls = [];
  const h = fixture({ onSave: (...args) => {
    calls.push(args);
    return calls.length === 1 ? first.promise : second.promise;
  } });
  h.view.render(ready());
  h.select("jalali");
  h.button("Confirm calendar change").click();
  h.button("Save settings").click();
  h.view.render(ready({ graphKey: "graph:b", graphName: "Graph B" }));
  assert.equal(h.button("Save settings").disabled, false);
  h.button("Save settings").click();
  assert.equal(calls[0][1], "graph:a");
  assert.equal(calls[0][0].calendar, "jalali");
  assert.equal(calls[1][1], "graph:b");
  assert.deepEqual(calls[1][2], {});
  first.reject(new Error("Old graph failure"));
  await tick();
  assert.equal(h.error.hidden, true);
  assert.equal(h.button("Save settings").disabled, true);
  second.resolve({ graphKey: "graph:a", error: "Not an authoritative status" });
  await tick();
  assert.equal(h.button("Save settings").disabled, false);
  assert.match(h.panel.textContent, /Graph: Graph B/);
  assert.equal(h.error.hidden, true);
  h.view.destroy();
});

test("rejected handlers and synchronous throws are shown safely, unlock UI and consume approval", async () => {
  const injection = '<script>alert("failed")</script>';
  const h = fixture({ onSave: () => Promise.reject(new Error(injection)),
    onRefresh: () => { throw new Error("Refresh failed"); } });
  h.view.render(ready());
  h.select("jalali");
  h.button("Confirm calendar change").click();
  h.button("Save settings").click();
  await tick();
  assert.equal(h.error.textContent, injection);
  assert.equal(h.panel.querySelectorAll("script").length, 0);
  assert.equal(h.panel.attributes["aria-busy"], "false");
  assert.equal(h.confirmation.hidden, false);
  assert.equal(h.button("Save settings").disabled, true);
  h.button("Refresh").click();
  await tick();
  assert.equal(h.error.textContent, "Refresh failed");
  assert.equal(h.button("Refresh").disabled, false);
  h.view.render(ready({ error: "Runtime dependency failure" }));
  assert.equal(h.error.textContent, "Runtime dependency failure");
  h.view.destroy();
});

test("focus traps enabled visible controls, handles outside focus and Escape even while busy", async () => {
  const work = deferred();
  const h = fixture({ onSave: () => work.promise });
  h.view.render(ready());
  h.view.focus();
  assert.equal(h.document.activeElement, h.calendar);
  h.document.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.ok(h.document.activeElement === h.button("Refresh"), "expanded tools follow the primary actions in tab order");
  assert.equal(h.document.dispatch("keydown", { key: "Tab" }).defaultPrevented, true);
  assert.equal(h.document.activeElement, h.calendar);
  assert.equal(h.document.dispatch("keydown", { key: "Tab" }).defaultPrevented, false);
  h.previous.focus();
  assert.equal(h.document.activeElement, h.calendar);
  h.select("jalali");
  h.button("Confirm calendar change").focus();
  assert.equal(h.document.activeElement, h.button("Confirm calendar change"));
  h.button("Cancel calendar change").click();
  assert.equal(h.document.activeElement, h.calendar);
  h.button("Save settings").click();
  h.view.focus();
  assert.ok(h.document.activeElement === h.button("More options"));
  h.document.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.ok(h.document.activeElement === h.button("Disable"));
  h.document.dispatch("keydown", { key: "Tab" });
  assert.ok(h.document.activeElement === h.button("More options"));
  const escape = h.document.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  assert.deepEqual(h.calls, [["onClose"]]);
  work.resolve();
  await tick();
  h.view.destroy();
});

test("destroy removes all listeners, styles and UI, restores focus, and ignores late work", async () => {
  const work = deferred();
  const h = fixture({ onEnable: () => work.promise });
  h.view.render(ready());
  h.view.focus();
  h.button("Enable").click();
  assert.ok(listenerCount(h.document) > 0);
  assert.ok(listenerCount(h.overlay) > 0);
  h.view.destroy();
  h.view.destroy();
  assert.equal(listenerCount(h.document), 0);
  assert.equal(listenerCount(h.overlay), 0);
  assert.equal(h.document.head.children.length, 0);
  assert.deepEqual(h.document.body.children, [h.previous]);
  assert.equal(h.document.activeElement, h.previous);
  for (const node of h.buttons) node.dispatch("click");
  h.calendar.dispatch("change");
  h.document.dispatch("keydown", { key: "Escape" });
  h.view.render(ready());
  h.view.focus();
  work.reject(new Error("Late failure"));
  await tick();
  assert.equal(h.error.hidden, true);
  assert.equal(h.document.activeElement, h.previous);
  assert.deepEqual(h.calls, []);
});
