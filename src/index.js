import "@logseq/libs";
import { registerRoutines } from "./register.js";

logseq.ready(() => registerRoutines(logseq)).catch(() => {
  console.error("[journal-routines] Startup failed. Reload the plugin and check host compatibility; graph details are not logged.");
});
