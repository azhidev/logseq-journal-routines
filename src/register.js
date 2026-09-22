import { createProbeRuntime } from "./runtime.js";

export async function registerProbe(sdk, { setup, journal, activation } = {}) {
  const runtime = createProbeRuntime({ sdk });
  let disposed = false;
  function destroy() {
    if (disposed) return;
    disposed = true;
    try { activation?.destroy(); } finally {
      try { journal?.destroy(); } finally {
        try { setup?.destroy(); } finally { runtime.destroy(); }
      }
    }
  }
  sdk.beforeunload(async () => destroy());
  try {
    setup?.start();
    journal?.start();
    sdk.App.registerCommandPalette({
      key: "journal-routines-check-calendar",
      label: "Journal & Routines: Check Calendar dependency (read-only)",
    }, async () => {
      const result = await runtime.refresh({ report: true });
      if (!result) return;
      await sdk.UI.showMsg(result.state === "available"
        ? `Calendar API v1 responded to all probe calls. Today: ${result.today.iso} / ${result.today.persianIso}. This diagnostic is read-only. Journal activation is managed separately in Status and setup.`
        : `Calendar dependency unavailable: ${result.reason}. This diagnostic did not change graph content.`,
      result.state === "available" ? "success" : "warning");
    });
    if (activation) await activation.start();
    if (!disposed) await runtime.start();
    return runtime;
  } catch (error) {
    destroy();
    throw error;
  }
}
