import { createCalendarClient } from "./calendar-client.js";
import { inspectSetup } from "./setup-preview.js";
import { mountSetupView } from "./setup-view.js";

export function createSetupController({
  sdk,
  document,
  calendar = createCalendarClient({ invoke: (...args) => sdk.App.invokeExternalPlugin(...args) }),
  inspect = inspectSetup,
  mount = mountSetupView,
}) {
  let view;
  let unsubscribe;
  let request;
  let generation = 0;
  let visible = false;
  let disposed = false;
  let started = false;
  let previousPlanId;

  function cancel() {
    generation += 1;
    request?.abort();
    request = undefined;
    void calendar.invalidate();
  }

  async function refresh() {
    if (disposed || !visible) return;
    cancel();
    const current = generation;
    const controller = new AbortController();
    request = controller;
    view.render({ state: "checking" });
    try {
      const report = await inspect({ sdk, calendar, signal: controller.signal });
      if (disposed || !visible || current !== generation) return;
      let comparison;
      if (report.plan) {
        const nextId = report.plan.id;
        comparison = !nextId ? "unavailable" : previousPlanId === undefined ? "new" :
          !previousPlanId ? "unavailable" : nextId === previousPlanId ? "unchanged" : "changed";
        previousPlanId = nextId;
      } else {
        previousPlanId = undefined;
      }
      view.render({ state: "ready", report, ...(comparison ? { planComparison: comparison } : {}) });
    } catch (error) {
      if (disposed || !visible || current !== generation) return;
      previousPlanId = undefined;
      // The inspector sanitizes SDK errors; never render raw graph block text.
      view.render({ state: "error", error: error.message || "Setup inspection failed. Try refreshing." });
    }
  }

  function close() {
    if (disposed) return;
    visible = false;
    previousPlanId = undefined;
    cancel();
    view?.render({ state: "idle" });
    sdk.hideMainUI({ restoreEditingCursor: true });
  }

  function open() {
    if (disposed) return;
    // Opening starts a new comparison session even if our Close was not called.
    // Only Refresh carries the previous completed fingerprint forward.
    previousPlanId = undefined;
    visible = true;
    sdk.showMainUI({ autoFocus: true });
    view.focus();
    return refresh();
  }

  return {
    start() {
      if (disposed) throw new Error("Setup preview has been disposed.");
      if (started) return;
      started = true;
      view = mount(document, { onRefresh: () => { void refresh(); }, onClose: close });
      sdk.setMainUIInlineStyle({ position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: 1000 });
      sdk.provideModel({ openJournalSetup: open });
      sdk.App.registerUIItem("toolbar", {
        key: "journal-routines-setup",
        template: '<a class="button" data-on-click="openJournalSetup" title="Journal &amp; Routines: Setup preview" aria-label="Journal and Routines setup preview">JR</a>',
      });
      sdk.App.registerCommandPalette({
        key: "journal-routines-setup-preview",
        label: "Journal & Routines: Open setup preview (read-only)",
      }, open);
      unsubscribe = sdk.App.onCurrentGraphChanged(() => {
        previousPlanId = undefined;
        cancel();
        view.render({ state: "idle" });
        if (visible) void refresh();
      });
      // Make the read-only scaffold visible on load; reopening is always a fresh
      // inspection, not an implicit graph activation or stored setup decision.
      void open();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      visible = false;
      previousPlanId = undefined;
      cancel();
      void calendar.destroy();
      unsubscribe?.();
      unsubscribe = undefined;
      sdk.hideMainUI();
      view?.destroy();
      view = undefined;
    },
  };
}
