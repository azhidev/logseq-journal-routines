import { createRoutinesRuntime } from "./routines-runtime.js";
import { mountRoutinesView } from "./routines-view.js";

/** Command registration and lazy setup UI; graph/task work belongs to the runtime. */
export async function registerRoutines(sdk, { document = globalThis.document,
  runtime = createRoutinesRuntime({ sdk, document }), mountView = mountRoutinesView } = {}) {
  let disposed = false, view = null, offGraph = null, viewGeneration = 0, actionGeneration = 0, setupFeedback = null;
  function close() {
    viewGeneration++;
    if (!view) return;
    view.destroy();
    view = null;
    sdk.hideMainUI({ restoreEditingCursor: true });
  }
  async function destroy() {
    if (disposed) return;
    disposed = true;
    actionGeneration++;
    offGraph?.();
    close();
    await runtime.destroy();
  }
  sdk.beforeunload(destroy);
  function viewStatus() {
    const status = runtime.getStatus();
    return { ...status, ...(setupFeedback?.graphKey === status.graphKey ? { setupMessage: setupFeedback.message } : {}) };
  }
  function render() { if (!disposed) view?.render(viewStatus()); }
  async function update(action) {
    const version = viewGeneration, generation = actionGeneration;
    try {
      const result = await action();
      if (version === viewGeneration && generation === actionGeneration) render();
      return result;
    } catch (error) {
      if (!disposed && version === viewGeneration && generation === actionGeneration) view?.render({ ...viewStatus(), error: error.message });
      throw error;
    }
  }
  async function configure(options, key, confirmation, enabling) {
    const action = actionGeneration;
    return update(async () => {
      const status = await runtime.configure(options, key, confirmation);
      if (disposed || action !== actionGeneration) throw new Error("Setup action cancelled.");
      // Apply a calendar change immediately for an already-enabled graph. Saving
      // settings on a disabled graph never grants activation or creates pages.
      if (enabling || status.enabled) {
        const result = await runtime.enable(key);
        if (disposed || action !== actionGeneration || runtime.getStatus().graphKey !== key) throw new Error("Setup action cancelled.");
        if (enabling) setupFeedback = { graphKey: key, message: "Your routines are ready. Open them in the sidebar to start checking off tasks. Edit the weekly and monthly definitions to choose routines for future periods." };
        return result;
      }
      return status;
    });
  }
  async function quickSetup(options, key, confirmation, { dailyTemplate = true, replaceExisting = false } = {}) {
    const action = actionGeneration;
    setupFeedback = null;
    function check() {
      if (disposed || action !== actionGeneration || runtime.getStatus().graphKey !== key) throw new Error("Setup action cancelled; graph or activation changed.");
    }
    return update(async () => {
      await runtime.configure(options, key, confirmation); check();
      await runtime.enable(key); check();
      setupFeedback = { graphKey: key, message: "Your routines are ready. Open them in the sidebar to start checking off tasks. Edit the weekly and monthly definitions to choose routines for future periods." };
      if (!dailyTemplate) {
        setupFeedback = { graphKey: key, message: "Routines are ready. The daily journal default was left unchanged." };
        return runtime.getStatus();
      }
      await runtime.installDailyTemplate(key, { replaceExisting }); check();
      try {
        const result = await runtime.applyDailyTemplateToday(key, { skipUnavailable: true }); check();
        setupFeedback = { graphKey: key, message: result?.applied === false
          ? `Routines and the daily template are ready. Today was left unchanged: ${result.reason}`
          : "All set — routines and the daily template are ready, including today’s journal." };
      } catch (error) {
        check();
        throw new Error(`Routines and the daily template are installed. Today’s application needs attention: ${error.message}`);
      }
      return runtime.getStatus();
    });
  }
  async function disable(key) {
    actionGeneration++;
    setupFeedback = null;
    return update(() => runtime.disable(key));
  }
  async function navigate(action) {
    const version = viewGeneration, generation = actionGeneration;
    await action();
    if (!disposed && version === viewGeneration && generation === actionGeneration) close();
  }
  async function skip(key) {
    const version = viewGeneration, generation = actionGeneration;
    await update(() => runtime.skipOnboarding(key));
    if (!disposed && version === viewGeneration && generation === actionGeneration) close();
  }
  async function offerWelcome() {
    if (disposed) return;
    const known = runtime.getStatus();
    if (known.graphKey && (known.onboarding !== "pending" || known.initialization)) return;
    const version = viewGeneration, generation = actionGeneration;
    const status = await runtime.refreshStatus();
    if (!disposed && version === viewGeneration && generation === actionGeneration && !view && status.graphKey &&
        status.onboarding === "pending" && !status.initialization && !status.enabled && !status.error) await open();
  }
  async function open() {
    if (disposed) return;
    const version = ++viewGeneration, generation = actionGeneration;
    const status = await runtime.refreshStatus();
    if (disposed || version !== viewGeneration || generation !== actionGeneration) return;
    if (!view) {
      view = mountView(document, {
        onSave: (options, key, confirmation) => configure(options, key, confirmation, false),
        onEnable: (options, key, confirmation) => configure(options, key, confirmation, true),
        onQuickSetup: quickSetup,
        onSkip: skip,
        onDisable: disable,
        onShowCurrent: () => navigate(() => runtime.showCurrent()),
        onAddExamples: (key) => {
          const generation = actionGeneration;
          return navigate(async () => {
            await runtime.addExamples(key);
            if (disposed || generation !== actionGeneration) throw new Error("Setup action cancelled.");
            await runtime.showCurrent(key);
          });
        },
        onInstallDailyTemplate: (key, options) => update(() => runtime.installDailyTemplate(key, options)),
        onApplyDailyTemplateToday: (key) => navigate(() => runtime.applyDailyTemplateToday(key)),
        onShowHistory: () => navigate(() => runtime.showHistory()),
        onOpenDefinition: (kind) => navigate(() => runtime.openDefinition(kind)),
        onRefresh: () => update(() => runtime.refreshStatus()),
        onClose: close,
      });
    }
    view.render({ ...status, ...(setupFeedback?.graphKey === status.graphKey ? { setupMessage: setupFeedback.message } : {}) });
    sdk.setMainUIInlineStyle({ position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: 1000 });
    sdk.showMainUI({ autoFocus: true });
    view.focus();
  }
  async function command(action) {
    if (disposed) return;
    let generation = actionGeneration;
    try {
      const result = action();
      // Disable invalidates older actions synchronously; its own errors are current.
      generation = actionGeneration;
      return await result;
    }
    catch (error) {
      // The runtime reports operational errors. Setup-load failures can precede
      // its reporting context, so still surface those without logging graph data.
      if (!disposed && generation === actionGeneration && error.message !== runtime.getStatus().error) {
        await sdk.UI?.showMsg(`Journal & Routines: ${error.message}`, "warning");
      }
    }
  }
  try {
    offGraph = sdk.App.onCurrentGraphChanged(() => {
          actionGeneration++; setupFeedback = null; close();
          // Let the runtime invalidate its graph generation before requesting status.
          void Promise.resolve().then(() => command(offerWelcome));
        });
    for (const [key, label, action] of [
      ["setup", "Setup and settings", open],
      ["show", "Show current routines", () => navigate(() => runtime.showCurrent())],
      ["history", "Show routine history", () => navigate(() => runtime.showHistory())],
      ["definition-weekly", "Open weekly definition", () => navigate(() => runtime.openDefinition("weekly"))],
      ["definition-monthly", "Open monthly definition", () => navigate(() => runtime.openDefinition("monthly"))],
      ["disable", "Disable for this graph", () => disable()],
    ]) {
      sdk.App.registerCommandPalette({ key: `journal-routines-${key}`, label: `Journal & Routines: ${label}` },
        () => command(action));
    }
    sdk.provideModel({ openJournalRoutinesSetup: () => command(open) });
    sdk.App.registerUIItem("toolbar", {
      key: "journal-routines-open",
      template: `<button type="button" class="button" data-on-click="openJournalRoutinesSetup" title="Journal &amp; Routines" aria-label="Open Journal &amp; Routines">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-14 5 2 2 3-4m2 3h4"/>
        </svg>
      </button>`,
    });
    await runtime.start();
    await command(offerWelcome);
    return { open, close, destroy, runtime };
  } catch (error) { await destroy(); throw error; }
}
