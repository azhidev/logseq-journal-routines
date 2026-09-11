const TARGET = "persian-calendar.models.";
const CAPABILITIES = ["describe-date", "describe-today", "from-journal-day"];
const DAY_MS = 86_400_000;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, field) {
  requireValue(
    value !== null && typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
    `${field} must be a plain object`,
  );
}

function integer(value, min, max, field) {
  requireValue(Number.isInteger(value) && value >= min && value <= max,
    `${field} must be an integer from ${min} through ${max}`);
}

function dateIso(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// UTC is used only to validate Gregorian civil dates and supplied bounds.
// Persian conversion, labels, and week numbering remain the provider's job.
function civilDate(iso, field, minYear = 1622, maxYear = 9998) {
  requireValue(typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso),
    `${field} must be a strict Gregorian YYYY-MM-DD string`);
  const [year, month, day] = iso.split("-").map(Number);
  integer(year, minYear, maxYear, `${field} year`);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(12, 0, 0, 0);
  requireValue(date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day, `${field} is not a valid Gregorian civil date: ${iso}`);
  return { year, month, day, time: date.getTime(), weekday: date.getUTCDay() };
}

function journalIso(day) {
  requireValue((typeof day === "number" && Number.isInteger(day)) || typeof day === "string",
    "journal day must be an integer or an eight-digit YYYYMMDD string");
  const raw = String(day);
  requireValue(/^\d{8}$/.test(raw), "journal day must contain exactly eight ASCII digits (YYYYMMDD)");
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  civilDate(iso, "journal day");
  return iso;
}

function validateInfo(info) {
  record(info, "API info");
  requireValue(info.id === "persian-calendar", 'API info id must be "persian-calendar"');
  requireValue(info.version === 1, "API info version must be 1");
  requireValue(Array.isArray(info.capabilities) &&
    info.capabilities.every((value) => typeof value === "string" && value.trim().length > 0),
  "API info capabilities must be an array of nonempty strings");
  for (const capability of CAPABILITIES) {
    requireValue(info.capabilities.includes(capability), `API info is missing capability "${capability}"`);
  }
  return info;
}

function validateDescription(value, requestedIso) {
  record(value, "date response");
  const { gregorian, persian, week, month } = value;
  record(gregorian, "gregorian");
  record(persian, "persian");
  record(week, "week");
  record(month, "month");

  const date = civilDate(gregorian.iso, "gregorian.iso");
  for (const field of ["year", "month", "day"]) {
    requireValue(gregorian[field] === date[field], `gregorian.${field} must match gregorian.iso`);
  }
  requireValue(gregorian.journalDay === date.year * 10000 + date.month * 100 + date.day,
    "gregorian.journalDay must match gregorian.iso");
  if (requestedIso !== undefined) {
    requireValue(gregorian.iso === requestedIso, "gregorian.iso must match the requested date");
  }

  integer(persian.year, 1000, 9999, "persian.year");
  integer(persian.month, 1, 12, "persian.month");
  integer(persian.day, 1, 31, "persian.day");
  requireValue(persian.iso === dateIso(persian.year, persian.month, persian.day),
    "persian.iso must match its components");
  requireValue(typeof persian.label === "string" && persian.label.trim().length > 0,
    "persian.label must be a nonempty string");
  integer(persian.weekOfYear, 1, 54, "persian.weekOfYear");

  // Inclusive bounds can extend outside the provider's supported input years.
  const weekStart = civilDate(week.start, "week.start", 1, 9999);
  const weekEnd = civilDate(week.end, "week.end", 1, 9999);
  requireValue(weekStart.weekday === 6 && weekEnd.weekday === 5 &&
    weekEnd.time - weekStart.time === 6 * DAY_MS, "week bounds must run Saturday through Friday (seven days)");
  requireValue(weekStart.time <= date.time && date.time <= weekEnd.time,
    "week bounds must contain gregorian.iso");
  requireValue(week.key === `weekly-${week.start.replaceAll("-", "")}`,
    "week.key must match week.start");

  const monthStart = civilDate(month.start, "month.start", 1, 9999);
  const monthEnd = civilDate(month.end, "month.end", 1, 9999);
  const monthDays = (monthEnd.time - monthStart.time) / DAY_MS + 1;
  requireValue(monthDays >= 29 && monthDays <= 31, "month bounds must contain 29 through 31 days");
  requireValue(monthStart.time <= date.time && date.time <= monthEnd.time,
    "month bounds must contain gregorian.iso");
  requireValue((date.time - monthStart.time) / DAY_MS + 1 === persian.day,
    "persian.day must match the offset from month.start");
  const financeKey = persian.iso.slice(0, 7);
  requireValue(month.financeKey === financeKey, "month.financeKey must match the Persian year and month");
  requireValue(month.key === `monthly-${financeKey}`, "month.key must match month.financeKey");
  return value;
}

