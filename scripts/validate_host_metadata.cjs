#!/usr/bin/env node
// Limited native serializer regression probe for one pinned installed 0.10.15 build.
// Uses actual Bean, persistent maps, DataScript Datoms and Transit from main.js.
// NOT a parser/updateBlock, full database, Desktop or persistence-I/O test.
// Never loads the application entrypoint. Requires only Node built-ins.
// Usage: node scripts/validate_host_metadata.cjs /absolute/path/to/main.js
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const bundle = process.argv[2];
if (!bundle) throw new Error('Usage: node scripts/validate_host_metadata.cjs /path/to/Logseq-0.10.15/main.js');
const source = fs.readFileSync(bundle, 'utf8');
const digest = crypto.createHash('sha256').update(source).digest('hex');
console.log('Bundle SHA256:', digest);
// These section boundaries are specific to the inspected installed 0.10.15 build.
// Refuse unknown builds BEFORE evaluation; never fall back to running the full app.
if (digest !== '6e1363dd5a4f61cc23905c4df65268a132e1c02692651cb01f5d5a561a08dbf5') {
  throw new Error('Unsupported bundle SHA256; dependency sections need a fresh audit');
}
function position(marker) {
  const index = source.indexOf(marker);
  if (index < 0 || source.indexOf(marker, index + 1) !== -1) throw new Error('Ambiguous/missing boundary: ' + marker);
  return index;
}
function section(start, end) {
  const first = position(start), last = position(end);
  if (first >= last) throw new Error('Reversed dependency boundaries');
  return source.slice(first, last);
}
const chunks = [
  source.slice(0, position('var $module$react$$ = $APP.$shadow$js$require$$(0);')),
  section('var $clojure$$ = {},', 'var $daiquiri$util$attrs_cache$$ ='),
  section('var $cljs$tools$reader$impl$utils$ws_rx$$;', 'var $promesa$protocols$IPromise$_map$dyn_23559$$ ='),
  section('var $datascript$lru$$,', 'var $logseq$db$schema$schema$$ ='),
  section('var $com$cognitect$transit$util$objectKeys$$ =', 'var $logseq$graph_parser$config$capacitor_x_protocol_with_prefix$$ ='),
];
const prefix = chunks.join('\n') + '\nglobalThis.__native = { datom: $datascript$db$datom$$, write: $datascript$transit$write_transit_str$$ };\n}).call(this);';
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
// No process, require, DOM, storage, timers, IPC, fetch or host function bridges.
try {
  vm.runInContext(prefix, context, { timeout: 10000, filename: 'isolated-logseq-dependencies.js' });
  console.log('Dependency subset loaded');
  const result = vm.runInContext(`(() => {
    const a = $APP;
    const properties = { 'jr-kind': 'week', 'jr-snapshot-state': 'complete' };
    const bean = a.$cljs_bean$core$__GT_clj$$(properties);
    // Materialize the same keyword keys/string values, changing only the container.
    const native = a.$cljs$core$into$$.$cljs$core$IFn$_invoke$arity$2$(a.$cljs$core$PersistentArrayMap$EMPTY$$, bean);
    if (!(native instanceof a.$cljs$core$PersistentArrayMap$$) ||
        !a.$cljs$core$_EQ_$$.$cljs$core$IFn$_invoke$arity$2$(bean, native)) {
      throw Error('Expected an equal native persistent map, not a different payload');
    }
    function datom(value) {
      return __native.datom(1, a.$cljs$core$keyword$$('block/properties'), value);
    }
    let rejection;
    try { __native.write(datom(bean)); }
    catch (e) { rejection = e.message; }
    if (!rejection || !rejection.includes('Cannot write') || !rejection.includes('Bean')) throw Error('Expected native Transit Bean rejection: ' + rejection);
    const encoded = __native.write(datom(native));
    if (!encoded.includes('datascript/Datom') || !encoded.includes('jr-kind') || !encoded.includes('complete')) throw Error('Missing native serialized metadata');
    return { rejection, encoded };
  })()`, context, { timeout: 5000 });
  console.log('PASS native Bean in DataScript Datom rejected:', result.rejection);
  console.log('PASS native persistent map in DataScript Datom serialized:', result.encoded);
  console.log('LIMITATION: serializer-only; no full database, parser, updateBlock, page mirroring, Desktop or persistence I/O validation.');
} catch (error) {
  console.error('NOT VALIDATED: isolated dependency loading or native serializer assertions failed.');
  console.error(error.stack);
  process.exitCode = 1;
}
