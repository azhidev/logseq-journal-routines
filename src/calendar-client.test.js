import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createCalendarClient } from "./calendar-client.js";

const TARGET = "persian-calendar.models.";
const ISO = "2025-03-21";
const CAPABILITIES = ["describe-date", "describe-today", "from-journal-day"];
const DATE_CALLS = [
  ["describeDate", [ISO]],
  ["describeToday", []],
  ["fromJournalDay", [20250321]],
];
const ALL_CALLS = [["getApiInfo", []], ...DATE_CALLS];

function apiInfo() {
  return { id: "persian-calendar", version: 1, capabilities: [...CAPABILITIES] };
}

// Independent wire fixtures, not a second calendar implementation. No provider
// code (including its Intl conversion) participates in these consumer tests.
const FIXTURES = {
  "2025-03-21": {
    gregorian: { year: 2025, month: 3, day: 21, iso: "2025-03-21", journalDay: 20250321 },
    persian: { year: 1404, month: 1, day: 1, iso: "1404-01-01", label: "جمعه 1 فروردین 1404", weekOfYear: 1 },
    week: { start: "2025-03-15", end: "2025-03-21", key: "weekly-20250315" },
    month: { start: "2025-03-21", end: "2025-04-20", key: "monthly-1404-01", financeKey: "1404-01" },
  },
  "2024-02-29": {
    gregorian: { year: 2024, month: 2, day: 29, iso: "2024-02-29", journalDay: 20240229 },
    persian: { year: 1402, month: 12, day: 10, iso: "1402-12-10", label: "پنجشنبه 10 اسفند 1402", weekOfYear: 50 },
    week: { start: "2024-02-24", end: "2024-03-01", key: "weekly-20240224" },
    month: { start: "2024-02-20", end: "2024-03-19", key: "monthly-1402-12", financeKey: "1402-12" },
  },
  "2025-01-01": {
    gregorian: { year: 2025, month: 1, day: 1, iso: "2025-01-01", journalDay: 20250101 },
    persian: { year: 1403, month: 10, day: 12, iso: "1403-10-12", label: "چهارشنبه 12 دی 1403", weekOfYear: 42 },
    week: { start: "2024-12-28", end: "2025-01-03", key: "weekly-20241228" },
    month: { start: "2024-12-21", end: "2025-01-19", key: "monthly-1403-10", financeKey: "1403-10" },
  },
};

function description(iso = ISO) {
  return structuredClone(FIXTURES[iso]);
}

function provider(overrides = {}) {
  const calls = [];
  const handlers = {
    getApiInfo: apiInfo,
    describeDate: () => description(),
    describeToday: () => description(),
    fromJournalDay: () => ISO,
    ...overrides,
  };
  return {
    calls,
    invoke(target, ...args) {
      calls.push([target, ...args]);
      const method = target.slice(TARGET.length);
      assert.equal(target, `${TARGET}${method}`);
      assert.ok(Object.hasOwn(handlers, method), `Unexpected model: ${target}`);
      return handlers[method](...args);
    },
  };
}

