import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/lib/retry.js';
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
