#!/usr/bin/env node
// Isolated native DataScript fixtures for one audited Logseq 0.10.15 bundle.
// No application entrypoint, graph/profile reads, IPC, DOM or persistence I/O.
// Usage: node scripts/validate_daily_queries.cjs /absolute/path/to/main.js
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const PIN = '6e1363dd5a4f61cc23905c4df65268a132e1c02692651cb01f5d5a561a08dbf5';

function loadNative(bundle) {
  const source = fs.readFileSync(bundle, 'utf8');
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  console.log('Bundle SHA256:', digest);
  if (digest !== PIN) throw new Error('Unsupported bundle SHA256; dependency sections need a fresh audit');
  function position(marker) {
    const i = source.indexOf(marker);
    if (i < 0 || source.indexOf(marker, i + 1) !== -1) throw new Error('Ambiguous/missing boundary: ' + marker);
    return i;
  }
  function section(start, end) {
    const first = position(start), last = position(end);
    if (first >= last) throw new Error('Reversed dependency boundaries');
    return source.slice(first, last);
  }
  // Serializer probe boundaries plus audited pure clojure.walk functions needed
  // by DataScript's custom-rule solver. No application/lifecycle code is added.
  const chunks = [
    source.slice(0, position('var $module$react$$ = $APP.$shadow$js$require$$(0);')),
    section('var $clojure$$ = {},', 'var $daiquiri$util$attrs_cache$$ ='),
    section('var $cljs$tools$reader$impl$utils$ws_rx$$;', 'var $promesa$protocols$IPromise$_map$dyn_23559$$ ='),
    section('var $datascript$lru$$,', 'var $logseq$db$schema$schema$$ ='),
    section('var $com$cognitect$transit$util$objectKeys$$ =', 'var $logseq$graph_parser$config$capacitor_x_protocol_with_prefix$$ ='),
    section('$clojure$walk$walk$$ = function(', '$clojure$walk$keywordize_keys$$ = function('),
    section('var $clojure$walk$postwalk$$ = function ', 'var $logseq$graph_parser$util$url_encoded_pattern$$ ='),
  ];
  const suffix = `
    globalThis.__run = function(payload) {
      const a = $APP;
      const read = $cljs$reader$read_string$$;
      const key = name => a.$cljs$core$keyword$$(name);
      const get = (map, name) => a.$cljs$core$get$$.$cljs$core$IFn$_invoke$arity$2$(map, key(name));
      const parsed = read(payload.query);
      const query = get(parsed, 'query');
      const schema = read('{:block/page {:db/valueType :db.type/ref} :block/name {:db/unique :db.unique/identity} :block/uuid {:db/unique :db.unique/identity}}');
      const datoms = payload.datoms.map(([entity, attr, edn]) => {
        const value = read(edn);
        if (attr === 'block/uuid' && !(value instanceof $cljs$core$UUID$$)) {
          throw Error('Fixture page UUID must be a native cljs UUID, not a string');
        }
        return $datascript$db$datom$$(entity, key(attr), value);
      });
      const db = $datascript$db$init_db$$(a.$cljs$core$vec$$(datoms), schema);
      const inputs = get(parsed, 'inputs');
      const rules = get(parsed, 'rules');
      // Match query-react's argument order: resolved :inputs, then :rules.
      // Supply fixture Gregorian YYYYMMDD instead of invoking the wall clock.
      const args = [query, db];
      if (inputs) {
        if (a.$cljs$core$pr_str$$.$cljs$core$IFn$_invoke$arity$variadic$(a.$cljs$core$prim_seq$cljs$0core$0IFn$0_invoke$0arity$02$$([inputs])) !== '[:today]') {
          throw Error('Fixture resolver only supports :inputs [:today]');
        }
        args.push(payload.today);
      }
      if (rules) args.push(rules);
      const result = $datascript$query$q$$.apply(null, args);
      const ids = [];
      for (let rows = a.$cljs$core$seq$$(result); rows; rows = a.$cljs$core$next$$(rows)) {
        const entity = a.$cljs$core$first$$(a.$cljs$core$first$$(rows));
        ids.push(get(entity, 'db/id'));
      }
      return ids.sort((x, y) => x - y);
    };
  }).call(this);`;
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  // Never expose process, require, filesystem, timers, fetch or host callbacks.
  vm.runInContext(chunks.join('\n') + suffix, context, { timeout: 10000, filename: 'isolated-logseq-daily-dependencies.js' });
  return payload => Array.from(vm.runInContext('__run(' + JSON.stringify(payload) + ')', context, {
    timeout: 10000, filename: 'native-daily-query-fixture.js',
  }));
}