function clientFor(t, overrides = {}, options = {}) {
  const transport = provider(overrides);
  const client = createCalendarClient({ invoke: transport.invoke, ...options });
  t.after(() => client.destroy());
  return { client, ...transport };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setField(value, path, replacement) {
  const parts = path.split(".");
  let parent = value;
  for (const part of parts.slice(0, -1)) parent = parent[part];
  parent[parts.at(-1)] = replacement;
  return value;
}

test("exports exactly the agreed asynchronous interface and is lazy", async (t) => {
  const { client, calls } = clientFor(t);
  assert.deepEqual(Object.keys(client).sort(), [
    "getApiInfo", "describeDate", "describeToday", "fromJournalDay", "invalidate", "destroy",
  ].sort());
  assert.deepEqual(calls, []);
  for (const [method, args] of ALL_CALLS) {
    const result = client[method](...args);
    assert.ok(result instanceof Promise);
    await result;
  }
  assert.ok(client.invalidate() instanceof Promise);
  assert.ok(client.destroy() instanceof Promise);
});

test("uses full SDK model targets, unchanged arguments, and fresh discovery on every date call", async (t) => {
  const { client, calls } = clientFor(t);
  assert.deepEqual(await client.getApiInfo(), apiInfo());
  assert.deepEqual(await client.describeDate(ISO), description());
  assert.deepEqual(await client.describeToday(), description());
  assert.equal(await client.fromJournalDay(20250321), ISO);
  assert.equal(await client.fromJournalDay("20250321"), ISO);
  assert.deepEqual(await client.describeDate(ISO), description());
  assert.deepEqual(calls, [
    [`${TARGET}getApiInfo`],
    [`${TARGET}getApiInfo`], [`${TARGET}describeDate`, ISO],
    [`${TARGET}getApiInfo`], [`${TARGET}describeToday`],
    [`${TARGET}getApiInfo`], [`${TARGET}fromJournalDay`, 20250321],
    [`${TARGET}getApiInfo`], [`${TARGET}fromJournalDay`, "20250321"],
    [`${TARGET}getApiInfo`], [`${TARGET}describeDate`, ISO],
  ]);
});

test("accepts asynchronous transport and additive API capabilities", async (t) => {
  const info = { ...apiInfo(), capabilities: [...CAPABILITIES, "future-capability"] };
  const { client } = clientFor(t, {
    getApiInfo: async () => info,
    describeDate: async () => description(),
    describeToday: async () => description(),
    fromJournalDay: async () => ISO,
  });
  assert.deepEqual(await client.getApiInfo(), info);
  for (const [method, args] of DATE_CALLS) await client[method](...args);
});

for (const invoke of [undefined, null, {}, "invoke", 1]) {
  test(`rejects invalid invoke: ${String(invoke)}`, () => {
    assert.throws(() => createCalendarClient({ invoke }), /invoke must be a function/);
  });
}
for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, "3000", null, 2_147_483_648]) {
  test(`rejects unsafe timeout: ${String(timeoutMs)}`, () => {
    assert.throws(() => createCalendarClient({ invoke() {}, timeoutMs }), /timeoutMs/);
  });
}

const BAD_INFO = [
  ["missing", undefined], ["null", null], ["array", []], ["string", "ready"],
  ["empty object", {}], ["wrong id", { ...apiInfo(), id: "other-calendar" }],
  ["missing id", { version: 1, capabilities: CAPABILITIES }],
  ["wrong version", { ...apiInfo(), version: 2 }],
  ["string version", { ...apiInfo(), version: "1" }],
  ["missing version", { id: "persian-calendar", capabilities: CAPABILITIES }],
  ["missing capabilities", { id: "persian-calendar", version: 1 }],
  ["string capabilities", { ...apiInfo(), capabilities: CAPABILITIES.join(",") }],
  ["object capabilities", { ...apiInfo(), capabilities: { ...CAPABILITIES } }],
  ["null capabilities", { ...apiInfo(), capabilities: null }],
  ["non-string capability", { ...apiInfo(), capabilities: [...CAPABILITIES, 1] }],
  ["blank capability", { ...apiInfo(), capabilities: [...CAPABILITIES, " "] }],
    ["sparse capabilities", { ...apiInfo(), capabilities: [...CAPABILITIES, ,] }],
  ...CAPABILITIES.map((missing) => [
    `missing ${missing}`, { ...apiInfo(), capabilities: CAPABILITIES.filter((item) => item !== missing) },
  ]),
];
for (const [label, info] of BAD_INFO) {
  test(`fails closed for ${label} API info, directly and before every date method`, async (t) => {
    const { client, calls } = clientFor(t, { getApiInfo: () => info });
    for (const [method, args] of ALL_CALLS) {
      await assert.rejects(client[method](...args), /getApiInfo: invalid response: API info/);
    }
    assert.deepEqual(calls, ALL_CALLS.map(() => [`${TARGET}getApiInfo`]));
  });
}

