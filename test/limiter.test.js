import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/lib/limiter.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('never runs more than max tasks at once and returns results', async () => {
  const limiter = createLimiter(2);
  let running = 0;
  let peak = 0;
  const task = (v) => limiter.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
    return v;
  });
  const results = await Promise.all([1, 2, 3, 4, 5].map(task));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.equal(limiter.active, 0);
});

test('propagates rejections and keeps going', async () => {
  const limiter = createLimiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('x'); }), /x/);
  assert.equal(await limiter.run(async () => 7), 7);
});

test('setMax raises concurrency for queued work', async () => {
  const limiter = createLimiter(1);
  let peak = 0;
  let running = 0;
  const jobs = [1, 2, 3].map(() => limiter.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
  }));
  limiter.setMax(3);
  await Promise.all(jobs);
  assert.equal(peak, 3);
});
