import { createCalendarClient } from "./calendar-client.js";

export const PROBE_DATE = "2025-03-21";
export const PROBE_JOURNAL_DAY = 20250321;

/** Diagnostic observations only: no result here authorizes graph writes. */
export function createProbeRuntime({
  sdk,
  client = createCalendarClient({ invoke: (...args) => sdk.App.invokeExternalPlugin(...args) }),
  intervalMs = 30_000,
  onReport = (report) => console.info("[journal-routines:calendar-probe]", report),
}) {
  let generation = 0;
  let disposed = false;
  let started = false;
  let busy = false;
  let timer;
  let unsubscribe;
  let status = { state: "idle", checkedAt: null };
  let lastReportedState;

  function snapshot() {
    return structuredClone(status);
  }

  async function refresh({ report = false } = {}) {
    if (disposed) return null;
    const request = ++generation;
    busy = true;
    // Clear previous success immediately, including on graph change/recheck.
    status = { state: "checking", checkedAt: null };
    await client.invalidate();
    if (disposed || request !== generation) return null;
    let result;
    try {
      const info = await client.getApiInfo();
      const date = await client.describeDate(PROBE_DATE);
      const today = await client.describeToday();
      const journalIso = await client.fromJournalDay(PROBE_JOURNAL_DAY);
      // Recheck after the sequence too; this is still not an atomic lease on
      // provider availability and must never become a write authorization.
      await client.getApiInfo();
      result = {
        state: "available",
        checkedAt: new Date().toISOString(),
        api: { id: info.id, version: info.version },
        sample: { iso: date.gregorian.iso, persianIso: date.persian.iso, journalIso },
        today: { iso: today.gregorian.iso, persianIso: today.persian.iso },
      };
    } catch (error) {
      result = {
        state: "unavailable",
        checkedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (disposed || request !== generation) return null;
    busy = false;
    status = result;
    if (report || lastReportedState !== result.state) {
      lastReportedState = result.state;
      onReport(snapshot());
    }
    return snapshot();
  }

  return {
    refresh,
    getStatus: snapshot,
    async start() {
      if (disposed) throw new Error("Calendar probe has been disposed.");
      if (started) return null;
      started = true;
      unsubscribe = sdk.App.onCurrentGraphChanged(() => { void refresh(); });
      timer = setInterval(() => {
        if (!busy) void refresh();
      }, intervalMs);
      return refresh();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      busy = false;
      clearInterval(timer);
      unsubscribe?.();
      unsubscribe = undefined;
      void client.destroy();
      status = { state: "disposed", checkedAt: null };
    },
  };
}