const FAILURES = [
  ["synchronous throw", () => { throw new Error("provider disabled"); }, /provider disabled/],
  ["rejected Error", () => Promise.reject(new Error("transport unavailable")), /transport unavailable/],
  ["rejected string", () => Promise.reject("provider missing"), /provider missing/],
  ["rejected undefined", () => Promise.reject(undefined), /failed: undefined/],
    ["unprintable rejection", () => Promise.reject(Object.create(null)), /unreadable provider error/],
];
for (const [label, fail, message] of FAILURES) {
  test(`handles discovery ${label} without calling a date model`, async (t) => {
    const { client, calls } = clientFor(t, { getApiInfo: fail });
    for (const [method, args] of ALL_CALLS) await assert.rejects(client[method](...args), message);
    assert.ok(calls.every(([target]) => target === `${TARGET}getApiInfo`));
  });
  for (const [method, args] of DATE_CALLS) {
    test(`handles ${method} ${label} after discovery`, async (t) => {
      const { client, calls } = clientFor(t, { [method]: fail });
      await assert.rejects(client[method](...args), message);
      assert.deepEqual(calls, [[`${TARGET}getApiInfo`], [`${TARGET}${method}`, ...args]]);
    });
  }
}

for (const [method, args] of ALL_CALLS) {
  for (const stage of method === "getApiInfo" ? ["getApiInfo"] : ["getApiInfo", method]) {
    test(`${method} times out at ${stage}, suppresses late success, and can recover`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const waiting = deferred();
      let stalled = true;
      const fallback = stage === "getApiInfo" ? apiInfo : stage === "fromJournalDay" ? () => ISO : description;
      const { client, calls } = clientFor(t, { [stage]: () => stalled ? waiting.promise : fallback() }, { timeoutMs: 25 });
      const result = client[method](...args);
      const rejected = assert.rejects(result, new RegExp(`${stage} timed out after 25ms`));
      await nextTurn();
      t.mock.timers.tick(25);
      await rejected;
      const count = calls.length;
      stalled = false;
      waiting.resolve(fallback());
      await nextTurn();
      assert.equal(calls.length, count, "timed-out discovery must not proceed to the date model");
      await client[method](...args);
      assert.equal(t.mock.timers.tick(100), undefined);
    });
  }
}

test("default timeout is 3000ms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client } = clientFor(t, { getApiInfo: () => new Promise(() => {}) });
  let settled = false;
  const result = client.getApiInfo();
  const rejected = assert.rejects(result, /timed out after 3000ms/).then(() => { settled = true; });
  await nextTurn();
  t.mock.timers.tick(2999);
  await nextTurn();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
});

test("date invocation gets a fresh timeout after discovery completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const info = deferred();
  const date = deferred();
  const { client } = clientFor(t, { getApiInfo: () => info.promise, describeDate: () => date.promise }, { timeoutMs: 20 });
  const result = client.describeDate(ISO);
  await nextTurn();
  t.mock.timers.tick(19);
  info.resolve(apiInfo());
  await nextTurn();
  t.mock.timers.tick(19);
  date.resolve(description());
  assert.deepEqual(await result, description());
  t.mock.timers.tick(100);
});

const BAD_ISOS = [
  undefined, null, 20250321, new Date("2025-03-21T00:00:00Z"), {}, [],
  "", "2025-3-21", "2025-03-1", "20250321", "2025-03-21T00:00:00Z",
  " 2025-03-21", "2025-03-21 ", "2025-03-21\n", "۲۰۲۵-۰۳-۲۱", "+2025-03-21",
  "0000-01-01", "0099-01-01", "1621-12-31", "9999-01-01", "10000-01-01",
  "2025-00-21", "2025-13-21", "2025-01-00", "2025-01-32", "2025-04-31",
  "2025-02-29", "1900-02-29", "2100-02-29",
];
for (const [index, iso] of BAD_ISOS.entries()) {
  test(`rejects strict date input #${index}: ${String(iso)}`, async (t) => {
    const { client, calls } = clientFor(t);
    await assert.rejects(client.describeDate(iso), /Calendar describeDate: date input/);
    assert.deepEqual(calls, []);
  });
}