/**
 * Read-only SDK consumer. Each invocation has its own timeout; availability is
 * never cached. Cancellation rejects local work, not the remote SDK request.
 */
export function createCalendarClient({ invoke, timeoutMs = 3000 }) {
  requireValue(typeof invoke === "function", "Calendar client invoke must be a function");
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647,
    "Calendar client timeoutMs must be a positive integer no greater than 2147483647");
  const pending = new Set();
  let disposed = false;

  async function request(method, args, validate, checkInfo = true) {
    requireValue(!disposed, "Calendar client has been disposed");
    let expectedIso;
    try {
      if (method === "describeDate") {
        civilDate(args[0], "date input");
        expectedIso = args[0];
      } else if (method === "fromJournalDay") {
        expectedIso = journalIso(args[0]);
      }
    } catch (error) {
      throw new Error(`Calendar ${method}: ${error.message}`, { cause: error });
    }

    return new Promise((resolve, reject) => {
      let active = true;
      let timer;
      function finish(error, value) {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        pending.delete(cancel);
        if (error) reject(error);
        else resolve(value);
      }
      function cancel(reason) {
        finish(new Error(`Calendar ${method}: ${reason}`));
      }
      pending.add(cancel);

      function call(name, parameters, accept) {
        if (!active) return;
        const target = `${TARGET}${name}`;
        timer = setTimeout(() => cancel(`${target} timed out after ${timeoutMs}ms`), timeoutMs);
        // Attach both handlers even if invalidated before the transport settles.
        Promise.resolve().then(() => {
          if (active) return invoke(target, ...parameters);
        }).then((value) => {
          if (!active) return;
          clearTimeout(timer);
          try {
            accept(value);
          } catch (error) {
            finish(new Error(`Calendar ${target}: invalid response: ${error.message}`, { cause: error }));
          }
        }, (error) => {
          if (!active) return;
          const detail = error instanceof Error ? error.message : String(error);
          finish(new Error(`Calendar ${target} failed: ${detail}`, { cause: error }));
        });
      }

      const readDate = () => call(method, args, (value) => finish(null, validate(value, expectedIso)));
      if (checkInfo) {
        call("getApiInfo", [], (info) => {
          validateInfo(info);
          readDate();
        });
      } else {
        readDate();
      }
    });
  }

  return {
    async getApiInfo() {
      return request("getApiInfo", [], validateInfo, false);
    },
    async describeDate(iso) {
      return request("describeDate", [iso], validateDescription);
    },
    async describeToday() {
      return request("describeToday", [], validateDescription);
    },
    async fromJournalDay(day) {
      return request("fromJournalDay", [day], (value, expectedIso) => {
        civilDate(value, "journal result");
        requireValue(value === expectedIso, "journal result ISO must match the input journal day");
        return value;
      });
    },
    async invalidate() {
      for (const cancel of pending) cancel("request invalidated");
    },
    async destroy() {
      disposed = true;
      for (const cancel of pending) cancel("client has been disposed");
    },
  };
}
