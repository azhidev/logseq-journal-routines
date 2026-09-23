// Production entrypoint in Chromium. The SDK is mocked; this is NOT Desktop evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

async function fixture(source) {
  const groups = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const clone = (v) => structuredClone(v);
  const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  const status = () => document.querySelector('.jr-activation-status')?.textContent ?? '';
  async function until(fn, label) {
    for (let n = 0; n < 3000; n++) { if (fn()) return; await wait(); }
    throw new Error(`Timed out: ${label}; status=${status()}`);
  }
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  window.addEventListener('error', (e) => errors.push(e.message));
  console.error = (...args) => errors.push(args.join(' '));
  const hooks = { graph: new Set(), db: new Set(), route: new Set() };
  const listen = (key) => (fn) => { hooks[key].add(fn); return () => hooks[key].delete(fn); };
  let next = 1, graph = { name: 'Fixture', path: '/private/disposable-activation-fixture' };
  let startup, unload, model = {}, visible = false, provider = true, configuration = { other: 'keep' };
  let writes = 0, scans = 0, shows = 0;
  const commands = new Map(), panes = new Set(['unrelated-pane']), pages = [];
  const uuid = () => `12345678-1234-4234-8234-${String(next++).padStart(12, '0')}`;
  function properties(content) {
    const result = Object.fromEntries(content.split('\n').flatMap((line) => {
      const m = /^([^\s:]+)::\s*(.*)$/.exec(line);
      return m ? [[m[1], m[2] === 'false' ? false : m[2]]] : [];
    }));
    const heading = /^(#{1,6})\s/.exec(content);
    if (heading) result.heading = heading[1].length;
    return result;
  }
  function block(content, id = uuid()) { return { uuid: id, content, properties: properties(content), children: [] }; }
  function page(name, day, blocks = []) {
    const p = { id: next++, uuid: uuid(), name: name.toLowerCase(), 'journal?': day !== undefined,
      format: 'markdown', properties: {}, blocks, ...(day === undefined ? {} : { journalDay: day }) };
    pages.push(p); return p;
  }
  const userRoots = [block('PRIVATE journal root A'), block('PRIVATE journal root B')];
  userRoots[1].children.push(block('PRIVATE nested journal note'));
  const userRootsBefore = JSON.stringify(userRoots);
  const today = page('Native host journal', 20250321, [block('## Notes'), ...userRoots, block('## Tasks'), block('## Focus')]);
  const privatePage = page('User notes', undefined, [block('PRIVATE NOTE <img src=x onerror="window.injected=true">')]);
  const privateBefore = JSON.stringify(privatePage);
  const meta = (p) => { if (!p) return null; const { blocks, ...rest } = p; return clone(rest); };
  const findPage = (ref) => pages.find((p) => typeof ref === 'string' ? p.name === ref.toLowerCase() || p.uuid === ref.toLowerCase() : p.uuid === ref.uuid) ?? null;
  function entries() {
    const rows = [];
    function visit(list, p) { list.forEach((b, i) => { rows.push({ b, list, i, p }); visit(b.children, p); }); }
    pages.forEach((p) => visit(p.blocks, p)); return rows;
  }
  const locate = (id) => entries().find(({ b }) => b.uuid === id);
  const templates = () => entries().filter(({ b }) => b.properties.template).map(({ b }) => b);
  const changed = () => { for (const fn of hooks.db) fn({}); };
  function mutate(fn) { writes++; const value = fn(); changed(); return clone(value); }
  const info = { id: 'persian-calendar', version: 1, capabilities: ['describe-date', 'describe-today', 'from-journal-day'] };
  const date = {
    gregorian: { year: 2025, month: 3, day: 21, iso: '2025-03-21', journalDay: 20250321 },
    persian: { year: 1404, month: 1, day: 1, iso: '1404-01-01', label: 'جمعه 1 فروردین 1404', weekOfYear: 1 },
    week: { start: '2025-03-15', end: '2025-03-21', key: 'weekly-20250315' },
    month: { start: '2025-03-21', end: '2025-04-20', key: 'monthly-1404-01', financeKey: '1404-01' },
  };
  const sdk = {
    ready(fn) { startup = Promise.resolve().then(fn); return startup; },
    beforeunload(fn) { unload = fn; }, provideModel(value) { Object.assign(model, value); },
    setMainUIInlineStyle() {}, showMainUI() { visible = true; shows++; }, hideMainUI() { visible = false; },
    UI: { showMsg: async () => {} },
    App: {
      getCurrentGraph: async () => clone(graph),
      getUserConfigs: async () => ({ preferredFormat: 'markdown', enabledJournals: true }),
      getCurrentGraphConfigs: async (...keys) => {
        check(keys[0] === 'default-templates', 'unexpected config read');
        return clone(keys.length === 1 ? configuration : configuration.journals ?? null);
      },
      setCurrentGraphConfigs: async (value) => mutate(() => {
        check(Object.keys(value).join() === 'default-templates', 'unrelated config mutation');
        check(value['default-templates'].other === 'keep', 'lost custom template setting');
        configuration = clone(value['default-templates']);
      }),
      getTemplate: async () => clone(templates().find((b) => b.properties.template === 'daily-default') ?? null),
      onCurrentGraphChanged: listen('graph'), onRouteChanged: listen('route'),
      registerUIItem(type) { check(type === 'toolbar', 'unexpected UI item'); },
      registerCommandPalette(item, fn) { commands.set(item.key, fn); },
      invokeExternalPlugin: async (target, arg) => {
        if (!provider) throw new Error('PRIVATE dependency error');
        if (target.endsWith('getApiInfo')) return clone(info);
        if (target.endsWith('describeToday') || target.endsWith('describeDate')) return clone(date);
        if (target.endsWith('fromJournalDay')) { check(arg === 20250321, 'wrong date'); return '2025-03-21'; }
        throw new Error('Unexpected Calendar model');
      },
    },
    DB: {
      onChanged: listen('db'),
      datascriptQuery: async (query) => {
        if (query.includes(':template')) return templates().map((b) => [b.uuid, b.properties.template]);
        if (query.includes(':block/journal-day')) {
          check(query.includes('[?p :block/name]'), 'native journal lookup must exclude dated blocks');
          const day = Number(/:block\/journal-day (\d{8})/.exec(query)[1]);
          return pages.filter((p) => p.journalDay === day).map((p) => [p.uuid]);
        }
        check(query.includes(':routine-loaded'), 'unexpected query');
        return entries().filter(({ b }) => b.properties['routine-loaded']).map(({ b, p }) => [b.uuid, p.name, b.properties['routine-loaded']]);
      },
    },
    Editor: {
      getAllPages: async () => { scans++; return pages.map(meta); },
      getPage: async (ref) => { check(typeof ref === 'string', 'getPage requires a string identity'); return meta(findPage(ref)); },
      getCurrentPage: async () => null,
      getPageBlocksTree: async (ref) => {
        check(typeof ref === 'string', 'Desktop 0.10.15 getPageBlocksTree requires a string identity');
        return clone(findPage(ref)?.blocks ?? null);
      },
      getBlock: async (id) => clone(locate(id)?.b ?? null),
      createPage: async (name, props, opts) => mutate(() => {
        check(opts.journal === false && opts.redirect === false, 'unsafe page creation');
        const p = findPage(name) ?? page(name, undefined, [block(`journal-routines-setup:: ${props['journal-routines-setup']}`)]);
        p.properties = clone(props); return meta(p);
      }),
      insertBlock: async (anchor, content, opts) => mutate(() => {
        check(!locate(opts.customUUID), 'duplicate insert');
        // 0.10.15 insert_block adds the supplied UUID as a persisted id property.
        const b = block(content ? `${content}\nid:: ${opts.customUUID}` : `id:: ${opts.customUUID}`, opts.customUUID);
        const at = locate(anchor), p = findPage(anchor) ?? findPage({ uuid: anchor });
        if (opts.sibling) { check(at, 'missing sibling'); at.list.splice(at.i + (opts.before ? 0 : 1), 0, b); }
        else if (p) p.blocks.push(b);
        else { check(at, 'missing parent'); at.b.children.unshift(b); }
        return b;
      }),
      updateBlock: async (id, content) => mutate(() => {
        const b = locate(id).b;
        check(content.includes(`id:: ${id}`), 'lost persisted block identity');
        b.content = content; b.properties = properties(content);
      }),
      moveBlock: async (id, anchor, opts) => mutate(() => {
        const from = locate(id); from.list.splice(from.i, 1); const at = locate(anchor);
        if (opts.before) at.list.splice(at.i, 0, from.b);
        else if (opts.children) at.b.children.unshift(from.b);
        else at.list.splice(at.i + 1, 0, from.b);
      }),
      removeBlock: async (id) => mutate(() => { const at = locate(id); at.list.splice(at.i, 1); }),
      openInRightSidebar: (id) => { check(locate(id), 'missing sidebar owner'); panes.add(id); },
    },
  };
  window.logseq = sdk;
  async function boot() { (0, eval)(source); await startup; }
  async function open() { await model.openJournalActivation(); }
  function button(text) { return [...document.querySelectorAll('button')].find((b) => b.textContent === text); }
  async function enable() {
    for (const name of ['backupConfirmed', 'legacyAutomationDisabled', 'liveSafetyAcknowledged']) {
      const input = document.querySelector(`input[name="${name}"]`); input.checked = true; input.dispatchEvent(new Event('change'));
    }
    const b = button('Set up & Enable') ?? button('Enable'); check(b && !b.disabled, 'enable not available'); b.click();
    await until(() => /^(Enabled|Paused)/.test(status()), 'enable result');
    check(status().startsWith('Enabled'), status());
  }
  try {
    check(navigator.locks && indexedDB, 'browser lacks required storage/locks');
    await boot(); check(!visible && writes === 0 && shows === 0, 'startup opened preview or wrote graph');
    check(commands.size === 3, 'registered commands');
    await open(); check(status().startsWith('Ready'), status());
    check(button('Set up & Enable').disabled, 'approval bypass');
    check(document.body.textContent.includes('Select daily-default'), 'configuration change not reviewed');
    groups.push('inactive startup, actual activation UI and explicit approval gate');
    await enable();
    check(configuration.journals === 'daily-default' && configuration.other === 'keep', 'configuration not preserved');
    check(templates().length === 1 && findPage('Week Routine') && findPage('Month Routine'), 'missing setup resources');
    check(today.blocks.filter((b) => b.properties['routine-loaded']).length === 2, 'missing period owners');
    check(panes.size === 3 && panes.has('unrelated-pane'), 'sidebar cleared or missing owners');
    check(JSON.stringify(privatePage) === privateBefore && !window.injected, 'private content changed/injected');
    check(JSON.stringify(today.blocks.filter((b) => userRoots.includes(b))) === userRootsBefore, 'interleaved journal notes changed');
    check(!document.querySelector('.jr-activation').textContent.includes('PRIVATE'), 'private content exposed');
    groups.push('approved setup, automatic template selection, host id-property roundtrip, real journal writes, independent panes');
    const count = writes, before = JSON.stringify(pages), scansBefore = scans;
    await open(); check(writes === count && JSON.stringify(pages) === before, 'repeat duplicated data');
    check(scans === scansBefore, 'unchanged refresh rescanned graph');
    groups.push('repeat is a no-op with targeted evidence rather than full graph rescanning');
    await unload(); await wait(30); await boot();
    check(status().startsWith('Enabled') && !visible, 'enabled restart failed or reopened modal');
    check(writes === count, 'restart duplicated data');
    groups.push('real IndexedDB enabled persistence across runtime restart');
    provider = false; await open(); check(status().startsWith('Paused'), 'dependency absence not paused');
    check(writes === count && !status().includes('PRIVATE'), 'unsafe dependency failure');
    provider = true; await open(); check(status().startsWith('Enabled'), 'dependency recovery failed');
    groups.push('dependency pause and fresh recovery without setup approval');
    button('Disable').click(); await until(() => status().startsWith('Disabled'), 'disable'); await wait(50);
    await unload(); await wait(30); await boot();
    check(status().startsWith('Disabled') && writes === count, 'Disable did not persist');
    await open(); graph = { name: 'Fixture', path: '/private/another-graph' };
    for (const fn of hooks.graph) fn({});
    await until(() => status().startsWith('Ready') || status().startsWith('Setup required'), 'graph switch');
    check(writes === count, 'graph switch reused authorization');
    groups.push('persistent Disable and same-name graph isolation');
    await unload(); await wait(30);
    check(hooks.graph.size === 0 && hooks.db.size === 0 && hooks.route.size === 0 && !document.querySelector('.jr-activation'), 'unload leaked lifecycle/UI');
    check(errors.length === 0, errors.join('; '));
    groups.push('shared unload cleanup and no unhandled browser errors');
    document.querySelector('#result').textContent = encodeURIComponent(JSON.stringify({ passed: true, groups }));
  } catch (error) {
    await unload?.();
    document.querySelector('#result').textContent = encodeURIComponent(JSON.stringify({ passed: false, groups, error: error.stack, errors }));
  }
}

async function runBrowser(chrome, file, profile) {
  const child = spawn(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket, timer;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 10000);
      child.once('error', reject);
      child.stderr.on('data', (bytes) => {
        output = (output + bytes).slice(-20000);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const requests = new Map(); let id = 0;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data), request = requests.get(message.id);
      if (request) { requests.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const requestId = ++id; requests.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    return await Promise.race([(async () => {
      const { targetId } = await send('Target.createTarget', { url: pathToFileURL(file).href });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      for (;;) {
        const response = await send('Runtime.evaluate', { expression: 'document.querySelector("#result")?.textContent || ""', returnByValue: true }, sessionId);
        if (response.result?.value) return response.result.value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Activation browser timed out after 60 seconds')), 60000); })]);
  } finally {
    clearTimeout(timer); socket?.close(); child.kill('SIGKILL');
    await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
  }
}

async function main() {
  const chrome = process.argv[2];
  assert.ok(chrome, 'Usage: node scripts/validate_activation.cjs /path/to/chrome');
  const build = await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/index.js')], bundle: true,
    platform: 'browser', format: 'iife', write: false, plugins: [{ name: 'mock-sdk', setup(b) {
      b.onResolve({ filter: /^@logseq\/libs$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: '// SDK supplied by fixture', loader: 'js' }));
    } }] });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-activation-'));
  try {
    const file = path.join(temp, 'activation.html');
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>(${fixture.toString()})(${JSON.stringify(build.outputFiles[0].text).replaceAll('<', '\\u003c')});</script>`);
    // Real wall time: virtual-time jumps can fire storage timeouts while native
    // IndexedDB/crypto work is still pending, producing false durability failures.
    const encoded = await runBrowser(chrome, file, path.join(temp, 'profile'));
    const result = JSON.parse(decodeURIComponent(encoded));
    result.groups.forEach((group) => console.log(`PASS: ${group}`));
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
    console.log(`PASS: ${result.groups.length} production activation browser groups. Mocked SDK, not live Desktop.`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