const BAD_DAYS = [
  undefined, null, true, {}, [], new Date(), 20250321n, NaN, Infinity, 20250321.5,
  "2025-03-21", "2025032", "020250321", " 20250321", "20250321 ", "20250321\n", "۲۰۲۵۰۳۲۱",
  20250229, "19000229", "21000229", 20251301, 20250001, 20250100, 20250431, 16211231, 99990101,
];
for (const [index, day] of BAD_DAYS.entries()) {
  test(`rejects strict journal input #${index}: ${String(day)}`, async (t) => {
    const { client, calls } = clientFor(t);
    await assert.rejects(client.fromJournalDay(day), /Calendar fromJournalDay: journal day/);
    assert.deepEqual(calls, []);
  });
}

for (const value of [undefined, null, {}, description(), 20250321, "20250321", "2025-3-21", "2025-02-29", "2025-03-22", "2025-03-21T00:00:00Z"]) {
  test(`rejects malformed or mismatched journal result: ${JSON.stringify(value)}`, async (t) => {
    const { client } = clientFor(t, { fromJournalDay: () => value });
    await assert.rejects(client.fromJournalDay(20250321), /fromJournalDay: invalid response: journal result/);
  });
}

const BAD_FIELDS = [
  ["gregorian.iso", "2025-02-29"], ["gregorian.iso", "1621-12-31"],
  ["gregorian.iso", "2025-03-21T00:00:00Z"], ["gregorian.iso", 20250321],
  ["gregorian.year", "2025"], ["gregorian.year", 2024], ["gregorian.month", 4],
  ["gregorian.day", 20], ["gregorian.journalDay", "20250321"], ["gregorian.journalDay", 20250322],
  ["persian.year", 999], ["persian.year", 10000], ["persian.year", "1404"],
  ["persian.month", 0], ["persian.month", 13], ["persian.month", 1.5],
  ["persian.day", 0], ["persian.day", 32], ["persian.day", NaN],
  ["persian.iso", "1404-1-01"], ["persian.iso", "1404-01-02"], ["persian.iso", ISO],
  ["persian.label", ""], ["persian.label", " \n "], ["persian.label", 123],
  ["persian.weekOfYear", 0], ["persian.weekOfYear", 55], ["persian.weekOfYear", 1.5],
  ["persian.weekOfYear", "1"], ["persian.weekOfYear", Infinity],
  ["week.start", "2025-02-30"], ["week.start", "2025-03-16"],
  ["week.end", "2025-03-20"], ["week.end", "2025-03-28"],
  ["week.key", "weekly-20250316"], ["week.key", 20250315],
  ["month.start", "2025-02-30"], ["month.start", "2025-03-22"],
  ["month.end", "2025-04-21"], ["month.end", "2025-04-17"],
  ["month.end", "2025-03-20"], ["month.end", "2025-4-20"],
  ["month.key", "monthly-1404-02"], ["month.financeKey", "1404-02"],
  ["month.financeKey", 140401],
];
for (const [field, replacement] of BAD_FIELDS) {
  test(`both describe methods reject invalid ${field}: ${String(replacement)}`, async (t) => {
    const bad = setField(description(), field, replacement);
    const { client } = clientFor(t, { describeDate: () => bad, describeToday: () => bad });
    await assert.rejects(client.describeDate(ISO), /describeDate: invalid response/);
    await assert.rejects(client.describeToday(), /describeToday: invalid response/);
  });
}

