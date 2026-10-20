import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, createCooldown } from '../src/lib/retry.js';
import { TranslationError } from '../src/lib/errors.js';

test('retries retryable errors with exponential backoff', async () => {
  const delays = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new TranslationError('server', 'x');
    return 'ok';
  }, { sleep: async (ms) => delays.push(ms) });
  assert.equal(result, 'ok');
  assert.deepEqual(delays, [1000, 2000]);
});

test('uses retryAfterMs when present, capped at maxDelayMs', async () => {
  const delays = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls === 1) throw new TranslationError('rate_limit', 'x', { retryAfterMs: 5000 });
    if (calls === 2) throw new TranslationError('rate_limit', 'x', { retryAfterMs: 999999 });
    return 'ok';
  }, { sleep: async (ms) => delays.push(ms) });
  assert.deepEqual(delays, [5000, 60000]);
});

test('gives up after the retry limit', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new TranslationError('network', 'down'); }, { sleep: async () => {} }),
    /down/,
  );
  assert.equal(calls, 4);
});

test('does not retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new TranslationError('auth', 'nope'); }, { sleep: async () => {} }),
    /nope/,
  );
  assert.equal(calls, 1);
});

test('timeouts are retried', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    if (++calls === 1) throw new TranslationError('timeout', 'slow');
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(result, 'ok');
});

test('rate limits get more attempts than other errors', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    if (++calls <= 6) throw new TranslationError('rate_limit', 'busy', { retryAfterMs: 1000 });
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 7);
});

test('a rate limit pauses every request sharing the cooldown, and reports the wait', async () => {
  let now = 0;
  const slept = [];
  const waits = [];
  const sleep = async (ms) => { slept.push(ms); now += ms; };
  const cooldown = createCooldown({ now: () => now, sleep });
  let first = true;
  await withRetry(async () => {
    if (first) { first = false; throw new TranslationError('rate_limit', 'busy', { retryAfterMs: 30000 }); }
    return 'ok';
  }, { sleep, cooldown, onWait: (ms) => waits.push(ms) });
  assert.deepEqual(waits, [30000]);
  // 別のリクエストも、待ち時間が明けるまでは送らない
  now = 10000;
  slept.length = 0;
  cooldown.pause(30000);
  await withRetry(async () => 'ok', { sleep, cooldown });
  assert.deepEqual(slept, [30000]);
});
