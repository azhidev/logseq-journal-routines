import { createRoutinesRuntime } from "./routines-runtime.js";
import { mountRoutinesView } from "./routines-view.js";

/** Command registration and lazy setup UI; graph/task work belongs to the runtime. */
export async function registerRoutines(sdk, { document = globalThis.document,
  runtime = createRoutinesRuntime({ sdk, document }), mountView = mountRoutinesView } = {}) {
  let disposed = false, view = null, offGraph = null, viewGeneration = 0, actionGeneration = 0;
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
  function render() { if (!disposed) view?.render(runtime.getStatus()); }
  async function update(action) {
    const version = viewGeneration;
    try {
      const result = await action();
      if (version === viewGeneration) render();
      return result;
    } catch (error) {
      if (!disposed && version === viewGeneration) view?.render({ ...runtime.getStatus(), error: error.message });
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
      if (enabling || status.enabled) return runtime.enable(key);
      return status;
    });
  }
  async function disable(key) {
    actionGeneration++;
    return update(() => runtime.disable(key));
  }
  async function navigate(action) {
    const version = viewGeneration;
    await action();
    if (version === viewGeneration) close();
  }
  async function open() {
    if (disposed) return;
    const version = ++viewGeneration;
    const status = await runtime.refreshStatus();
    if (disposed || version !== viewGeneration) return;
    if (!view) {
      view = mountView(document, {
        onSave: (options, key, confirmation) => configure(options, key, confirmation, false),
        onEnable: (options, key, confirmation) => configure(options, key, confirmation, true),
        onDisable: disable,
        onShowCurrent: () => navigate(() => runtime.showCurrent()),
        onAddExamples: (key) => navigate(async () => {
          await runtime.addExamples(key);
          await runtime.showCurrent(key);
        }),
        onShowHistory: () => navigate(() => runtime.showHistory()),
        onOpenDefinition: (kind) => navigate(() => runtime.openDefinition(kind)),
        onRefresh: () => update(() => runtime.refreshStatus()),
        onClose: close,
      });
    }
    view.render(status);
    sdk.setMainUIInlineStyle({ position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: 1000 });
    sdk.showMainUI({ autoFocus: true });
    view.focus();
  }
  async function command(action) {
    if (disposed) return;
    try { return await action(); }
    catch (error) {
      // The runtime reports operational errors. Setup-load failures can precede
      // its reporting context, so still surface those without logging graph data.
      if (!disposed && error.message !== runtime.getStatus().error) {
        await sdk.UI?.showMsg(`Journal & Routines: ${error.message}`, "warning");
      }
    }
  }
  try {
    offGraph = sdk.App.onCurrentGraphChanged(() => { actionGeneration++; close(); });
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
    return { open, close, destroy, runtime };
  } catch (error) { await destroy(); throw error; }
}