const REQUIRED_FIELDS = [
  "gregorian", "persian", "week", "month",
  ...Object.entries(description()).flatMap(([group, fields]) => Object.keys(fields).map((field) => `${group}.${field}`)),
];
for (const field of REQUIRED_FIELDS) {
  test(`both describe methods require ${field}`, async (t) => {
    const bad = description();
    const parts = field.split(".");
    if (parts.length === 1) delete bad[field];
    else delete bad[parts[0]][parts[1]];
    const { client } = clientFor(t, { describeDate: () => bad, describeToday: () => bad });
    await assert.rejects(client.describeDate(ISO), /invalid response/);
    await assert.rejects(client.describeToday(), /invalid response/);
  });
}

for (const bad of [undefined, null, [], "date", 123, new Date()]) {
  test(`both describe methods reject non-record response: ${String(bad)}`, async (t) => {
    const { client } = clientFor(t, { describeDate: () => bad, describeToday: () => bad });
    await assert.rejects(client.describeDate(ISO), /date response must be a plain object/);
    await assert.rejects(client.describeToday(), /date response must be a plain object/);
  });
}
for (const field of ["gregorian", "persian", "week", "month"]) {
  test(`rejects non-record ${field} values`, async (t) => {
    for (const bad of [null, [], "value", 123, new Date()]) {
      const { client } = clientFor(t, { describeToday: () => setField(description(), field, bad) });
      await assert.rejects(client.describeToday(), new RegExp(`${field} must be a plain object`));
    }
  });
}

test("describeDate rejects an otherwise valid response for another day", async (t) => {
  const { client } = clientFor(t, { describeDate: () => description("2025-01-01") });
  await assert.rejects(client.describeDate(ISO), /gregorian.iso must match the requested date/);
});

test("rejects internally valid week bounds that do not contain the described date", async (t) => {
  const bad = description();
  bad.week = { start: "2025-03-22", end: "2025-03-28", key: "weekly-20250322" };
  const { client } = clientFor(t, { describeToday: () => bad });
  await assert.rejects(client.describeToday(), /week bounds must contain gregorian.iso/);
});

test("rejects internally valid month bounds that do not contain the described date", async (t) => {
  const bad = description();
  bad.month.start = "2025-02-18";
  bad.month.end = "2025-03-20";
  const { client } = clientFor(t, { describeToday: () => bad });
  await assert.rejects(client.describeToday(), /month bounds must contain gregorian.iso/);
});

test("rejects inconsistent Persian day even when its ISO components agree", async (t) => {
  const bad = description();
  bad.persian.day = 2;
  bad.persian.iso = "1404-01-02";
  const { client } = clientFor(t, { describeToday: () => bad });
  await assert.rejects(client.describeToday(), /persian.day must match the offset/);
});

test("consumer can load before provider and recover without recreation", async (t) => {
  let loaded = false;
  const { client, calls } = clientFor(t, { getApiInfo: () => loaded ? apiInfo() : undefined });
  for (const [method, args] of DATE_CALLS) await assert.rejects(client[method](...args), /API info/);
  loaded = true;
  for (const [method, args] of DATE_CALLS) await client[method](...args);
  assert.equal(calls.filter(([target]) => target === `${TARGET}getApiInfo`).length, 6);
});

test("repeated disable/reload and version changes never reuse a successful compatibility check", async (t) => {
  let state = "loaded";
  const { client, calls } = clientFor(t, {
    getApiInfo: () => {
      if (state === "disabled") throw new Error("provider disabled");
      return { ...apiInfo(), version: state === "incompatible" ? 2 : 1 };
    },
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const next of ["loaded", "disabled", "incompatible", "loaded"]) {
      state = next;
      for (const [method, args] of DATE_CALLS) {
        if (state === "loaded") await client[method](...args);
        else await assert.rejects(client[method](...args), /disabled|version must be 1/);
      }
    }
  }
  assert.equal(calls.filter(([target]) => target === `${TARGET}getApiInfo`).length, 36);
  assert.equal(calls.filter(([target]) => target !== `${TARGET}getApiInfo`).length, 18);
});

test("provider loss between discovery and date invocation fails closed, then recovers", async (t) => {
  let disabled = true;
  const { client } = clientFor(t, { describeDate: () => {
    if (disabled) throw new Error("provider disappeared after discovery");
    return description();
  } });
  await assert.rejects(client.describeDate(ISO), /disappeared after discovery/);
  disabled = false;
  assert.deepEqual(await client.describeDate(ISO), description());
});

