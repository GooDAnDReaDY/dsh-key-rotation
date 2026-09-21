import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createSandboxService } from '../lib/sandbox-service.js';
import { registerTestRoutes } from '../lib/ops-test.js';

const KEY = 'dummy-key-for-selected-ref';
const BASE = 'https://gateway.example/v1';
const descriptor = (value, ns = 'custom-adapter') => ({ ns, value });
const entry = (settingsNs = 'custom-adapter', settingsPath = []) => ({
  provider: 'sensenova', displayName: 'SenseNova', settingsNs, settingsPath,
});

// These tests exercise the actual service and SandboxRunner, not a copied URL
// resolver. fetch is replaced before the runner captures it; no TCP or real key.
function fixture(t, { directory = [entry()], sections = [descriptor({ apiBase: BASE })], llm = {}, legacy, status = 200 } = {}) {
  const calls = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { status, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) };
  };
  t.after(() => { globalThis.fetch = priorFetch; });
  const state = { directory, sections };
  const runtimeLlm = {
    listProviders: () => [{ id: 'sensenova', name: 'SenseNova' }],
    ...(directory === undefined ? {} : { listConfigurableProviders: () => state.directory }),
    ...llm,
  };
  const settings = { describe: (options) => {
    assert.equal(options.redactSecrets, true, 'only a redacted effective snapshot is needed');
    return state.sections;
  } };
  const ctx = { llm: runtimeLlm, get: (name) => ({ llm: runtimeLlm, settings, 'llm-pi-ai': legacy })[name] };
  const poolByRef = new Map([['KEY_A', { base: 'sensenova' }], ['KEY_B', { base: 'sensenova' }]]);
  const service = createSandboxService({ getRuntime: () => ({ poolByRef }) });
  service.ensureSandboxRunner(ctx);
  return { calls, state, ctx, service, poolByRef, probe: (ref = 'KEY_A') => service.probeRef(ref, KEY) };
}

for (const field of ['baseURL', 'baseUrl', 'apiBase', 'endpoint', 'url']) {
  test(`modern settings resolve ${field} while provider metadata remains display-only`, async (t) => {
    const f = fixture(t, { sections: [descriptor({ [field]: '  ' + BASE + '/  ' })] });
    const result = await f.probe();
    assert.equal(result.ok, true);
    assert.equal(f.calls.length, 1, 'success requires an actual probe');
    assert.equal(f.calls[0].url, BASE + '/models');
    assert.equal(f.calls[0].options.headers.authorization, 'Bearer ' + KEY);
    assert.equal(result.modelsCount, 2);
    assert.equal(f.service.lastTestCache.get('KEY_A').ok, true);
  });
}

test('official pi-ai dictionary: follow settingsNs and exact providers/provider path', async (t) => {
  const f = fixture(t, {
    directory: [entry('llm-pi-ai', ['providers', 'sensenova'])],
    sections: [descriptor({ providers: {
      other: { baseURL: 'https://wrong.example/v1' }, sensenova: { baseURL: BASE },
    } }, 'llm-pi-ai')],
  });
  assert.equal((await f.probe()).ok, true);
  assert.equal(f.calls[0].url, BASE + '/models');
});

test('arbitrary adapter namespace and nested path: no vendor-name special case', async (t) => {
  const f = fixture(t, {
    directory: [entry('gateway-config', ['groups', '0', 'connection'])],
    sections: [descriptor({ groups: [{ connection: { apiBase: BASE } }] }, 'gateway-config')],
  });
  assert.equal((await f.probe()).ok, true);
  assert.equal(f.calls[0].url, BASE + '/models');
});

test('same runner re-reads effective settings after endpoint edits', async (t) => {
  const f = fixture(t);
  await f.probe();
  f.state.sections = [descriptor({ apiBase: 'http://127.0.0.1:1234/v1' })];
  await f.probe('KEY_B');
  assert.deepEqual(f.calls.map((c) => c.url), [BASE + '/models', 'http://127.0.0.1:1234/v1/models']);
});

test('same runner uses a subsequently supplied context, not its first closure', async (t) => {
  const f = fixture(t);
  const newLlm = { listConfigurableProviders: () => [entry('new-section')], listProviders: () => [] };
  f.service.ensureSandboxRunner({ llm: newLlm, get: (name) => name === 'llm' ? newLlm
    : name === 'settings' ? { describe: () => [descriptor({ baseURL: 'https://new.example/v2' }, 'new-section')] } : undefined });
  assert.equal((await f.probe()).ok, true);
  assert.equal(f.calls[0].url, 'https://new.example/v2/models');
});

for (const [name, directory, sections] of [
  ['missing namespace', [entry('absent')], [descriptor({ apiBase: BASE })]],
  ['missing path', [entry('custom-adapter', ['absent'])], [descriptor({ apiBase: BASE })]],
  ['missing path declaration', [{ ...entry(), settingsPath: undefined }], [descriptor({ apiBase: BASE })]],
  ['duplicate directory identity', [entry(), entry('second')], [descriptor({ apiBase: BASE })]],
  ['duplicate namespace', [entry()], [descriptor({ apiBase: BASE }), descriptor({ apiBase: 'https://wrong.example' })]],
  ['prototype traversal', [entry('custom-adapter', ['__proto__'])], [descriptor({ apiBase: BASE })]],
  ['inherited endpoint', [entry()], [descriptor(Object.create({ apiBase: BASE }))]],
  ['endpoint only in unrelated namespace', [entry()], [descriptor({}, 'custom-adapter'), descriptor({ apiBase: BASE }, 'other')]],
  ['endpoint is not a string', [entry()], [descriptor({ apiBase: { toString: () => BASE } })]],
  ['invalid authoritative endpoint', [entry()], [descriptor({ baseURL: 'not a url', apiBase: BASE })]],
]) {
  test(`${name} fails closed without falling back to stale display metadata`, async (t) => {
    const f = fixture(t, { directory, sections, llm: { getProvider: () => ({ id: 'sensenova', baseUrl: 'https://stale.example' }) } });
    const result = await f.probe();
    assert.equal(result.code, 'no-baseurl');
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 0);
  });
}

