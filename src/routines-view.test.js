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
    "onSave", "onEnable", "onDisable", "onShowCurrent", "onShowHistory", "onAddExamples",
    "onOpenDefinition", "onRefresh", "onClose",
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
  for (const label of ["Enable", "Save settings", "History", "Refresh", "Open weekly definition"]) {
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
  assert.equal(h.document.activeElement, h.button("Close"));
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
  assert.equal(h.document.activeElement, h.button("Disable"));
  h.document.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.equal(h.document.activeElement, h.button("Close"));
  h.document.dispatch("keydown", { key: "Tab" });
  assert.equal(h.document.activeElement, h.button("Disable"));
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
