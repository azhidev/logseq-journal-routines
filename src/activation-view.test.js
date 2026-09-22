import assert from "node:assert/strict";
import test from "node:test";
import packageInfo from "../package.json" with { type: "json" };
import { mountActivationView } from "./activation-view.js";

// Minimal DOM fixture: deliberately rejects HTML sinks and tracks listener cleanup.
class Element {
  constructor(document, tag) {
    this.document = document; this.tagName = tag; this.children = []; this.attributes = {};
    this.listeners = new Map(); this.disabled = false; this.checked = false; this.text = "";
  }
  set innerHTML(_) { throw new Error("Unsafe HTML sink"); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; this.text = ""; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, props = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (const fn of this.listeners.get(type) || []) fn(event);
    return event;
  }
  click() {
    if (this.disabled) return;
    if (this.type === "checkbox") { this.checked = !this.checked; this.dispatch("change"); }
    this.dispatch("click");
  }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  get isConnected() { return this.document.head.contains(this) || this.document.body.contains(this); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map((tag) => tag.trim());
    return this.children.flatMap((child) => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
function fixture() {
  const document = { createElement(tag) { return new Element(this, tag); } };
  document.head = document.createElement("head"); document.body = document.createElement("body");
  const previous = document.body.appendChild(document.createElement("button")); previous.focus();
  const calls = [];
  const view = mountActivationView(document, {
    onInspect: () => calls.push(["inspect"]), onEnable: (value) => calls.push(["enable", value]),
    onDisable: () => calls.push(["disable"]), onSidebar: (value) => calls.push(["sidebar", value]),
    onClose: () => calls.push(["close"]),
  });
  const overlay = document.body.children[1], panel = overlay.children[0];
  const inputs = panel.querySelectorAll("input");
  const buttons = panel.querySelectorAll("button");
  return { document, previous, view, calls, overlay, panel, inputs, buttons,
    approve() { for (const input of inputs.slice(0, 3)) input.click(); } };
}
const ready = (overrides = {}) => ({
  status: "ready", message: "Ready for review", configured: false, canEnable: true, sidebar: true,
  summary: { changes: [{ title: "Create Week Routine", content: "TODO Review active projects" }], blockers: [], configuration: "daily-default" },
  ...overrides,
});

test("exports lifecycle API, package build, standalone scope and accessible initial disabled state", () => {
  const h = fixture();
  assert.deepEqual(Object.keys(h.view).sort(), ["destroy", "focus", "render"]);
  assert.match(h.panel.textContent, /Journal & Routines/);
  assert.ok(h.panel.textContent.includes(`Build ${packageInfo.version}`));
  assert.match(h.panel.textContent, /Persian Calendar is the only plugin dependency/);
  assert.match(h.panel.textContent, /No automatic historical changes/);
  assert.match(h.panel.textContent, /not checks performed by the plugin/);
  assert.equal(h.buttons[0].disabled, true);
  assert.equal(h.inputs[3].checked, true);
  assert.equal(h.panel.attributes.role, "dialog");
  assert.equal(h.panel.attributes["aria-modal"], "true");
  assert.equal(h.panel.attributes["aria-labelledby"], h.panel.children[0].id);
  for (const input of h.inputs) assert.equal(input.parent.tagName, "label");
  assert.equal(h.panel.querySelectorAll("p").find((p) => p.attributes.role === "status").attributes["aria-live"], "polite");
  h.view.destroy();
});

test("enable requires canEnable and all approvals; delivers exact payload once until render", () => {
  const h = fixture(), enable = h.buttons[0];
  h.view.render(ready());
  for (const input of h.inputs.slice(0, 2)) input.click();
  assert.equal(enable.disabled, true);
  h.inputs[2].click(); assert.equal(enable.disabled, false);
  h.inputs[0].click(); assert.equal(enable.disabled, true);
  h.inputs[0].click(); enable.click(); enable.dispatch("click");
  assert.deepEqual(h.calls, [["enable", {
    backupConfirmed: true, legacyAutomationDisabled: true, liveSafetyAcknowledged: true,
  }]]);
  assert.equal(enable.disabled, true);
  assert.ok(h.inputs.slice(0, 3).every((input) => !input.checked));
  h.view.render(ready({ canEnable: false }));
  // Even a synthetic change/click cannot bypass the parent gate.
  for (const input of h.inputs.slice(0, 3)) input.checked = true;
  enable.dispatch("click"); assert.equal(h.calls.length, 1);
  h.view.destroy();
});

test("every render invalidates approvals, including identical and mutated summary references", () => {
  const h = fixture(), state = ready();
  h.view.render(state); h.approve();
  h.view.render(state);
  assert.ok(h.inputs.slice(0, 3).every((input) => !input.checked));
  assert.equal(h.buttons[0].disabled, true);
  h.approve(); state.summary.changes[0].content = "Changed plan"; h.view.render(state);
  assert.ok(h.inputs.slice(0, 3).every((input) => !input.checked));
  assert.match(h.panel.textContent, /Changed plan/);
  h.approve(); h.view.render(ready({ summary: undefined, canEnable: false }));
  assert.ok(h.inputs.slice(0, 3).every((input) => !input.checked));
  assert.doesNotMatch(h.panel.textContent, /Changed plan/);
  h.view.destroy();
});

test("all status labels and busy gates render; Disable and Close remain usable", () => {
  const h = fixture();
  for (const [status, label] of Object.entries({ "setup-required": "Setup required", checking: "Checking",
    ready: "Ready", enabling: "Enabling", enabled: "Enabled", paused: "Paused", disabled: "Disabled" })) {
    h.view.render(ready({ status, message: "Current reason", configured: true }));
    assert.ok(h.panel.textContent.includes(`${label} — Current reason`));
    assert.equal(h.buttons[0].textContent, "Enable");
    h.approve();
    assert.equal(h.buttons[0].disabled, ["checking", "enabling", "enabled"].includes(status));
    assert.equal(h.buttons[2].disabled, ["checking", "enabling"].includes(status));
    assert.equal(h.inputs[3].disabled, ["checking", "enabling"].includes(status));
    assert.equal(h.buttons[1].disabled, false); assert.equal(h.buttons[3].disabled, false);
  }
  h.view.render(ready({ status: "enabling" })); h.buttons[1].click(); h.buttons[3].click();
  assert.deepEqual(h.calls, [["disable"], ["close"]]);
  h.view.destroy();
});

test("refresh revokes approvals immediately, sidebar emits booleans and neither grants approval", () => {
  const h = fixture(); h.view.render(ready()); h.approve();
  h.inputs[3].click(); assert.deepEqual(h.calls, [["sidebar", false]]);
  h.buttons[2].click(); h.buttons[2].dispatch("click");
  assert.deepEqual(h.calls, [["sidebar", false], ["inspect"]]);
  assert.equal(h.buttons[0].disabled, true);
  assert.ok(h.inputs.slice(0, 3).every((input) => !input.checked));
  h.view.render(ready({ sidebar: false })); assert.equal(h.inputs[3].checked, false);
  h.inputs[3].click(); assert.deepEqual(h.calls[2], ["sidebar", true]);
  h.view.destroy();
});

test("renders additions and blocker messages as text, with exact non-destructive config instruction", () => {
  const h = fixture(), source = '<img src=x onerror="alert(1)">';
  h.view.render(ready({ message: source, summary: {
    changes: [{ title: source, content: source }, { title: "Input", content: "" }],
    blockers: [{ message: source, code: "private-diagnostic" }], configuration: "manual-selection-required",
  } }));
  assert.equal(h.panel.querySelectorAll("img").length, 0);
  assert.ok(h.panel.querySelectorAll("pre").some((pre) => pre.textContent === source));
  assert.ok(h.panel.querySelectorAll("pre").some((pre) => pre.textContent === ':default-templates {:journals "daily-default"}'));
  assert.match(h.panel.textContent, /change only its :journals entry; preserve all other entries/);
  assert.match(h.panel.textContent, /then choose Refresh status/);
  assert.match(h.panel.textContent, /\(Empty block\)/);
  assert.doesNotMatch(h.panel.textContent, /private-diagnostic/);
  h.view.render(ready({ summary: { changes: [], blockers: [], configuration: "daily-default" } }));
  assert.doesNotMatch(h.panel.textContent, /Select the journal template/);
  assert.match(h.panel.textContent, /No setup additions listed/);
  h.view.destroy();
});

test("focus wraps across enabled controls, Escape closes and destroy cleans up idempotently", () => {
  const h = fixture(); h.view.render(ready()); h.view.focus();
  assert.equal(h.document.activeElement, h.buttons[3]);
  assert.equal(h.overlay.dispatch("keydown", { key: "Tab" }).defaultPrevented, true);
  assert.equal(h.document.activeElement, h.inputs[0]);
  h.overlay.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.equal(h.document.activeElement, h.buttons[3]);
  h.view.render(ready({ status: "checking" }));
  h.overlay.dispatch("keydown", { key: "Tab" }); assert.equal(h.document.activeElement, h.buttons[1]);
  h.overlay.dispatch("keydown", { key: "Escape" }); assert.deepEqual(h.calls, [["close"]]);
  h.view.destroy(); h.view.destroy();
  assert.equal(h.document.head.children.length, 0);
  assert.deepEqual(h.document.body.children, [h.previous]);
  assert.equal(h.document.activeElement, h.previous);
  h.view.render(ready()); h.view.focus();
  for (const button of h.buttons) button.dispatch("click");
  for (const input of h.inputs) input.dispatch("change");
  h.overlay.dispatch("keydown", { key: "Escape" });
  assert.deepEqual(h.calls, [["close"]]);
  assert.equal(h.document.activeElement, h.previous);
});