for (const url of ['file:///tmp/key', 'javascript:alert(1)', '/v1', 'https://name:password@host.example/v1', 'https://host.example/v1?token=secret', 'https://host.example/v1#models']) {
  test(`unsafe/non-composable URL is rejected: ${url.split(':')[0]}/${url.includes('?') ? 'query' : url.includes('#') ? 'fragment' : 'base'}`, async (t) => {
    const f = fixture(t, { sections: [descriptor({ apiBase: url })] });
    assert.equal((await f.probe()).code, 'no-baseurl');
    assert.equal(f.calls.length, 0);
  });
}

test('directory failure cannot silently select another source', async (t) => {
  const f = fixture(t, { llm: {
    listConfigurableProviders: () => { throw new Error('private diagnostic'); },
    getProvider: () => ({ id: 'sensenova', baseUrl: BASE }),
  } });
  assert.equal((await f.probe()).code, 'no-baseurl');
  assert.equal(f.calls.length, 0);
});

test('legacy exact getProvider endpoint still works', async (t) => {
  const f = fixture(t, { directory: [], sections: [], llm: { getProvider: () => ({ id: 'sensenova', baseUrl: BASE }) } });
  assert.equal((await f.probe()).ok, true);
  assert.equal(f.calls[0].url, BASE + '/models');
});

test('legacy exact listProviders endpoint still works', async (t) => {
  const f = fixture(t, { directory: [], sections: [], llm: { listProviders: () => [{ id: 'sensenova', url: BASE }] } });
  assert.equal((await f.probe()).ok, true);
  assert.equal(f.calls[0].url, BASE + '/models');
});

test('display-name collision must not receive the selected key', async (t) => {
  const f = fixture(t, { directory: [], sections: [], llm: {
    getProvider: () => ({ id: 'other', baseUrl: 'https://wrong.example/v1' }),
    listProviders: () => [{ id: 'other', name: 'sensenova', baseUrl: 'https://wrong.example/v1' }],
  } });
  assert.equal((await f.probe()).code, 'no-baseurl');
  assert.equal(f.calls.length, 0);
});

for (const providers of [
  [{ id: 'sensenova', baseUrl: BASE }],
  [{ id: 'legacy-name', aliases: ['sensenova'], endpoint: BASE }],
  { sensenova: { baseURL: BASE } },
]) {
  test('legacy pi-ai service supports exact id/dictionary/explicit alias', async (t) => {
    const f = fixture(t, { directory: [], sections: [], legacy: { config: { providers } } });
    assert.equal((await f.probe()).ok, true);
    assert.equal(f.calls[0].url, BASE + '/models');
  });
}

test('older host without directory reads dictionary settings, not a fictitious service', async (t) => {
  const f = fixture(t, { sections: [descriptor({ providers: { sensenova: { baseURL: BASE } } }, 'llm-pi-ai')],
    llm: { listConfigurableProviders: undefined } });
  assert.equal((await f.probe()).ok, true);
  assert.equal(f.calls[0].url, BASE + '/models');
});

test('unknown provider and absent endpoint stay no-baseurl with zero requests', async (t) => {
  const f = fixture(t, { directory: [], sections: [] });
  assert.equal((await f.probe()).code, 'no-baseurl');
  assert.equal(f.calls.length, 0);
});

test('authenticated probe failure is preserved rather than replaced by presence success', async (t) => {
  const f = fixture(t, { status: 401 });
  const result = await f.probe();
  assert.equal(result.code, 'auth');
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.lastTestCache.get('KEY_A').ok, false);
});

test('actual test route uses the selected credential, keeps presave offline and local fence intact', async (t) => {
  const f = fixture(t);
  const handlers = new Map();
  const credentials = {
    __dshKeyRotationOriginalResolve: async () => ({ value: KEY }),
    resolve: async () => { throw new Error('must bypass rotation for a test'); },
    describe: async () => ({ source: 'fixture' }),
  };
  const ctx = { ...f.ctx, effect: (fn) => fn(), webServer: { register: (route) => handlers.set(route.path, route.handler) },
    get: (name) => name === 'credentials' ? credentials : f.ctx.get(name) };
  registerTestRoutes(ctx, { ...f.service, poolState: new Map() });
  async function request(body, remoteAddress = '127.0.0.1') {
    const req = Readable.from([JSON.stringify(body)]);
    Object.assign(req, { method: 'POST', headers: {}, socket: { remoteAddress } });
    let status, data;
    await handlers.get('/dsh-key-rotation/test')(req, {
      writeHead: (value) => { status = value; }, end: (raw) => { data = JSON.parse(raw); },
    });
    assert.equal(JSON.stringify(data).includes(KEY), false);
    return { status, data };
  }
  const result = await request({ ref: 'KEY_A', probe: 'models' });
  assert.equal(result.data.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer ' + KEY);
  assert.equal((await request({ ref: 'KEY_B', value: 'dummy-presave' })).data.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal((await request({ ref: 'KEY_A', probe: 'models' }, '203.0.113.1')).status, 403);
  assert.equal(f.calls.length, 1);
});