for (const lifecycle of ["invalidate", "destroy"]) {
  for (const [method, args] of ALL_CALLS) {
    for (const stage of method === "getApiInfo" ? ["getApiInfo"] : ["getApiInfo", method]) {
      test(`${lifecycle} promptly rejects ${method} pending at ${stage} and ignores late success`, { timeout: 1000 }, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const waiting = deferred();
        let stalled = true;
        const fallback = stage === "getApiInfo" ? apiInfo : stage === "fromJournalDay" ? () => ISO : description;
        const { client, calls } = clientFor(t, { [stage]: () => stalled ? waiting.promise : fallback() });
        const result = client[method](...args);
        const rejected = assert.rejects(result, lifecycle === "invalidate" ? /invalidated/ : /disposed/);
        await nextTurn();
        const count = calls.length;
        await client[lifecycle]();
        await rejected; // No clock advance: lifecycle cancellation cannot wait for timeout.
        stalled = false;
        waiting.resolve(fallback());
        await nextTurn();
        assert.equal(calls.length, count);
        t.mock.timers.tick(10_000);
        if (lifecycle === "invalidate") await client[method](...args);
        else await assert.rejects(client[method](...args), /disposed/);
      });
    }
  }
}

for (const lifecycle of ["invalidate", "destroy"]) {
  test(`${lifecycle} before dispatch prevents any SDK invocation`, async (t) => {
    const { client, calls } = clientFor(t);
    const results = ALL_CALLS.map(([method, args]) => client[method](...args));
    const rejected = Promise.all(results.map((result) => assert.rejects(result, /invalidated|disposed/)));
    await client[lifecycle]();
    await rejected;
    assert.deepEqual(calls, []);
  });

  test(`${lifecycle} cancels concurrent work and safely consumes late rejections`, { timeout: 1000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const waiting = Array.from({ length: 4 }, deferred);
    let index = 0;
    const { client } = clientFor(t, { getApiInfo: () => waiting[index++].promise });
    const results = ALL_CALLS.map(([method, args]) => client[method](...args));
    const rejected = Promise.all(results.map((result) => assert.rejects(result, /invalidated|disposed/)));
    await nextTurn();
    await client[lifecycle]();
    await rejected;
    for (const work of waiting) work.reject(new Error("late SDK rejection"));
    await nextTurn();
    t.mock.timers.tick(10_000);
  });

  test(`${lifecycle} inside invoke suppresses its synchronous success`, async (t) => {
    let client;
    const transport = provider({ getApiInfo: () => {
      void client[lifecycle]();
      return apiInfo();
    } });
    client = createCalendarClient({ invoke: transport.invoke });
    t.after(() => client.destroy());
    await assert.rejects(client.describeDate(ISO), /invalidated|disposed/);
    assert.deepEqual(transport.calls, [[`${TARGET}getApiInfo`]]);
  });
}

test("a new generation can finish before an invalidated old provider responds", async (t) => {
  const old = deferred();
  let calls = 0;
  const { client } = clientFor(t, { describeToday: () => ++calls === 1 ? old.promise : description() });
  const first = client.describeToday();
  const rejected = assert.rejects(first, /invalidated/);
  await nextTurn();
  await client.invalidate();
  assert.deepEqual(await client.describeToday(), description());
  old.resolve(description("2025-01-01"));
  await rejected;
  await nextTurn();
  assert.deepEqual(await client.describeToday(), description());
});

test("destroy is permanent and lifecycle methods are idempotent", async (t) => {
  const { client, calls } = clientFor(t);
  await client.invalidate();
  await client.invalidate();
  await client.getApiInfo();
  await client.destroy();
  await client.destroy();
  await client.invalidate();
  for (const [method, args] of ALL_CALLS) await assert.rejects(client[method](...args), /disposed/);
  assert.deepEqual(calls, [[`${TARGET}getApiInfo`]]);
});