function edn(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.entries(value).map(([k, v]) => ':' + k + ' ' + edn(v)).join(' ') + '}';
  }
  throw new Error('Unsupported fixture value');
}
const pageUuid = id => '00000000-0000-4000-8000-' + String(id).padStart(12, '0');
function fixture(calendar = 'gregorian', ranges = {}, definitions = ['Weekly Definition', 'Monthly Definition']) {
  const datoms = [];
  const add = (id, attr, value) => datoms.push([id, attr, edn(value)]);
  const page = (id, name) => {
    add(id, 'block/name', name.toLowerCase());
    datoms.push([id, 'block/uuid', '#uuid ' + JSON.stringify(pageUuid(id))]);
  };
  page(1, 'Journal & Routines — Daily template');
  page(2, definitions[0]);
  page(3, definitions[1]);
  page(4, 'Ordinary tasks');
  add(10, 'block/page', 1);
  add(10, 'block/properties', {
    template: 'Journal & Routines — Daily',
    'jr-daily-calendar': calendar,
    'jr-weekly-definition': 'page-uuid:' + pageUuid(2),
    'jr-monthly-definition': 'page-uuid:' + pageUuid(3),
  });
  function period(id, cal, start, end, overrides = {}) {
    page(id, cal + ' ' + start);
    add(id, 'block/properties', {
      'jr-kind': 'weekly', 'jr-calendar': cal, 'jr-start': start, 'jr-end': end,
      'jr-period-id': 'journal-routines:' + cal + ':weekly:' + start + ':' + end,
      ...overrides,
    });
  }
  const g = ranges.gregorian ?? ['2026-09-28', '2026-10-04'];
  const j = ranges.jalali ?? ['2026-09-26', '2026-10-02'];
  period(20, 'gregorian', ...g);
  period(21, 'jalali', ...j);
  function task(id, owner = 4, marker = 'TODO', attrs = {}) {
    add(id, 'block/page', owner);
    add(id, 'block/content', 'Fixture task ' + id);
    if (marker !== null) add(id, 'block/marker', marker);
    for (const [attr, value] of Object.entries(attrs)) add(id, 'block/' + attr, value);
  }
  return { datoms, add, task, period };
}

