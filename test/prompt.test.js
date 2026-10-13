import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildUserMessage, parseTranslations, estimateMaxTokens, PROMPT_VERSION } from '../src/lib/prompt.js';

test('system prompt mentions the language, the tags and JSON', () => {
  const p = buildSystemPrompt('日本語');
  assert.match(p, /日本語/);
  assert.match(p, /<g0>/);
  assert.match(p, /<c0>/);
  assert.match(p, /<x1\/>/);
  assert.match(p, /JSON/);
  assert.match(p, /"translations"/);
});

test('user message is JSON with texts', () => {
  assert.deepEqual(JSON.parse(buildUserMessage(['a', 'b'])), { texts: ['a', 'b'] });
});

const bad = { name: 'TranslationError', kind: 'bad_response' };

test('parses plain, fenced, prefaced and <think> responses', () => {
  assert.deepEqual(parseTranslations('{"translations":["あ","い"]}', 2), ['あ', 'い']);
  assert.deepEqual(parseTranslations('```json\n{"translations":["あ"]}\n```', 1), ['あ']);
  assert.deepEqual(parseTranslations('Here you go:\n{"translations":["あ"]}\nThanks', 1), ['あ']);
  assert.deepEqual(parseTranslations('<think>{maybe}</think>{"translations":["あ"]}', 1), ['あ']);
});

test('accepts a bare array', () => {
  assert.deepEqual(parseTranslations('["あ","い"]', 2), ['あ', 'い']);
});

test('rejects count mismatch, non-strings and garbage', () => {
  assert.throws(() => parseTranslations('{"translations":["あ"]}', 2), bad);
  assert.throws(() => parseTranslations('{"translations":[1]}', 1), bad);
  assert.throws(() => parseTranslations('no json here', 1), bad);
  assert.throws(() => parseTranslations('{"translations": [', 1), bad);
  assert.throws(() => parseTranslations(undefined, 1), bad);
});

test('estimateMaxTokens stays within bounds', () => {
  assert.equal(estimateMaxTokens(['']), 2048);
  assert.equal(estimateMaxTokens(['x'.repeat(100000)]), 16000);
  assert.equal(estimateMaxTokens(['x'.repeat(2000)]), 4024);
});

test('people keep their names; well-known organizations get their official target-language name', () => {
  const p = buildSystemPrompt('日本語');
  assert.match(p, /personal names exactly as written/i);
  assert.match(p, /organization/i);
  assert.match(p, /official name/i);
  assert.match(p, /not sure/i);
  assert.doesNotMatch(p, /\(such as names\)/, 'the old blanket "keep names" rule is gone');
});

test('PROMPT_VERSION is exported for cache invalidation', () => {
  assert.equal(typeof PROMPT_VERSION, 'string');
  assert.ok(PROMPT_VERSION.length > 0);
});