test("concurrent date requests have independent discovery and settle independently", async (t) => {
  const firstInfo = deferred();
  let count = 0;
  const { client, calls } = clientFor(t, { getApiInfo: () => ++count === 1 ? firstInfo.promise : apiInfo() });
  const first = client.describeDate(ISO);
  const second = client.fromJournalDay("20250321");
  assert.equal(await second, ISO);
  assert.equal(calls.filter(([target]) => target === `${TARGET}getApiInfo`).length, 2);
  firstInfo.resolve(apiInfo());
  assert.deepEqual(await first, description());
});

test("one request timing out does not cancel another, and late rejection is handled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = deferred();
  const { client } = clientFor(t, { describeDate: () => slow.promise }, { timeoutMs: 20 });
  const result = client.describeDate(ISO);
  const rejected = assert.rejects(result, /timed out/);
  await nextTurn();
  assert.equal(await client.fromJournalDay(20250321), ISO);
  t.mock.timers.tick(20);
  await rejected;
  slow.reject(new Error("too late"));
  await nextTurn();
  assert.deepEqual(await client.describeToday(), description());
});

test("UTC civil validation survives leap days, year crossings, and local DST boundaries", async (t) => {
  const previous = process.env.TZ;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  for (const timezone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tehran"]) {
    process.env.TZ = timezone;
    const { client } = clientFor(t, { describeDate: (iso) => description(iso) });
    for (const iso of Object.keys(FIXTURES)) {
      assert.deepEqual(await client.describeDate(iso), description(iso), `${timezone}: ${iso}`);
    }
  }
});

test("journal inputs accept Gregorian leap centuries and the provider's inclusive year limits", async (t) => {
  const cases = [
    [16220101, "1622-01-01"], [99981231, "9998-12-31"],
    [20000229, "2000-02-29"], [24000229, "2400-02-29"], [20240229, "2024-02-29"],
  ];
  for (const [day, iso] of cases) {
    const { client } = clientFor(t, { fromJournalDay: () => iso });
    assert.equal(await client.fromJournalDay(day), iso);
    assert.equal(await client.fromJournalDay(String(day)), iso);
  }
});

test("structural response bounds may extend beyond the supported input years", async (t) => {
  // Synthetic, internally consistent envelopes test Gregorian boundary handling,
  // not the correctness of a Persian conversion or its display label.
  const cases = [
    {
      gregorian: { year: 1622, month: 1, day: 1, iso: "1622-01-01", journalDay: 16220101 },
      persian: { year: 1000, month: 10, day: 12, iso: "1000-10-12", label: "structural fixture", weekOfYear: 42 },
      week: { start: "1622-01-01", end: "1622-01-07", key: "weekly-16220101" },
      month: { start: "1621-12-21", end: "1622-01-19", key: "monthly-1000-10", financeKey: "1000-10" },
    },
    {
      gregorian: { year: 9998, month: 12, day: 31, iso: "9998-12-31", journalDay: 99981231 },
      persian: { year: 9377, month: 10, day: 11, iso: "9377-10-11", label: "structural fixture", weekOfYear: 42 },
      week: { start: "9998-12-26", end: "9999-01-01", key: "weekly-99981226" },
      month: { start: "9998-12-21", end: "9999-01-19", key: "monthly-9377-10", financeKey: "9377-10" },
    },
  ];
  for (const value of cases) {
    const { client } = clientFor(t, { describeDate: () => value });
    assert.deepEqual(await client.describeDate(value.gregorian.iso), value);
  }
});

test("describeToday trusts the provider's local date, not the consumer's clock", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-01T00:00:00Z") });
  const { client, calls } = clientFor(t, { describeToday: () => description("2024-02-29") });
  assert.deepEqual(await client.describeToday(), description("2024-02-29"));
  assert.deepEqual(calls, [[`${TARGET}getApiInfo`], [`${TARGET}describeToday`]]);
});
