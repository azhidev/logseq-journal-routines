import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  localCivilDate, gregorianPeriods, isoWeekNumber, makePeriod, periodIdentity,
  periodPageName, periodMetadata, matchesPeriodMetadata,
} from "./period-model.js";

const date = (iso) => new Date(`${iso}T12:00:00`);
const bounds = (period) => [period.start, period.end];

test("local civil day is not the UTC day, including around DST", () => {
  const moduleUrl = new URL("./period-model.js", import.meta.url).href;
  const script = `const { localCivilDate, gregorianPeriods } = await import(process.argv[1]);
    const day = new Date(process.argv[2]);
    console.log(JSON.stringify({ today: localCivilDate(day), week: gregorianPeriods(day).weekly.start }));`;
  for (const [zone, instant, expected] of [
    ["America/Los_Angeles", "2025-03-10T06:30:00Z", { today: "2025-03-09", week: "2025-03-03" }],
    ["Asia/Tokyo", "2025-01-05T16:30:00Z", { today: "2025-01-06", week: "2025-01-06" }],
  ]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, moduleUrl, instant], {
      env: { ...process.env, TZ: zone }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), expected);
  }
  assert.throws(() => localCivilDate(new Date(NaN)), /valid Date/);
  assert.throws(() => localCivilDate("2025-01-01"), /valid Date/);
});

test("Monday weeks are independent of month/year and contain seven civil days", () => {
  for (const [today, expected] of [
    ["2025-01-01", ["2024-12-30", "2025-01-05"]],
    ["2024-12-30", ["2024-12-30", "2025-01-05"]],
    ["2025-01-05", ["2024-12-30", "2025-01-05"]],
    ["2025-01-06", ["2025-01-06", "2025-01-12"]],
    ["2024-02-29", ["2024-02-26", "2024-03-03"]],
    ["2025-03-09", ["2025-03-03", "2025-03-09"]],
    ["2025-03-10", ["2025-03-10", "2025-03-16"]],
  ]) {
    assert.deepEqual(bounds(gregorianPeriods(date(today)).weekly), expected, today);
  }
});

test("Gregorian months are full calendar months, including leap and century rules", () => {
  for (const [today, expected] of [
    ["2024-02-29", ["2024-02-01", "2024-02-29"]],
    ["2025-02-28", ["2025-02-01", "2025-02-28"]],
    ["2000-02-29", ["2000-02-01", "2000-02-29"]],
    ["1900-02-28", ["1900-02-01", "1900-02-28"]],
    ["2024-12-31", ["2024-12-01", "2024-12-31"]],
    ["2025-04-01", ["2025-04-01", "2025-04-30"]],
  ]) {
    assert.deepEqual(bounds(gregorianPeriods(date(today)).monthly), expected, today);
  }
});

test("ISO weeks use Monday and the week containing January 4 across year boundaries", () => {
  for (const [day, expected] of [
    ["2026-07-15", 29], ["2026-10-05", 41],
    ["2020-12-31", 53], ["2021-01-01", 53], ["2021-01-03", 53], ["2021-01-04", 1],
    ["2024-12-29", 52], ["2024-12-30", 1], ["2025-01-01", 1], ["2025-01-05", 1], ["2025-01-06", 2],
  ]) assert.equal(isoWeekNumber(day), expected, day);
  assert.throws(() => isoWeekNumber("2026-02-30"), /Invalid Gregorian civil date/);
});

test("legacy model names, identity and properties are deterministic and calendar/kind/bound-qualified", () => {
  const { weekly, monthly } = gregorianPeriods(date("2025-01-01"));
  assert.equal(weekly.id, "journal-routines:gregorian:weekly:2024-12-30:2025-01-05");
  assert.equal(weekly.pageName, "Journal & Routines — gregorian weekly — 2024-12-30 to 2025-01-05");
  assert.equal(periodIdentity(weekly), weekly.id);
  assert.equal(periodPageName(weekly), weekly.pageName);
  const localized = makePeriod({ ...weekly, pageName: `Week · Dec 30–Jan 5 — ${weekly.start}` });
  assert.equal(periodPageName(localized), localized.pageName);
  assert.equal(localized.id, weekly.id);
  assert.deepEqual(periodMetadata(localized), periodMetadata(weekly));
  assert.equal(matchesPeriodMetadata(periodMetadata(weekly), localized), true);
  assert.deepEqual(periodMetadata(weekly), {
    "jr-period-id": weekly.id,
    "jr-calendar": "gregorian", "jr-kind": "weekly",
    "jr-start": "2024-12-30", "jr-end": "2025-01-05",
  });
  assert.deepEqual(gregorianPeriods(date("2025-01-05")).weekly, weekly);
  assert.notEqual(monthly.id, weekly.id);
  assert.notEqual(monthly.pageName, weekly.pageName);
  assert.ok(Object.isFrozen(weekly));
});

