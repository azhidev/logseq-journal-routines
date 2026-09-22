import "@logseq/libs";
import { registerProbe } from "./register.js";
import { createActivationRuntime } from "./activation-runtime.js";
import { createJournalInspector } from "./journal-inspector.js";

logseq.ready(() => registerProbe(logseq, {
  activation: createActivationRuntime({ sdk: logseq, document }),
  journal: createJournalInspector({ sdk: logseq }),
})).catch(() => {
  console.error("[journal-routines] Startup failed. Reload the plugin and check host compatibility; graph details are not logged.");
});
