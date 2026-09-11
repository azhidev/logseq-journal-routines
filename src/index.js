import "@logseq/libs";
import { registerProbe } from "./register.js";
import { createSetupController } from "./setup-controller.js";

logseq.ready(() => registerProbe(logseq, {
  setup: createSetupController({ sdk: logseq, document }),
})).catch((error) => {
  console.error("[journal-routines:calendar-probe] Startup failed", error);
});
