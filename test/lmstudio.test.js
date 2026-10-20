import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLmStudio, listLmStudioModels, NATIVE_HOST, portOf, shareInFlight } from '../src/lib/lmstudio.js';

const config = { model: 'qwen/qwen2.5-coder-14b', baseUrl: 'http://localhost:1234/v1', autoStart: true };

/** The server answers /models after `failures` failed probes. */
function fakeServer(failures = 0) {
  let probes = 0;
  const fetch = async (url) => {
    probes++;
    assert.equal(url, 'http://localhost:1234/v1/models');
    if (probes > failures) return new Response('{"data":[]}', { status: 200 });
    throw new TypeError('Failed to fetch');
  };
  fetch.probes = () => probes;
  return fetch;
}

function fakeHost(reply) {
  const calls = [];
  const send = async (host, message) => {
    calls.push({ host, message });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  send.calls = calls;
  return send;
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const HELPER_MISSING = new Error('Specified native messaging host not found.');

test('does nothing when auto start is off', async () => {
  const fetch = fakeServer();
  const send = fakeHost({ ok: true });
  assert.deepEqual(await ensureLmStudio({ ...config, autoStart: false }, { fetch, sendNativeMessage: send }), { started: false, loaded: false });
  assert.equal(fetch.probes(), 0);
  assert.equal(send.calls.length, 0);
});

test('server already up: only asks the helper to make sure the model is loaded', async () => {
  const progress = [];
  const send = fakeHost({ ok: true, started: false, loaded: true });
  const result = await ensureLmStudio(config, { fetch: fakeServer(), sendNativeMessage: send, onProgress: (t) => progress.push(t), ...fakeClock() });
  assert.deepEqual(result, { started: false, loaded: true });
  assert.deepEqual(send.calls, [{ host: NATIVE_HOST, message: { cmd: 'ensure', model: config.model, port: 1234 } }]);
  assert.deepEqual(progress, ['モデルを読み込んでいます…']);
});

test('server down: starts it through the helper and waits until it answers', async () => {
  const progress = [];
  const fetch = fakeServer(3);
  const send = fakeHost({ ok: true, started: true, loaded: true });
  const result = await ensureLmStudio(config, { fetch, sendNativeMessage: send, onProgress: (t) => progress.push(t), ...fakeClock() });
  assert.deepEqual(result, { started: true, loaded: true });
  assert.equal(send.calls.length, 1);
  assert.equal(fetch.probes(), 4);
  assert.equal(progress[0], 'LM Studio を起動しています…');
});

test('server down and helper not installed: config error with install guidance', async () => {
  await assert.rejects(
    ensureLmStudio(config, { fetch: fakeServer(Infinity), sendNativeMessage: fakeHost(HELPER_MISSING), ...fakeClock() }),
    (e) => e.kind === 'config' && /補助プログラムのインストール/.test(e.message),
  );
});

test('server up and helper not installed: continue and let LM Studio load the model on demand', async () => {
  const result = await ensureLmStudio(config, { fetch: fakeServer(), sendNativeMessage: fakeHost(HELPER_MISSING), ...fakeClock() });
  assert.deepEqual(result, { started: false, loaded: false });
});

test('helper errors become clear messages', async () => {
  const run = (error) => ensureLmStudio(config, { fetch: fakeServer(Infinity), sendNativeMessage: fakeHost({ ok: false, error }), ...fakeClock() });
  await assert.rejects(run({ kind: 'lms_not_found' }), (e) => e.kind === 'config' && /LM Studio が見つかりません/.test(e.message));
  await assert.rejects(run({ kind: 'model_not_found' }), (e) => e.kind === 'config' && e.message.includes(config.model));
  await assert.rejects(run({ kind: 'load_failed', message: 'out of memory' }), (e) => e.kind === 'config' && /out of memory/.test(e.message));
  await assert.rejects(run({ kind: 'timeout', step: 'load' }), (e) => e.kind === 'network' && /時間がかかっています/.test(e.message));
  await assert.rejects(run({ kind: 'start_failed', message: 'port busy' }), (e) => e.kind === 'config' && /port busy/.test(e.message));
});

test('gives up waiting for the server after the deadline', async () => {
  await assert.rejects(
    ensureLmStudio(config, { fetch: fakeServer(Infinity), sendNativeMessage: fakeHost({ ok: true, started: true, loaded: true }), startWaitMs: 5000, ...fakeClock() }),
    (e) => e.kind === 'network' && /時間がかかっています/.test(e.message),
  );
});

test('portOf', () => {
  assert.equal(portOf('http://localhost:1234/v1'), 1234);
  assert.equal(portOf('http://127.0.0.1/v1'), 80);
  assert.equal(portOf('https://lm.example/v1'), 443);
});

test('listLmStudioModels returns the helper list and maps errors', async () => {
  const models = [{ key: 'qwen/qwen2.5-coder-14b', name: 'Qwen2.5 Coder 14B' }];
  assert.deepEqual(await listLmStudioModels({ sendNativeMessage: fakeHost({ ok: true, models }) }), models);
  await assert.rejects(listLmStudioModels({ sendNativeMessage: fakeHost(HELPER_MISSING) }), (e) => e.kind === 'config' && /補助プログラム/.test(e.message));
  await assert.rejects(listLmStudioModels({ sendNativeMessage: fakeHost({ ok: false, error: { kind: 'lms_not_found' } }) }), /LM Studio が見つかりません/);
});

test('concurrent preparations share one helper call', async () => {
  let calls = 0;
  let release;
  const slow = async () => { calls++; await new Promise((r) => { release = r; }); return { started: true, loaded: true }; };
  const shared = shareInFlight(slow, (cfg) => `${cfg.model}|${cfg.baseUrl}`);
  const a = shared(config);
  const b = shared(config);
  release();
  assert.deepEqual(await a, { started: true, loaded: true });
  assert.deepEqual(await b, { started: true, loaded: true });
  assert.equal(calls, 1);
  const c = shared(config);
  release();
  await c;
  assert.equal(calls, 2, 'a new call after the first finished runs again');
});

test('a remote address is never auto-started on this machine', async () => {
  const send = fakeHost({ ok: true, started: true, loaded: true });
  const result = await ensureLmStudio({ ...config, baseUrl: 'http://192.168.1.20:1234/v1' }, { fetch: async () => { throw new TypeError('down'); }, sendNativeMessage: send, ...fakeClock() });
  assert.deepEqual(result, { started: false, loaded: false });
  assert.equal(send.calls.length, 0);
});

test('a server running on another port is reported right away', async () => {
  await assert.rejects(
    ensureLmStudio(config, { fetch: fakeServer(Infinity), sendNativeMessage: fakeHost({ ok: false, error: { kind: 'port_mismatch', running_port: 1235 } }), ...fakeClock() }),
    (e) => e.kind === 'config' && /1235/.test(e.message) && /1234/.test(e.message),
  );
});

test('without the helper, the model list comes from the running server', async () => {
  const fetch = async (url) => {
    assert.equal(url, 'http://10.15.35.233:1234/v1/models');
    return new Response('{"data":[{"id":"google/gemma-3-12b"},{"id":"text-embedding-nomic-embed-text-v1.5"}]}', { status: 200 });
  };
  const models = await listLmStudioModels({ sendNativeMessage: fakeHost(HELPER_MISSING), baseUrl: 'http://10.15.35.233:1234/v1', fetch });
  assert.deepEqual(models, [{ key: 'google/gemma-3-12b', name: 'google/gemma-3-12b' }]);
});

test('without the helper and with the server off, the helper hint is shown', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    listLmStudioModels({ sendNativeMessage: fakeHost(HELPER_MISSING), baseUrl: 'http://localhost:1234/v1', fetch }),
    /補助プログラム/,
  );
});
