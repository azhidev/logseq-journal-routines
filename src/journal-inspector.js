import { createJournalAdapter } from "./journal-adapter.js";

const CANCELLATIONS = new Set(["superseded", "disposed", "graph-changed", "graph-edited", "cancelled"]);
const REASONS = new Map([
  ["journal-not-created", "Today's journal has not been created."],
  ["historical-journal", "Historical journals are not changed."],
  ["calendar-unavailable", "Calendar dependency is unavailable. Check the Calendar plugin and try again."],
  ["unsupported-format", "The graph contains an unsupported format."],
  ["invalid-page", "Page metadata could not be verified."],
  ["invalid-block", "Block metadata could not be verified."],
  ["invalid-graph", "The current graph could not be verified."],
  ["conflicting-aliases", "Graph metadata contains conflicting aliases."],
  ["conflicting-properties", "Managed properties conflict and need review."],
  ["duplicate-period-owner", "Multiple period owners need review."],
  ["incomplete-owner-scan", "The period owner scan could not be completed."],
  ["scan-limit", "The graph exceeds the bounded inspection budget; no partial scan was accepted."],
  ["scan-timeout", "The full inspection timed out; no partial scan was accepted."],
  ["read-timeout", "A Logseq read timed out. Try again when the graph is idle."],
  ["read-failed", "A Logseq read failed; missing data was not treated as empty."],
  ["inventory-changed", "The page inventory changed during inspection. Try again when the graph is idle."],
  ["date-changed", "The date changed during inspection. Run a fresh inspection."],
  ["non-journal-period-owner", "A non-journal page claims a requested routine period and needs review."],
  ["future-period-owner", "A future journal claims the requested routine period and needs review."],
  ["owner-outside-period", "A routine owner is on a journal outside its claimed period."],
  ["invalid-period-owner", "A period owner is nested or has an incompatible section identity."],
  ["duplicate-section", "Duplicate journal sections need review."],
  ["conflicting-section", "Conflicting journal section identities need review."],
  ["unmarked-routine-content", "A populated routine section has no loaded marker; existing tasks were not duplicated."],
  ["customized-reference", "Customized task references need review before replacement."],
]);
const STATUSES = new Map([
  ["planned", "Inspection complete"], ["blocked", "Inspection blocked"],
  ["waiting", "Inspection waiting"], ["skipped", "Inspection skipped"],
]);
const OWNERS = new Set(["existing", "new", "none"]);
const FAILURE = "Journal engine inspection could not be completed safely. Review the graph and Calendar dependency, then try again. Read-only inspection; no writes were performed.";

function feedback(result) {
  if (result?.version !== 1 || !STATUSES.has(result.status)) return { message: FAILURE, type: "warning" };
  const summary = result.summary;
  const counts = [summary?.pagesScanned, summary?.journalsScanned, summary?.blocksScanned,
    ...["insert", "update", "move", "remove"].map((kind) => summary?.changes?.[kind])];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
      !OWNERS.has(summary?.owners?.weekly) || !OWNERS.has(summary?.owners?.monthly)) {
    return { message: FAILURE, type: "warning" };
  }
  const reason = REASONS.get(result.reason) || (result.reason === null && result.status === "planned"
    ? "" : "The inspection needs review before it can proceed.");
  const { changes, owners } = summary;
  return {
    message: `${STATUSES.get(result.status)}.${reason ? ` ${reason}` : ""} ` +
      `Scanned: ${summary.pagesScanned} pages, ${summary.journalsScanned} journals, ${summary.blocksScanned} blocks. ` +
      `Proposed changes: ${changes.insert} insert, ${changes.update} update, ${changes.move} move, ${changes.remove} remove. ` +
      `Owners: weekly ${owners.weekly}, monthly ${owners.monthly}. ` +
      "Read-only inspection; no writes were performed.",
    type: result.status === "planned" && result.reason === null ? "success" : "warning",
  };
}

export function createJournalInspector({ sdk, adapter }) {
  let started = false;
  let disposed = false;
  let generation = 0;

  async function inspect() {
    if (disposed) return;
    const current = ++generation;
    let notice;
    try {
      adapter ??= createJournalAdapter({ sdk });
      const result = await adapter.inspect();
      if (disposed || current !== generation ||
          (result?.status === "blocked" && CANCELLATIONS.has(result.reason))) return;
      // Only fixed labels and validated scalar counts cross the command boundary.
      // The adapter's private snapshot/plan must never be logged or returned.
      notice = feedback(result);
    } catch {
      if (disposed || current !== generation) return;
      notice = { message: FAILURE, type: "warning" };
    }
    await sdk.UI.showMsg(notice.message, notice.type);
  }

  return {
    start() {
      if (disposed) throw new Error("Journal inspector has been disposed.");
      if (started) return;
      started = true;
      sdk.App.registerCommandPalette({
        key: "journal-routines-inspect-engine",
        label: "Journal & Routines: Inspect today's journal engine (read-only)",
      }, inspect);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      adapter?.destroy();
    },
  };
}
