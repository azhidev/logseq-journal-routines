import { createProbeRuntime } from "./runtime.js";

export async function registerProbe(sdk, { setup } = {}) {
  const runtime = createProbeRuntime({ sdk });
  function destroy() {
    try { setup?.destroy(); } finally { runtime.destroy(); }
  }
  sdk.beforeunload(async () => destroy());
  try {
    setup?.start();
    sdk.App.registerCommandPalette({
      key: "journal-routines-check-calendar",
      label: "Journal & Routines: Check Calendar dependency (read-only)",
    }, async () => {
      const result = await runtime.refresh({ report: true });
      if (!result) return;
      await sdk.UI.showMsg(result.state === "available"
        ? `Calendar API v1 responded to all probe calls. Today: ${result.today.iso} / ${result.today.persianIso}. Read-only observation; journal writes remain disabled.`
        : `Calendar dependency unavailable: ${result.reason}. No graph content was changed.`,
      result.state === "available" ? "success" : "warning");
    });
    await runtime.start();
    return runtime;
  } catch (error) {
    destroy();
    throw error;
  }
}
