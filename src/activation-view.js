import packageInfo from "../package.json" with { type: "json" };

let nextViewId = 0;
const STATUS_LABELS = {
  "setup-required": "Setup required", checking: "Checking", ready: "Ready",
  enabling: "Enabling", enabled: "Enabled", paused: "Paused", disabled: "Disabled",
};

/**
 * Pure iframe UI; the caller owns inspection, plan validation and all SDK work.
 * onEnable receives { backupConfirmed, legacyAutomationDisabled,
 * liveSafetyAcknowledged } (booleans). These are user declarations, not evidence.
 * Every render clears approvals, even for the same summary object: the public
 * summary has no graph/plan identity with which to safely retain authorization.
 */
export function mountActivationView(document, { onInspect, onEnable, onDisable, onSidebar, onClose }) {
  const id = `jr-activation-${++nextViewId}`;
  const previousFocus = document.activeElement;
  let destroyed = false, state = null, pending = false;
  const listeners = [];
  const style = document.createElement("style");
  style.textContent = `
    .jr-activation { position: fixed; inset: 0; z-index: 1; display: grid; place-items: center;
      padding: 16px; box-sizing: border-box; background: rgb(0 0 0 / 30%);
      color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    .jr-activation * { box-sizing: border-box; }
    .jr-activation-panel { width: min(720px, 100%); min-width: 0; max-height: 100%; overflow: auto;
      padding: 24px; border: 1px solid GrayText; border-radius: 12px;
      background: Canvas; color: CanvasText; overflow-wrap: anywhere; }
    .jr-activation h1 { margin: 0; font-size: 1.4rem; }
    .jr-activation h2, .jr-activation legend { font-size: 1.05rem; font-weight: 600; }
    .jr-activation h2 { margin: 20px 0 8px; }
    .jr-activation p { margin: 8px 0; }
    .jr-activation ol, .jr-activation ul { padding-inline-start: 24px; }
    .jr-activation li { margin: 8px 0; }
    .jr-activation pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px;
      border: 1px solid GrayText; border-radius: 6px; }
    .jr-activation fieldset { min-width: 0; margin: 20px 0; padding: 12px;
      border: 1px solid GrayText; border-radius: 6px; }
    .jr-activation label { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; }
    .jr-activation input { flex: 0 0 auto; margin-top: 4px; }
    .jr-activation-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    .jr-activation button { max-width: 100%; padding: 8px 12px; border: 1px solid GrayText;
      border-radius: 6px; font: inherit; color: ButtonText; background: ButtonFace; cursor: pointer; }
    .jr-activation button:disabled { cursor: not-allowed; opacity: .6; }
    .jr-activation button:focus-visible, .jr-activation input:focus-visible {
      outline: 2px solid Highlight; outline-offset: 3px; }
    .jr-activation-status { padding: 12px; border-inline-start: 3px solid Highlight; }
    .jr-activation-build { font-size: .9rem; }
    @media (max-width: 480px) {
      .jr-activation { padding: 8px; }
      .jr-activation-panel { padding: 16px; }
      .jr-activation-actions button { flex: 1 1 140px; }
    }
  `;
  const overlay = document.createElement("div");
  overlay.className = "jr-activation";
  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  }
  function listen(node, event, handler) {
    node.addEventListener(event, handler);
    listeners.push(() => node.removeEventListener(event, handler));
  }
  const panel = element("section", undefined, overlay);
  panel.className = "jr-activation-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", `${id}-title`);
  element("h1", "Journal & Routines", panel).id = `${id}-title`;
  element("p", `Build ${packageInfo.version}`, panel).className = "jr-activation-build";
  element("p", "Standalone for Logseq Desktop 0.10.15 Markdown file graphs. Persian Calendar is the only plugin dependency; no starter custom.js or custom.css is required.", panel);
  element("p", "Automation applies to today and future journals only, with routine tasks copied when their period is current. No automatic historical changes or migration. Existing notes, completed tasks, templates and unrelated settings stay intact.", panel);
  const status = element("p", undefined, panel);
  status.className = "jr-activation-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const review = element("section", undefined, panel);
  review.setAttribute("aria-label", "Setup review");
  const approvalsArea = element("fieldset", undefined, panel);
  element("legend", "Review and confirm before enabling", approvalsArea);
  const approvalHelp = element("p", "Back up this graph using your normal file backup or export workflow before any changes. These confirmations are your acknowledgments, not checks performed by the plugin. Review and confirm again after a status refresh.", approvalsArea);
  approvalHelp.id = `${id}-approval-help`;
  approvalsArea.setAttribute("aria-describedby", approvalHelp.id);
  function checkbox(name, text, parent) {
    const label = element("label", undefined, parent);
    const input = element("input", undefined, label);
    input.type = "checkbox";
    input.name = name;
    element("span", text, label);
    return input;
  }
  const approvals = {
    backupConfirmed: checkbox("backupConfirmed", "I have made a current backup of this graph and can restore it.", approvalsArea),
    legacyAutomationDisabled: checkbox("legacyAutomationDisabled", "No overlapping legacy journal automation is running. If present, I have disabled only that automation, not unrelated custom.js features.", approvalsArea),
    liveSafetyAcknowledged: checkbox("liveSafetyAcknowledged", "I am using a disposable graph, or have completed the relevant live Desktop safety checks before enabling on personal notes. I understand this screen does not verify those checks.", approvalsArea),
  };
  const sidebar = checkbox("sidebar", "Automatically open or reuse weekly and monthly routine owner panes", panel);
  element("p", "Other sidebar panes are preserved. Disable stops new automatic work and leaves generated graph content in place.", panel);
  const actions = element("div", undefined, panel);
  actions.className = "jr-activation-actions";
  function button(text) {
    const node = element("button", text, actions);
    node.type = "button";
    return node;
  }
  const enable = button("Set up & Enable");
  const disable = button("Disable");
  const inspect = button("Refresh status");
  const close = button("Close");

  function busy() { return pending || state?.status === "checking" || state?.status === "enabling"; }
  function eligible() {
    return !destroyed && !busy() && state?.canEnable === true && state.status !== "enabled";
  }
  function updateEnable() {
    enable.disabled = !eligible() || !Object.values(approvals).every((input) => input.checked);
  }
  function clearApprovals() {
    for (const input of Object.values(approvals)) input.checked = false;
    updateEnable();
  }
  function beginAction() {
    pending = true;
    clearApprovals();
    for (const input of Object.values(approvals)) input.disabled = true;
    inspect.disabled = true;
    sidebar.disabled = true;
  }
  for (const input of Object.values(approvals)) listen(input, "change", updateEnable);
  listen(enable, "click", () => {
    updateEnable();
    if (enable.disabled) return;
    const values = Object.fromEntries(Object.entries(approvals).map(([key, input]) => [key, input.checked]));
    beginAction();
    onEnable(values);
  });
  listen(inspect, "click", () => {
    if (destroyed || busy()) return;
    beginAction();
    onInspect();
  });
  listen(disable, "click", () => {
    if (destroyed) return;
    // Disable remains available even while an inspect/enable operation is pending.
    beginAction();
    onDisable();
  });
  listen(sidebar, "change", () => { if (!destroyed && !sidebar.disabled) onSidebar(sidebar.checked); });
  listen(close, "click", () => { if (!destroyed) onClose(); });
  listen(overlay, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      const controls = [...panel.querySelectorAll("button, input")].filter((node) => !node.disabled);
      const first = controls[0], last = controls[controls.length - 1];
      if (!controls.includes(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  });

  function render(nextState) {
    if (destroyed) return;
    state = { ...nextState };
    pending = false;
    clearApprovals();
    const label = STATUS_LABELS[state.status] || "Setup required";
    status.textContent = state.message ? `${label} — ${state.message}` : label;
    review.setAttribute("aria-busy", String(busy()));
    review.replaceChildren();
    element("h2", "Review additions", review);
    if (!state.summary) {
      element("p", "Refresh status to inspect this graph and review any required additions.", review);
    } else {
      const { changes, blockers, configuration } = state.summary;
      if (changes.length) {
        const list = element("ol", undefined, review);
        for (const change of changes) {
          const item = element("li", undefined, list);
          element("strong", change.title, item);
          element("pre", change.content === "" ? "(Empty block)" : change.content, item).dir = "auto";
        }
      } else {
        element("p", "No setup additions listed. Existing content will not be reset or refilled.", review);
      }
      if (blockers.length) {
        element("h2", "Resolve before enabling", review);
        const list = element("ul", undefined, review);
        for (const blocker of blockers) element("li", blocker.message, list);
      }
      if (configuration === "manual-selection-required") {
        element("h2", "Select the journal template", review);
        element("p", "In this graph’s logseq/config.edn, set the journal template as follows:", review);
        element("pre", ':default-templates {:journals "daily-default"}', review);
        element("p", "If :default-templates already exists, change only its :journals entry; preserve all other entries and unrelated configuration. Do not add a duplicate key or replace the whole file. Save, let Logseq reload the configuration, then choose Refresh status.", review);
      }
    }
    enable.textContent = state.configured ? "Enable" : "Set up & Enable";
    for (const input of Object.values(approvals)) input.disabled = !eligible();
    inspect.disabled = busy();
    sidebar.checked = state.sidebar === true;
    sidebar.disabled = busy();
  }

  document.head.appendChild(style);
  document.body.appendChild(overlay);
  render({ status: "setup-required", message: "", canEnable: false, configured: false, sidebar: true });
  return {
    render,
    focus() { if (!destroyed) close.focus(); },
    destroy() {
      if (destroyed) return;
      const restoreFocus = overlay.contains(document.activeElement);
      destroyed = true;
      for (const remove of listeners) remove();
      overlay.remove();
      style.remove();
      if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
    },
  };
}
