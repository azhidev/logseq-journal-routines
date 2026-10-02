let nextViewId = 0;

/**
 * Native setup UI only: no SDK calls, storage, or automatic actions on mount.
 * render(runtime.getStatus()) is authoritative and revokes calendar approval.
 * onSave/onEnable(options, graphKey, confirmation) receive configure-compatible
 * arguments. onEnable must await configure before enable(graphKey).
 * onInstallDailyTemplate(graphKey, { replaceExisting }) installs only on explicit
 * request; replacement approval is reset by render and consumed by submission.
 * onApplyDailyTemplateToday(graphKey) applies only to native today on request.
 * onDisable(graphKey), onOpenDefinition(kind), and the remaining zero-argument
 * handlers may return promises. The parent renders updated status and owns
 * showMainUI/hideMainUI; callback return values are not treated as status.
 */
export function mountRoutinesView(document, {
  onSave, onEnable, onQuickSetup, onDisable, onShowCurrent, onShowHistory,
  onAddExamples, onInstallDailyTemplate, onApplyDailyTemplateToday, onOpenDefinition, onRefresh, onClose,
}) {
  const id = `jr-routines-${++nextViewId}`;
  const previousFocus = document.activeElement;
  const listeners = [];
  let destroyed = false, state = null, approvedCalendar = null;
  let revision = 0, actionVersion = 0;
  let pending = new Set();

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
  const style = document.createElement("style");
  style.textContent = `
    .jr-routines { position: fixed; inset: 0; display: grid; place-items: center;
      padding: 16px; background: rgb(0 0 0 / 30%); color-scheme: light dark;
      font: 14px/1.5 system-ui, sans-serif; }
    .jr-routines * { box-sizing: border-box; }
    .jr-routines [hidden] { display: none; }
    .jr-routines-panel { width: min(720px, 100%); max-height: 100%; overflow: auto;
      padding: 28px; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 18px;
      box-shadow: 0 20px 70px rgb(0 0 0 / 25%);
      background: Canvas; color: CanvasText; overflow-wrap: anywhere; }
    .jr-routines h1 { margin: 0; font-size: 1.6rem; letter-spacing: -.03em; }
    .jr-routines h2 { margin: 20px 0 8px; font-size: 1rem; }
    .jr-routines-intro { color: GrayText; }
    .jr-routines-preview { padding: 14px 16px; border-radius: 10px; line-height: 1.9;
      background: color-mix(in srgb, Highlight 8%, Canvas); }
    .jr-routines-primary { background: Highlight !important; color: HighlightText !important;
      border-color: Highlight !important; font-weight: 600 !important; flex: 1; }
    .jr-routines-summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .jr-routines-summary p { margin: 0 !important; padding: 4px 10px; border-radius: 20px;
      background: color-mix(in srgb, CanvasText 6%, Canvas); font-size: .85rem; }
    .jr-routines-feedback { border-inline-start: 3px solid Highlight; padding: 10px 14px;
      background: color-mix(in srgb, Highlight 6%, Canvas); border-radius: 6px; }
    .jr-routines-advanced { margin-top: 18px; padding-top: 4px; border-top: 1px solid GrayText; }
    .jr-routines-advanced p { font-size: .9rem; color: GrayText; }
    .jr-routines p { margin: 10px 0; }
    .jr-routines label { display: block; margin: 12px 0; }
    .jr-routines input[type=text], .jr-routines select { display: block; width: 100%;
      padding: 6px; font: inherit; }
    .jr-routines input[type=checkbox] { margin-inline-end: 8px; }
    .jr-routines-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .jr-routines button { padding: 8px 12px; font: inherit; cursor: pointer;
      border: 1px solid GrayText; border-radius: 6px; color: ButtonText; background: ButtonFace; }
    .jr-routines button:disabled { cursor: not-allowed; opacity: .6; }
    .jr-routines :focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
    .jr-routines-confirmation { border-inline-start: 3px solid Highlight; padding: 12px; }
    .jr-routines [role=alert] { font-weight: 600; }
    @media (max-width: 480px) { .jr-routines { padding: 8px; }
      .jr-routines-panel { padding: 16px; } }
  `;
  const overlay = document.createElement("div");
  overlay.className = "jr-routines";
  const panel = element("section", undefined, overlay);
  panel.className = "jr-routines-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", `${id}-title`);
  element("h1", "Journal & Routines", panel).id = `${id}-title`;
  element("p", "Your weekly routines and daily plan, together in Logseq.", panel).className = "jr-routines-intro";
  const summary = element("div", undefined, panel);
  summary.className = "jr-routines-summary";
  const graph = element("p", undefined, summary);
  const status = element("p", undefined, summary);
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const error = element("p", undefined, panel);
  error.setAttribute("role", "alert");
  const feedback = element("p", undefined, panel);
  feedback.className = "jr-routines-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const advanced = document.createElement("div");
  advanced.className = "jr-routines-advanced";
  advanced.id = `${id}-advanced`;
  advanced.hidden = true;
  element("h2", "Definitions and manual actions", advanced);
  element("p", "Early build — Logseq Desktop 0.10.15 behavior is unverified. Test on a disposable Markdown file graph first.", advanced);
  element("p", "Enable creates one current week and month snapshot. When both default definition pages are new, it seeds two Persian TODOs in each definition and current period; existing or selected definitions are left unchanged. No journal edits or template changes.", advanced);
  element("p", "Edit definitions before Enable to choose your own first tasks. Later definition edits affect future periods only: no refill of deleted tasks, reset of completed tasks, or carry-forward. Missed periods are not backfilled; history stays intact when disabled.", advanced);

  const calendarLabel = element("label", "Calendar", panel);
  const calendar = element("select", undefined, calendarLabel);
  calendar.name = "calendar";
  element("option", "Gregorian — Monday weeks", calendar).value = "gregorian";
  element("option", "Jalali — Saturday weeks", calendar).value = "jalali";
  const calendarHelp = element("p", "Gregorian works alone. Jalali requires a compatible Persian Calendar plugin; availability is checked before switching. Existing history is never converted.", panel);
  calendarHelp.id = `${id}-calendar-help`;
  calendar.setAttribute("aria-describedby", calendarHelp.id);

  const confirmation = element("div", undefined, panel);
  confirmation.className = "jr-routines-confirmation";
  const confirmationText = element("p", undefined, confirmation);
  confirmationText.id = `${id}-confirmation`;
  confirmation.setAttribute("role", "group");
  confirmation.setAttribute("aria-labelledby", confirmationText.id);
  function button(text, parent) {
    const node = element("button", text, parent);
    node.type = "button";
    return node;
  }
  const confirm = button("Confirm calendar change", confirmation);
  const cancel = button("Cancel calendar change", confirmation);

  const definitions = {};
  for (const kind of ["weekly", "monthly"]) {
    const label = element("label", `${kind === "weekly" ? "Weekly" : "Monthly"} definition page`, advanced);
    const input = element("input", undefined, label);
    input.type = "text";
    input.name = `${kind}Definition`;
    definitions[kind] = input;
  }
  element("p", "Save settings before opening a newly selected definition page. Disable before changing definition page names; old snapshots stay unchanged.", advanced);
  const autoLabel = element("label", undefined, panel);
  const autoOpen = element("input", undefined, autoLabel);
  autoOpen.type = "checkbox";
  autoOpen.name = "autoOpen";
  element("span", "Automatically open current routines on activation, startup and rollover", autoLabel);
  const dailyLabel = element("label", undefined, panel);
  const includeDaily = element("input", undefined, dailyLabel);
  includeDaily.type = "checkbox";
  includeDaily.name = "includeDaily";
  includeDaily.checked = true;
  element("span", "Include the daily journal template and apply it to today if empty", dailyLabel);
  element("div", "🎯 Focus  ·  ☑️ Tasks  ·  🚩 Priority A  ·  ⏳ Pending  ·  📅 This week", panel).className = "jr-routines-preview";
  element("p", "One step enables routines and sets up your daily plan. Populated journals and completed tasks are preserved.", panel);
  element("h2", "Daily template tools", advanced);
  element("p", "Install separately from Enable. Focus and Tasks provide space for your daily plan and tasks. Priority A shows unfinished priority-A tasks, excluding WAITING; Pending shows WAITING tasks. This week shows original weekly routine tasks and tasks scheduled or due this week, without copying them.", advanced);
  element("p", "Logseq’s native default template applies to eligible empty today/future journals, not populated journals. An existing nonblank, different default journal template is never replaced without your approval; its content is preserved.", advanced);
  const replaceLabel = element("label", undefined, panel);
  const replaceExisting = element("input", undefined, replaceLabel);
  replaceExisting.type = "checkbox";
  replaceExisting.name = "replaceExisting";
  element("span", "Replace an existing default journal template (its content is preserved)", replaceLabel);
  const installDailyTemplate = button("Install daily journal template", advanced);
  element("p", "Install may refresh icons and compact queries in untouched generated template sections, but preserves user edits and populated journals.", advanced);
  element("p", "The native default applies to eligible future pages but may skip today’s preexisting blank block. Apply daily template to today targets the actual native today only if its journal is empty or has one blank block; populated journals are refused. Install the template first. This separate action does not target the journal you happen to be browsing.", advanced);
  const applyDailyTemplateToday = button("Apply daily template to today", advanced);

  const actions = element("div", undefined, advanced);
  actions.className = "jr-routines-actions";
  const save = button("Save settings", actions);
  const enable = button("Enable", actions);
  const disable = button("Disable", actions);
  const current = button("Show current", actions);
  const examples = button("Add two Persian examples per routine", actions);
  const history = button("History", actions);
  element("p", "For previously empty periods and definitions: this optional action adds the same examples only if all four pages are unchanged and empty. Existing tasks are never overwritten; an uncertain insert pauses for inspection.", advanced);
  const weekly = button("Open weekly definition", actions);
  const monthly = button("Open monthly definition", actions);
  const refresh = button("Refresh", actions);
  panel.appendChild(advanced);
  const primaryActions = element("div", undefined, panel);
  primaryActions.className = "jr-routines-actions";
  const quickSetup = button("Set up this graph", primaryActions);
  quickSetup.className = "jr-routines-primary";
  const more = button("More options", primaryActions);
  more.setAttribute("aria-controls", advanced.id);
  more.setAttribute("aria-expanded", "false");
  const close = button("Close", primaryActions);
  listen(more, "click", () => {
    advanced.hidden = !advanced.hidden;
    more.setAttribute("aria-expanded", String(!advanced.hidden));
  });

  function graphReady() { return typeof state?.graphKey === "string" && !!state.graphKey; }
  function changedCalendar() { return graphReady() && calendar.value !== state.calendar; }
  function setError(message) {
    error.textContent = message == null ? "" : String(message);
    error.hidden = !error.textContent;
  }
  function update() {
    const busy = pending.size > 0;
    const locked = busy || !graphReady();
    const needsConfirmation = changedCalendar() && approvedCalendar !== calendar.value;
    panel.setAttribute("aria-busy", String(busy));
    calendar.disabled = locked;
    autoOpen.disabled = locked;
    includeDaily.disabled = locked;
    quickSetup.disabled = locked || needsConfirmation;
    quickSetup.textContent = pending.has("quickSetup") ? "Setting up…" : "Set up this graph";
    for (const input of Object.values(definitions)) input.disabled = locked || !!state?.enabled;
    confirmation.hidden = !needsConfirmation;
    confirmationText.textContent = `Switch from ${state?.calendar} to ${calendar.value}? Old periods and history are preserved as-is: no conversions, renaming, merging or deletion. The selected calendar determines current periods after you save or enable.`;
    confirm.disabled = locked;
    cancel.disabled = locked;
    save.disabled = locked || needsConfirmation;
    enable.disabled = locked || needsConfirmation || !!state?.enabled;
    // Disable is an interrupt, including during a pending Enable on a disabled graph.
    disable.disabled = !graphReady();
    current.disabled = locked || !state?.enabled;
    examples.disabled = locked || !state?.enabled || changedCalendar();
    installDailyTemplate.disabled = locked || !state?.enabled || changedCalendar();
    replaceExisting.disabled = locked || needsConfirmation;
    applyDailyTemplateToday.disabled = installDailyTemplate.disabled;
    for (const node of [history, weekly, monthly]) node.disabled = locked;
    refresh.disabled = busy;
    close.disabled = false;
  }

  async function run(name, handler, args = [], interrupt = false) {
    if (destroyed || pending.has(name) || (!interrupt && pending.size)) return;
    const jobs = pending;
    const rendered = revision;
    const version = ++actionVersion;
    jobs.add(name);
    setError(null);
    update();
    try { await handler(...args); }
    catch (cause) {
      // A late failure must not replace a newer graph/status or a Disable result.
      if (!destroyed && revision === rendered && version === actionVersion) {
        setError(cause instanceof Error ? cause.message : cause);
      }
    } finally {
      jobs.delete(name);
      if (!destroyed) update();
    }
  }

  function submit(name, handler, node) {
    if (destroyed || node.disabled) return;
    const options = {
      calendar: calendar.value,
      autoOpen: autoOpen.checked,
      definitions: Object.fromEntries(Object.entries(definitions).map(([kind, input]) => [kind, input.value.trim()])),
    };
    if (!options.definitions.weekly || !options.definitions.monthly ||
      options.definitions.weekly.toLowerCase() === options.definitions.monthly.toLowerCase()) {
      setError("Choose distinct, non-empty weekly and monthly definition page names.");
      return;
    }
    const approval = changedCalendar() && approvedCalendar === calendar.value
      ? { confirmCalendarChange: true } : {};
    // Approval belongs to this submission, never a later retry or graph.
    approvedCalendar = null;
    void run(name, handler, [options, state.graphKey, approval]);
  }
  listen(calendar, "change", () => {
    if (destroyed || calendar.disabled) return;
    approvedCalendar = null;
    update();
  });
  listen(confirm, "click", () => {
    if (destroyed || confirm.disabled || confirmation.hidden) return;
    approvedCalendar = calendar.value;
    update();
    calendar.focus();
  });
  listen(cancel, "click", () => {
    if (destroyed || cancel.disabled || confirmation.hidden) return;
    calendar.value = state.calendar;
    approvedCalendar = null;
    update();
    calendar.focus();
  });
  listen(save, "click", () => submit("save", onSave, save));
  listen(enable, "click", () => submit("enable", onEnable, enable));
  listen(includeDaily, "change", update);
  listen(quickSetup, "click", () => {
    if (quickSetup.disabled) return;
    const dailyOptions = { dailyTemplate: includeDaily.checked, replaceExisting: replaceExisting.checked };
    replaceExisting.checked = false;
    submit("quickSetup", (options, key, approval) => onQuickSetup(options, key, approval, dailyOptions), quickSetup);
  });
  listen(installDailyTemplate, "click", () => {
    if (destroyed || installDailyTemplate.disabled) return;
    const options = { replaceExisting: replaceExisting.checked };
    replaceExisting.checked = false;
    void run("installDailyTemplate", onInstallDailyTemplate, [state.graphKey, options]);
  });
  for (const [node, name, handler, args, interrupt] of [
    [disable, "disable", onDisable, () => [state.graphKey], true],
    [current, "current", onShowCurrent], [examples, "examples", onAddExamples, () => [state.graphKey]],
    [applyDailyTemplateToday, "applyDailyTemplateToday", onApplyDailyTemplateToday, () => [state.graphKey]],
    [history, "history", onShowHistory],
    [weekly, "weekly", onOpenDefinition, () => ["weekly"]],
    [monthly, "monthly", onOpenDefinition, () => ["monthly"]],
    [refresh, "refresh", onRefresh], [close, "close", onClose, undefined, true],
  ]) {
    listen(node, "click", () => {
      if (destroyed || node.disabled) return;
      approvedCalendar = null;
      void run(name, handler, args ? args() : [], interrupt);
    });
  }

  function focusable() {
    return [...panel.querySelectorAll("input, select, button")].filter((node) =>
      !node.disabled && !node.hidden && !(confirmation.hidden && confirmation.contains(node)) &&
      !(advanced.hidden && advanced.contains(node)));
  }
  function focus() { if (!destroyed) (focusable()[0] || close).focus(); }
  listen(document, "keydown", (event) => {
    if (destroyed) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close.click();
    } else if (event.key === "Tab") {
      const nodes = focusable();
      const index = nodes.indexOf(document.activeElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === nodes.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? nodes[nodes.length - 1] : nodes[0])?.focus();
      }
    }
  });
  listen(document, "focusin", (event) => {
    if (!destroyed && !panel.contains(event.target)) focus();
  });

  function render(next) {
    if (destroyed) return;
    revision++;
    if (state?.graphKey !== next?.graphKey) { pending = new Set(); includeDaily.checked = true; }
    state = next ? { ...next, definitions: { ...next.definitions } } : null;
    approvedCalendar = null;
    replaceExisting.checked = false;
    feedback.textContent = state?.setupMessage ?? "";
    feedback.hidden = !feedback.textContent;
    graph.textContent = `Graph: ${state?.graphName ?? "No graph selected"}`;
    status.textContent = state?.paused ? "Disabled — paused for this session" :
      state?.enabled ? (state.error ? "Enabled — attention required" : "Enabled") : "Disabled";
    calendar.value = state?.calendar ?? "gregorian";
    definitions.weekly.value = state?.definitions?.weekly ?? "";
    definitions.monthly.value = state?.definitions?.monthly ?? "";
    autoOpen.checked = state?.autoOpen ?? true;
    setError([state?.error, state?.dailyTemplateWarning].filter(Boolean).join("\n"));
    update();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const remove of listeners) remove();
    overlay.remove();
    style.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  document.head.appendChild(style);
  document.body.appendChild(overlay);
  render(null);
  return { render, focus, destroy };
}
