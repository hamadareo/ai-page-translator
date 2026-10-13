import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, createCache, CACHE_KEY } from '../src/lib/cache.js';
import { createFakeStorage } from './helpers/fake-storage.js';

test('cacheKey is deterministic and depends on every part', async () => {
  const a = await cacheKey('openai', 'm', 'ja', 'Hello');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await cacheKey('openai', 'm', 'ja', 'Hello'));
  assert.notEqual(a, await cacheKey('openai', 'm2', 'ja', 'Hello'));
  assert.notEqual(a, await cacheKey('anthropic', 'm', 'ja', 'Hello'));
  assert.notEqual(a, await cacheKey('openai', 'm', 'en', 'Hello'));
  assert.notEqual(a, await cacheKey('openai', 'm', 'ja', 'Hello!'));
});

test('stores, reads back and persists across instances', async () => {
  const storage = createFakeStorage();
  const cache = createCache(storage);
  await cache.setMany([{ key: 'a', value: 'あ' }]);
  assert.deepEqual(await cache.getMany(['a', 'b']), ['あ', undefined]);
  const again = createCache(storage);
  assert.deepEqual(await again.getMany(['a']), ['あ']);
  assert.ok(storage.data[CACHE_KEY].a);
});

test('evicts least recently used entries beyond maxEntries', async () => {
  let t = 0;
  const cache = createCache(createFakeStorage(), { maxEntries: 2, now: () => ++t });
  await cache.setMany([{ key: 'a', value: '1' }]);
  await cache.setMany([{ key: 'b', value: '2' }]);
  await cache.getMany(['a']); // a を最近使ったことにする
  await cache.setMany([{ key: 'c', value: '3' }]);
  assert.equal(await cache.size(), 2);
  assert.deepEqual(await cache.getMany(['a', 'b', 'c']), ['1', undefined, '3']);
});

test('clear empties memory and storage', async () => {
  const storage = createFakeStorage();
  const cache = createCache(storage);
  await cache.setMany([{ key: 'a', value: '1' }]);
  await cache.clear();
  assert.deepEqual(await cache.getMany(['a']), [undefined]);
  assert.equal(CACHE_KEY in storage.data, false);
});

test('concurrent first reads load storage once', async () => {
  const storage = createFakeStorage({ [CACHE_KEY]: { a: { v: '1', t: 0 } } });
  let gets = 0;
  const original = storage.get;
  storage.get = async (k) => { gets++; return original(k); };
  const cache = createCache(storage);
  await Promise.all([cache.getMany(['a']), cache.getMany(['a'])]);
  assert.equal(gets, 1);
});

test('cacheKey depends on the prompt version', async () => {
  assert.notEqual(await cacheKey('openai', 'm', 'ja', 'Hello', 'v1'), await cacheKey('openai', 'm', 'ja', 'Hello', 'v2'));
});