async function main() {
  const bundle = process.argv[2];
  if (!bundle) throw new Error('Usage: node scripts/validate_daily_queries.cjs /path/to/Logseq-0.10.15/main.js');
  const run = loadNative(bundle);
  const { dailyTaskQuery } = await import(pathToFileURL(path.join(__dirname, '../src/daily-template.js')).href);
  const queries = Object.fromEntries(['priority', 'pending', 'weekly'].map(kind => {
    const text = dailyTaskQuery(kind);
    assert.ok(text.startsWith('#+BEGIN_QUERY\n') && text.endsWith('\n#+END_QUERY'));
    return [kind, text.slice('#+BEGIN_QUERY\n'.length, -'\n#+END_QUERY'.length)];
  }));
  let passed = 0, failed = 0;
  function check(name, kind, data, today, expected) {
    try {
      const actual = run({ query: queries[kind], datoms: data.datoms, today });
      assert.deepEqual(actual, [...expected].sort((a, b) => a - b));
      assert.equal(new Set(actual).size, actual.length, 'Duplicate native pull rows');
      passed++;
      console.log('PASS', name);
    } catch (error) {
      failed++;
      console.error('FAIL', name + ':', error.stack);
    }
  }
  const basic = fixture();
  basic.task(100, 4, 'TODO', { priority: 'A' });
  basic.task(101, 4, 'WAITING', { priority: 'A' });
  basic.task(102, 4, 'DONE', { priority: 'A' });
  basic.task(103, 4, 'TODO', { priority: 'B' });
  basic.task(104, 2, 'TODO', { priority: 'A', scheduled: 20260928 });
  basic.task(105, 3, 'WAITING', { priority: 'A', deadline: 20260928 });
  basic.task(106, 1, 'TODO', { priority: 'A', scheduled: 20260928 });
  basic.task(107, 4, null, { priority: 'A' });
  basic.task(108, 4, 'CANCELED', { priority: 'A' });
  for (const [i, marker] of ['DOING', 'NOW', 'LATER', 'IN-PROGRESS'].entries()) {
    basic.task(110 + i, 4, marker, { priority: 'A' });
  }
  check('priority A excludes WAITING/DONE/CANCELED/prose/definitions/template', 'priority', basic, 20260928, [100, 110, 111, 112, 113]);
  check('pending selects only WAITING, excluding definitions', 'pending', basic, 20260928, [101]);

  for (const definitions of [['true', 'false'], ['false', '123'], ['123', '456']]) {
    const data = fixture('gregorian', {}, definitions);
    data.task(120, 4, 'TODO', { priority: 'A', scheduled: 20260928 });
    data.task(121, 4, 'WAITING', { priority: 'A', deadline: 20261004 });
    for (const [id, owner, marker] of [
      [122, 2, 'TODO'], [123, 2, 'WAITING'],
      [124, 3, 'TODO'], [125, 3, 'WAITING'],
    ]) {
      data.task(id, owner, marker, { priority: 'A', scheduled: 20260928, deadline: 20261004 });
    }
    const label = 'UUID exclusion for definition names ' + definitions.join('/');
    check(label + ' priority', 'priority', data, 20260930, [120]);
    check(label + ' pending', 'pending', data, 20260930, [121]);
    check(label + ' weekly', 'weekly', data, 20260930, [120, 121]);
  }

  function weekFixture(calendar, start, end, ranges) {
    const data = fixture(calendar, ranges);
    data.task(200, 20, 'TODO');
    data.task(201, 21, 'TODO');
    data.task(202, 4, 'TODO', { scheduled: start });
    data.task(203, 4, 'TODO', { deadline: end });
    data.task(204, 4, 'WAITING', { scheduled: start, deadline: end });
    data.task(205, 4, 'DONE', { scheduled: start });
    data.task(206, 2, 'TODO', { scheduled: start });
    data.task(207, 3, 'WAITING', { deadline: end });
    data.task(208, 1, 'TODO', { scheduled: start });
    data.task(209, calendar === 'gregorian' ? 20 : 21, 'TODO', { scheduled: start, deadline: end });
    data.task(210, 4, 'TODO');
    return data;
  }
  const gregorian = weekFixture('gregorian', 20260928, 20261004);
  gregorian.task(211, 4, 'TODO', { scheduled: 20260927 });
  gregorian.task(212, 4, 'TODO', { deadline: 20261005 });
  const gExpected = [200, 202, 203, 204, 209];
  check('Gregorian Monday inclusive; Sunday-before excluded', 'weekly', gregorian, 20260928, gExpected);
  check('Gregorian Sunday inclusive; Monday-after excluded; month crossing', 'weekly', gregorian, 20261004, gExpected);
  check('Gregorian before current period has no matches', 'weekly', gregorian, 20260927, []);
  check('Gregorian after current period has no matches', 'weekly', gregorian, 20261005, []);

  const jalali = weekFixture('jalali', 20260926, 20261002);
  jalali.task(211, 4, 'TODO', { scheduled: 20260925 });
  jalali.task(212, 4, 'TODO', { deadline: 20261003 });
  const jExpected = [201, 202, 203, 204, 209];
  check('Jalali Saturday inclusive; Friday-before excluded', 'weekly', jalali, 20260926, jExpected);
  check('Jalali Friday inclusive; Saturday-after excluded; month crossing', 'weekly', jalali, 20261002, jExpected);
  check('Jalali before current period has no matches', 'weekly', jalali, 20260925, []);
  check('Jalali after current period has no matches', 'weekly', jalali, 20261003, []);

  for (const [calendar, start, end, today, range] of [
    ['gregorian', 20251229, 20260104, 20260101, ['2025-12-29', '2026-01-04']],
    ['jalali', 20251227, 20260102, 20260101, ['2025-12-27', '2026-01-02']],
    ['jalali', 20250315, 20250321, 20250321, ['2025-03-15', '2025-03-21']],
  ]) {
    const data = weekFixture(calendar, start, end, { [calendar]: range });
    check(calendar + ' year/Nowruz crossing ' + range.join(' to '), 'weekly', data, today,
      [calendar === 'gregorian' ? 200 : 201, 202, 203, 204, 209]);
  }

  // Same query and task data, changing only graph-owned context properties.
  const switched = fixture();
  switched.task(300, 20, 'TODO');
  switched.task(301, 21, 'TODO');
  switched.task(302, 4, 'TODO', { scheduled: 20261004 });
  switched.task(303, 4, 'TODO', { deadline: 20260926 });
  check('calendar context Gregorian before switch', 'weekly', switched, 20260930, [300, 302]);
  const context = switched.datoms.find(row => row[0] === 10 && row[1] === 'block/properties');
  context[2] = context[2].replace('"gregorian"', '"jalali"');
  check('same query follows switched Jalali context', 'weekly', switched, 20260930, [301, 303]);
  context[2] = context[2].replace('"jalali"', '"gregorian"');
  check('same query follows switched-back Gregorian context', 'weekly', switched, 20260930, [300, 302]);

  const invalidOwner = fixture();
  invalidOwner.task(400, 22, 'TODO');
  invalidOwner.period(22, 'gregorian', '2026-09-28', '2026-10-04', { 'jr-period-id': 'unrelated' });
  check('unrelated metadata period excluded', 'weekly', invalidOwner, 20260930, []);

  console.log(`Native daily query fixtures: ${passed} passed, ${failed} failed`);
  console.log('LIMITATION: actual pinned cljs reader/DataScript on synthetic native datoms; no native Markdown parser, query-react clock resolution, rendering, Desktop, graph/profile access or persistence validation.');
  if (failed) process.exitCode = 1;
}
main().catch(error => {
  console.error('NOT VALIDATED:', error.stack);
  process.exitCode = 1;
});
