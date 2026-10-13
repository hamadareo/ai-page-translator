import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, callProvider } from '../src/lib/providers/index.js';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(responder) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(url, init);
  };
  fetch.calls = calls;
  return fetch;
}

const chat = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

test('openai request shape', () => {
  const { url, init } = PROVIDERS.openai.buildRequest(['Hi'], '日本語', { apiKey: 'sk', model: 'gpt-5.5' });
  const body = JSON.parse(init.body);
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer sk');
  assert.equal(body.model, 'gpt-5.5');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /日本語/);
  assert.deepEqual(JSON.parse(body.messages[1].content), { texts: ['Hi'] });
  assert.equal('temperature' in body, false);
});

test('compat request uses baseUrl, optional key and optional json mode', () => {
  const a = PROVIDERS.compat.buildRequest(['Hi'], '日本語', { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1/', jsonMode: false });
  assert.equal(a.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal('Authorization' in a.init.headers, false);
  assert.equal('response_format' in JSON.parse(a.init.body), false);
  const b = PROVIDERS.compat.buildRequest(['Hi'], '日本語', { apiKey: 'or', model: 'm', baseUrl: 'https://openrouter.ai/api/v1', jsonMode: true });
  assert.equal(b.init.headers.Authorization, 'Bearer or');
  assert.deepEqual(JSON.parse(b.init.body).response_format, { type: 'json_object' });
});

test('chat completions text extraction', () => {
  assert.equal(PROVIDERS.openai.extractText(chat('x')), 'x');
  assert.throws(() => PROVIDERS.openai.extractText({}), { kind: 'bad_response' });
});

test('anthropic request shape for Claude Opus 5.5', () => {
  const { url, init } = PROVIDERS.anthropic.buildRequest(['Hi'], '日本語', { apiKey: 'ak', model: 'claude-opus-5-5' });
  const body = JSON.parse(init.body);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'ak');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(typeof body.max_tokens, 'number');
  assert.match(body.system, /日本語/);
  assert.deepEqual(body.messages, [{ role: 'user', content: '{"texts":["Hi"]}' }]);
  assert.equal('temperature' in body, false);
});

test('anthropic omits fallbacks and effort for models without them', () => {
  const haiku55 = JSON.parse(PROVIDERS.anthropic.buildRequest(['Hi'], 'ja', { apiKey: 'k', model: 'claude-haiku-5-5' }).init.body);
  assert.equal('fallbacks' in haiku55, false);
  assert.deepEqual(haiku55.output_config, { effort: 'low' });
  const { init } = PROVIDERS.anthropic.buildRequest(['Hi'], 'ja', { apiKey: 'k', model: 'claude-haiku-4-5' });
  const haiku45 = JSON.parse(init.body);
  assert.equal('fallbacks' in haiku45, false);
  assert.equal('output_config' in haiku45, false);
  assert.equal('anthropic-beta' in init.headers, false);
});

test('anthropic extraction joins text blocks and rejects refusals and truncation', () => {
  const ok = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"tr' }, { type: 'text', text: 'anslations":[]}' }] };
  assert.equal(PROVIDERS.anthropic.extractText(ok), '{"translations":[]}');
  assert.throws(() => PROVIDERS.anthropic.extractText({ stop_reason: 'refusal', content: [] }), { kind: 'bad_response' });
  assert.throws(() => PROVIDERS.anthropic.extractText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }), { kind: 'bad_response' });
});

test('gemini request shape and extraction', () => {
  const { url, init } = PROVIDERS.gemini.buildRequest(['Hi'], '日本語', { apiKey: 'gk', model: 'gemini-3.8-flash' });
  const body = JSON.parse(init.body);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(init.headers['x-goog-api-key'], 'gk');
  assert.match(body.systemInstruction.parts[0].text, /日本語/);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '{"texts":["Hi"]}' }] }]);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  const resp = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'a', thought: true }, { text: 'b' }, { text: 'c' }] } }] };
  assert.equal(PROVIDERS.gemini.extractText(resp), 'bc');
  assert.throws(() => PROVIDERS.gemini.extractText({ promptFeedback: { blockReason: 'SAFETY' } }), { kind: 'bad_response' });
  assert.throws(() => PROVIDERS.gemini.extractText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }), { kind: 'bad_response' });
});

test('callProvider returns parsed translations', async () => {
  const fetch = fakeFetch(() => json(chat('{"translations":["こんにちは"]}')));
  const out = await callProvider('openai', ['Hello'], '日本語', { apiKey: 'k', model: 'm' }, { fetch });
  assert.deepEqual(out, ['こんにちは']);
  assert.equal(fetch.calls.length, 1);
});

test('callProvider maps HTTP errors, network failures and bad JSON', async () => {
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => json({ error: { message: 'bad' } }, 401)) }),
    { kind: 'auth' },
  );
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => json({}, 429, { 'retry-after': '3' })) }),
    (e) => e.kind === 'rate_limit' && e.retryAfterMs === 3000,
  );
  await assert.rejects(
    callProvider('compat', ['a'], 'ja', { model: 'm', baseUrl: 'http://localhost:11434/v1' }, { fetch: async () => { throw new TypeError('Failed to fetch'); } }),
    (e) => e.kind === 'network' && /起動/.test(e.message),
  );
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => new Response('<html>', { status: 200 })) }),
    { kind: 'bad_response' },
  );
  await assert.rejects(
    callProvider('openai', ['a', 'b'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => json(chat('{"translations":["x"]}'))) }),
    { kind: 'bad_response' },
  );
  await assert.rejects(callProvider('nope', ['a'], 'ja', {}, { fetch: fakeFetch(() => json({})) }), { kind: 'config' });
});

test('callProvider rethrows aborts untouched', async () => {
  const abort = new DOMException('aborted', 'AbortError');
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: async () => { throw abort; } }),
    (e) => e === abort,
  );
});

test('callProvider gives up on a request that never answers', async () => {
  const neverAnswers = (_url, init) => new Promise((_res, rej) => {
    init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  });
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: neverAnswers, timeoutMs: 30 }),
    (e) => e.kind === 'timeout' && /時間/.test(e.message),
  );
});
