import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBatches } from '../src/lib/batch.js';

test('splits by unit count', () => {
  assert.deepEqual(makeBatches(['a', 'b', 'c', 'd', 'e'], { maxUnits: 2, maxChars: 1000 }), [[0, 1], [2, 3], [4]]);
});

test('splits by character count', () => {
  assert.deepEqual(makeBatches(['aaaa', 'bbbb', 'cc'], { maxUnits: 10, maxChars: 6 }), [[0], [1, 2]]);
});

test('an oversized single text gets its own batch', () => {
  assert.deepEqual(makeBatches(['x'.repeat(50), 'y', 'z'], { maxUnits: 10, maxChars: 10 }), [[0], [1, 2]]);
});

test('empty input gives no batches', () => {
  assert.deepEqual(makeBatches([], { maxUnits: 10, maxChars: 10 }), []);
});
