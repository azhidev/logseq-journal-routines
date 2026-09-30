// Pure civil-period model. UTC arithmetic is only for Gregorian date validation
// and day offsets; "today" is always read from the device's local calendar.
const DAY_MS = 86_400_000;
const PREFIX = "journal-routines";

function isoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function civilDay(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error("Expected a Gregorian civil date in YYYY-MM-DD format.");
  }
  const [year, month, day] = iso.split("-").map(Number);
  if (year < 1 || year > 9999) throw new Error("Civil year must be between 0001 and 9999.");
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error("Invalid Gregorian civil date.");
  }
  return date;
}

function shiftedIso(date, days) {
  const shifted = new Date(date.getTime() + days * DAY_MS);
  return isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Extract a device-local civil day. Do not use toISOString() here. */
export function localCivilDate(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("Expected a valid Date.");
  }
  return isoDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Construct an immutable, calendar-qualified period from inclusive civil bounds. */
export function makePeriod({ calendar, kind, start, end, pageName: requestedName }) {
  if (calendar !== "gregorian" && calendar !== "jalali") throw new Error("Unknown period calendar.");
  if (kind !== "weekly" && kind !== "monthly") throw new Error("Unknown period kind.");
  const first = civilDay(start);
  const last = civilDay(end);
  if (last < first) throw new Error("Period end precedes start.");
  if (kind === "weekly") {
    const weekStart = calendar === "gregorian" ? 1 : 6;
    if (first.getUTCDay() !== weekStart || last.getTime() - first.getTime() !== 6 * DAY_MS) {
      throw new Error("Invalid seven-day week bounds for calendar.");
    }
  } else if (calendar === "gregorian") {
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    const monthEnd = new Date(0);
    monthEnd.setUTCHours(12, 0, 0, 0);
    monthEnd.setUTCFullYear(year, month + 1, 0);
    if (first.getUTCDate() !== 1 || last.getTime() !== monthEnd.getTime()) {
      throw new Error("Gregorian month bounds must cover the entire month.");
    }
  } else {
    // Jalali bounds are supplied by Persian Calendar; no conversion is done here.
    const length = (last.getTime() - first.getTime()) / DAY_MS + 1;
    if (length < 29 || length > 31) throw new Error("Invalid Jalali month length.");
  }
  const id = `${PREFIX}:${calendar}:${kind}:${start}:${end}`;
  const legacyName = `Journal & Routines — ${calendar} ${kind} — ${start} to ${end}`;
  if (requestedName !== undefined && (typeof requestedName !== "string" ||
    requestedName !== requestedName.trim() || requestedName.length > 140 ||
    /[\x00-\x1f\x7f]/.test(requestedName) || requestedName !== legacyName &&
    (!requestedName.endsWith(` — ${start}`) ||
      requestedName.slice(0, -(` — ${start}`).length).trim().length === 0))) {
    throw new Error("Invalid period page title.");
  }
  const pageName = requestedName ?? legacyName;
  return Object.freeze({ calendar, kind, start, end, id, pageName });
}

/** Week and month containing the device-local day; weeks never restart at a month boundary. */
export function gregorianPeriods(date = new Date()) {
  const today = civilDay(localCivilDate(date));
  const weekday = today.getUTCDay();
  const weekStart = shiftedIso(today, -(weekday + 6) % 7);
  const monthStart = isoDate(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  const monthEnd = new Date(0);
  monthEnd.setUTCHours(12, 0, 0, 0);
  monthEnd.setUTCFullYear(today.getUTCFullYear(), today.getUTCMonth() + 1, 0);
  return {
    weekly: makePeriod({ calendar: "gregorian", kind: "weekly", start: weekStart,
      end: shiftedIso(civilDay(weekStart), 6) }),
    monthly: makePeriod({ calendar: "gregorian", kind: "monthly", start: monthStart,
      end: isoDate(monthEnd.getUTCFullYear(), monthEnd.getUTCMonth() + 1, monthEnd.getUTCDate()) }),
  };
}

export function periodIdentity(period) {
  return makePeriod(period).id;
}

export function periodPageName(period) {
  return makePeriod(period).pageName;
}

/** Raw Logseq page property names/values; the ID is an ownership check, not just a title. */
export function periodMetadata(period) {
  const { calendar, kind, start, end, id } = makePeriod(period);
  return {
    "jr-period-id": id,
    "jr-calendar": calendar,
    "jr-kind": kind,
    "jr-start": start,
    "jr-end": end,
  };
}

/** Normalize the SDK's raw/camelCase keys without coercing values or hiding conflicts. */
export function normalizePeriodProperties(properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const keys = ["jr-period-id", "jr-calendar", "jr-kind", "jr-start", "jr-end"];
  const aliases = new Map(keys.flatMap((key) => [[key, key], [key.replaceAll("-", ""), key]]));
  const result = {};
  for (const [name, value] of Object.entries(properties)) {
    const key = aliases.get(name.toLowerCase());
    if (!key) continue;
    if (typeof value !== "string" || (Object.hasOwn(result, key) && result[key] !== value)) return null;
    result[key] = value;
  }
  return result;
}

/** Extra user properties are fine; missing or mismatched ownership is not. */
export function matchesPeriodMetadata(properties, period) {
  const normalized = normalizePeriodProperties(properties);
  return normalized !== null && Object.entries(periodMetadata(period)).every(([key, value]) =>
    Object.hasOwn(normalized, key) && normalized[key] === value);
}