test("Jalali provider civil bounds can use the same identity and metadata without conversion", () => {
  const jalali = makePeriod({ calendar: "jalali", kind: "weekly", start: "2025-03-15", end: "2025-03-21" });
  const gregorian = makePeriod({ calendar: "gregorian", kind: "weekly", start: "2025-03-17", end: "2025-03-23" });
  const month = makePeriod({ calendar: "jalali", kind: "monthly", start: "2025-03-21", end: "2025-04-20" });
  assert.notEqual(jalali.id, gregorian.id);
  assert.notEqual(jalali.pageName, gregorian.pageName);
  assert.deepEqual(bounds(month), ["2025-03-21", "2025-04-20"]);
  assert.equal(periodMetadata(month)["jr-calendar"], "jalali");
  assert.equal(periodIdentity(month), month.id);
  const localized = makePeriod({ ...jalali, pageName: `هفتهٔ ۱ · ۱۴۰۴ — ${jalali.start}` });
  assert.equal(periodPageName(localized), localized.pageName);
  assert.equal(localized.id, jalali.id);
  assert.equal(matchesPeriodMetadata(periodMetadata(jalali), localized), true);
});

test("metadata ownership needs every exact property, not just a matching page title", () => {
  const period = gregorianPeriods(date("2025-01-01")).weekly;
  const metadata = periodMetadata(period);
  assert.equal(matchesPeriodMetadata({ ...metadata, "custom-note": "keep" }, period), true);
  for (const key of Object.keys(metadata)) {
    const missing = { ...metadata };
    delete missing[key];
    assert.equal(matchesPeriodMetadata(missing, period), false, key);
    assert.equal(matchesPeriodMetadata({ ...metadata, [key]: "other" }, period), false, key);
  }
  const camel = Object.fromEntries(Object.entries(metadata).map(([key, value]) =>
    [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  assert.equal(matchesPeriodMetadata(camel, period), true);
  assert.equal(matchesPeriodMetadata({ ...camel, ...metadata }, period), true);
  assert.equal(matchesPeriodMetadata({ ...camel, "jr-start": "2024-12-29" }, period), false);
  assert.equal(matchesPeriodMetadata({ ...camel, jrStart: 20241230 }, period), false);
  assert.equal(matchesPeriodMetadata(null, period), false);
  assert.equal(matchesPeriodMetadata({ ...metadata, "jr-start": "2024-12-29" }, period), false);
  assert.equal(matchesPeriodMetadata(periodMetadata(gregorianPeriods(date("2025-01-06")).weekly), period), false);
});

test("invalid calendar, civil dates and malformed bounds fail closed", () => {
  const base = { calendar: "gregorian", kind: "weekly", start: "2024-12-30", end: "2025-01-05" };
  for (const change of [
    { calendar: "unknown" }, { kind: "daily" },
    { start: "2024-02-30" }, { start: "2025-1-01" }, { start: "0000-01-01" },
    { start: "2024-12-31" }, { end: "2025-01-04" }, { end: "2024-12-29" },
  ]) assert.throws(() => makePeriod({ ...base, ...change }), Error);
  assert.throws(() => makePeriod({ calendar: "gregorian", kind: "monthly", start: "2024-02-01", end: "2024-02-28" }), /month bounds/);
  assert.throws(() => makePeriod({ calendar: "jalali", kind: "monthly", start: "2025-03-21", end: "2025-04-17" }), /month length/);
  for (const pageName of ["", "Tasks", "Tasks — 2024-12-29", " Tasks — 2024-12-30", "Tasks — 2024-12-30\nTODO bad", 12]) {
    assert.throws(() => makePeriod({ ...base, pageName }), /page title/);
  }
});
