export function mountSetupView(document, { onRefresh, onClose }) {
  const style = document.createElement("style");
  style.textContent = `
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    body { margin: 0; }
    .jr-overlay { position: fixed; inset: 0; display: grid; place-items: center;
      padding: 16px; box-sizing: border-box; background: rgb(0 0 0 / 30%); }
    .jr-panel { width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto;
      box-sizing: border-box; padding: 24px; border: 1px solid GrayText;
      border-radius: 12px; background: Canvas; color: CanvasText; }
    .jr-panel h1 { margin: 0; font-size: 1.4rem; }
    .jr-panel h2 { font-size: 1.05rem; margin: 20px 0 8px; }
    .jr-panel p { margin: 8px 0; }
    .jr-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
    .jr-panel button { padding: 6px 12px; border: 1px solid GrayText; border-radius: 6px;
      font: inherit; color: ButtonText; background: ButtonFace; cursor: pointer; }
    .jr-panel button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
    .jr-notice { padding: 12px; border-inline-start: 3px solid GrayText; }
    .jr-checks { list-style: none; padding: 0; }
    .jr-check { padding: 10px 0; border-bottom: 1px solid GrayText; }
    .jr-check strong { display: block; }
    .jr-panel code, .jr-panel dd { overflow-wrap: anywhere; }
    .jr-panel pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px;
      border: 1px solid GrayText; border-radius: 6px; }
    .jr-plan { margin-top: 20px; padding: 12px; border: 1px solid GrayText; border-radius: 6px; }
    .jr-plan h2 { margin-top: 0; }
    .jr-plan ol { padding-inline-start: 24px; }
    .jr-plan li { margin-bottom: 12px; }
    .jr-panel dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 8px; }
    .jr-panel dd { margin: 0; }
    .jr-muted { font-size: .9rem; }
    @media (max-width: 480px) { .jr-panel { padding: 16px; } .jr-panel dl { grid-template-columns: 1fr; } }
  `;
  const overlay = document.createElement("div");
  overlay.className = "jr-overlay";
  const panel = document.createElement("section");
  panel.className = "jr-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "jr-title");
  function element(tag, text, parent = panel) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  }
  element("h1", "Journal & Routines — Setup preview").id = "jr-title";
  element("p", "Read-only · Journal automation is not enabled").className = "jr-notice";
  element("p", "Inspect the current graph before future setup. Nothing here creates or changes pages, templates, routines, or journals.");
  const actions = element("div");
  actions.className = "jr-actions";
  const refresh = element("button", "Refresh preview", actions);
  refresh.type = "button";
  const close = element("button", "Close", actions);
  close.type = "button";
  const status = element("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = element("div");
  overlay.appendChild(panel);
  document.head.appendChild(style);
  document.body.appendChild(overlay);
  refresh.addEventListener("click", onRefresh);
  close.addEventListener("click", onClose);
  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      // The two persistent controls remain usable even during a hung SDK read.
      if (event.shiftKey && document.activeElement === refresh) {
        event.preventDefault();
        close.focus();
      } else if (!event.shiftKey && document.activeElement === close) {
        event.preventDefault();
        refresh.focus();
      }
    }
  }
  overlay.addEventListener("keydown", onKey);
  return {
    focus() { close.focus(); },
    render({ state, report, error, planComparison = "new" }) {
      content.replaceChildren();
      content.setAttribute("aria-busy", String(state === "checking"));
      if (state === "checking") {
        status.textContent = "Checking Calendar and the current graph…";
        return;
      }
      if (state !== "ready") {
        status.textContent = error || "Open or refresh the preview to inspect the current graph.";
        return;
      }
      status.textContent = `Inspection complete for ${report.graph.name}. This snapshot is not setup approval.`;
      element("h2", "Calendar dependency", content);
      const calendar = report.calendar;
      if (calendar.state === "available") {
        element("p", "Calendar API v1 date check succeeded. The full cross-plugin lifecycle gate still needs Desktop verification.", content);
        const today = calendar.today;
        const list = element("dl", undefined, content);
        for (const [name, value] of [
          ["Today (Gregorian)", today.gregorian.iso],
          ["Today (Jalali)", today.persian.iso],
          ["Weekly owner key", today.week.key],
          ["Monthly owner key", today.month.key],
        ]) {
          element("dt", name, list);
          element("dd", value, list).dir = "ltr";
        }
        element("p", "Period keys come directly from Calendar. Existing owners are not searched or modified by this preview.", content).className = "jr-muted";
      } else {
        element("p", `Unavailable: ${calendar.reason}`, content);
        element("p", "Load Persian Calendar & Experience, then refresh. For detailed transport diagnostics, run “Journal & Routines: Check Calendar dependency (read-only)” from the command palette.", content);
      }
      const planArea = element("section", undefined, content);
      planArea.className = "jr-plan";
      planArea.setAttribute("aria-labelledby", "jr-plan-title");
      const plan = report.plan;
      element("h2", "Proposed setup plan · v1", planArea).id = "jr-plan-title";
      if (!plan || plan.version !== 1) {
        element("p", "Plan unavailable. Refresh with the latest plugin build; no changes can be proposed from this report.", planArea);
      } else {
        element("p", plan.status === "blocked"
          ? "Blocked — resolve the review findings before proposing setup."
          : "Draft for review only — not approved or executable.", planArea);
        const comparison = {
          new: "New inspection. Refresh preview to compare the sampled sources again.",
          unchanged: "Same sampled sources and plan as the previous inspection. This is not whole-graph validation or permission to apply.",
          changed: "The sampled sources or plan changed. The previous draft is superseded; review the current draft below.",
          unavailable: "A comparable fingerprint is unavailable. Do not rely on the previous draft; refresh after resolving blockers.",
        };
        element("p", comparison[planComparison] || comparison.unavailable, planArea).dataset.planComparison = planComparison;
        if (plan.id) {
          element("p", "Plan fingerprint (sampled sources, SHA-256):", planArea);
          element("code", plan.id, planArea).dataset.planId = plan.id;
        }
        if (plan.blockers.length) {
          element("h3", "Review blockers", planArea);
          const blockers = element("ul", undefined, planArea);
          for (const blocker of plan.blockers) element("li", blocker, blockers);
        }
        element("h3", `Proposed additions (${plan.changes.length})`, planArea);
        if (!plan.changes.length) element("p", plan.status === "blocked"
          ? "No additions proposed while this plan is blocked."
          : "No additions needed within the inspected scope. Existing content stays unchanged.", planArea);
        const changes = element("ol", undefined, planArea);
        for (const change of plan.changes) {
          const row = element("li", undefined, changes);
          row.dataset.planChange = change.id;
          element("strong", change.title, row);
          element("p", `Target: ${change.target}`, row);
          element("p", change.placement, row);
          element("pre", change.content || "(Empty page — no blocks or sample tasks)", row);
          element("p", change.reason, row).className = "jr-muted";
        }
        element("h3", "What stays unchanged", planArea);
        const preserve = element("ul", undefined, planArea);
        for (const item of plan.preserve) element("li", item, preserve);
        element("h3", "Required before any future apply", planArea);
        const requirements = element("ul", undefined, planArea);
        for (const item of plan.requirements) element("li", item, requirements);
      }
      element("h2", "Existing setup — review before changes", content);
      const checks = element("ul", undefined, content);
      checks.className = "jr-checks";
      for (const check of report.checks) {
        const row = element("li", undefined, checks);
        row.className = "jr-check";
        row.dataset.check = check.id;
        element("strong", `${check.title} — ${check.state}`, row);
        element("span", check.detail, row);
      }
      element("h2", "Safety and inspection limits", content);
      const warnings = element("ul", undefined, content);
      for (const warning of report.warnings) element("li", warning, warnings);
      element("p", "Next: confirm the Calendar lifecycle checks in a disposable graph. A later release will need explicit per-graph approval, a backup, and a reviewed plan before any writes. There is no Apply or Enable action in this build.", content);
    },
    destroy() {
      refresh.removeEventListener("click", onRefresh);
      close.removeEventListener("click", onClose);
      overlay.removeEventListener("keydown", onKey);
      overlay.remove();
      style.remove();
    },
  };
}
