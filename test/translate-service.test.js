import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslateService, translateWithSplit } from '../src/lib/translate-service.js';
import { createCache } from '../src/lib/cache.js';
import { createLimiter } from '../src/lib/limiter.js';
import { mergeSettings } from '../src/lib/settings.js';
import { TranslationError } from '../src/lib/errors.js';
import { createFakeStorage } from './helpers/fake-storage.js';

const settings = mergeSettings({ providers: { openai: { apiKey: 'k' } } });

function setup(call, s = settings) {
  const calls = [];
  const wrapped = async (...args) => { calls.push(args[1]); return call(...args); };
  const translate = createTranslateService({
    getSettings: async () => s,
    cache: createCache(createFakeStorage()),
    limiter: createLimiter(3),
    call: wrapped,
    sleep: async () => {},
  });
  return { translate, calls };
}

const upper = async (_p, texts) => texts.map((t) => t.toUpperCase());

test('passes provider, language and config to the call', async () => {
  let seen;
  const { translate } = setup(async (provider, texts, lang, config) => {
    seen = { provider, lang, config };
    return texts;
  });
  await translate(['a']);
  assert.deepEqual(seen, { provider: 'openai', lang: '日本語', config: settings.providers.openai });
});

test('uses the cache for repeated texts', async () => {
  const { translate, calls } = setup(upper);
  assert.deepEqual(await translate(['a', 'b']), ['A', 'B']);
  assert.deepEqual(await translate(['b', 'c']), ['B', 'C']);
  assert.deepEqual(calls, [['a', 'b'], ['c']]);
  assert.deepEqual(await translate(['a', 'c']), ['A', 'C']);
  assert.equal(calls.length, 2);
});

test('splits a batch when the response is unusable', async () => {
  const { translate, calls } = setup(async (_p, texts) => {
    if (texts.length > 1) throw new TranslationError('bad_response', 'count');
    return texts.map((t) => t.toUpperCase());
  });
  assert.deepEqual(await translate(['a', 'b', 'c']), ['A', 'B', 'C']);
  assert.deepEqual(calls, [['a', 'b', 'c'], ['a', 'b'], ['a'], ['b'], ['c']]);
});

test('a text that keeps failing becomes null and is not cached', async () => {
  const { translate, calls } = setup(async (_p, texts) => {
    if (texts.includes('bad')) throw new TranslationError('bad_response', 'x');
    return texts;
  });
  assert.deepEqual(await translate(['ok', 'bad']), ['ok', null]);
  const before = calls.length;
  assert.deepEqual(await translate(['bad']), [null]);
  assert.equal(calls.length, before + 1);
});

test('retries rate limits before giving up', async () => {
  let n = 0;
  const { translate } = setup(async (_p, texts) => {
    if (++n === 1) throw new TranslationError('rate_limit', 'slow down');
    return texts;
  });
  assert.deepEqual(await translate(['a']), ['a']);
  assert.equal(n, 2);
});

test('fatal errors propagate', async () => {
  const { translate } = setup(async () => { throw new TranslationError('auth', 'key'); });
  await assert.rejects(translate(['a']), { kind: 'auth' });
});

test('invalid settings raise a config error without calling the provider', async () => {
  const { translate, calls } = setup(upper, mergeSettings({}));
  await assert.rejects(translate(['a']), { kind: 'config' });
  assert.equal(calls.length, 0);
});

test('translateWithSplit returns [] for empty input without calling', async () => {
  let called = false;
  assert.deepEqual(await translateWithSplit([], async () => { called = true; return []; }), []);
  assert.equal(called, false);
});

test('a failing cache write does not lose translations', async () => {
  const storage = createFakeStorage();
  storage.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  const translate = createTranslateService({
    getSettings: async () => settings,
    cache: createCache(storage),
    limiter: createLimiter(1),
    call: upper,
    sleep: async () => {},
  });
  assert.deepEqual(await translate(['a']), ['A']);
});
