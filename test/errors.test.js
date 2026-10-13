import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TranslationError, classifyHttpError, parseRetryAfter, isLocalUrl, networkError, toErrorPayload,
  FATAL_KINDS, RETRYABLE_KINDS,
} from '../src/lib/errors.js';

const CLOUD = 'https://api.openai.com/v1/chat/completions';
const LOCAL = 'http://localhost:11434/v1/chat/completions';

test('401 is auth and includes the API message', () => {
  const e = classifyHttpError(401, '{"error":{"message":"bad key"}}', { url: CLOUD });
  assert.ok(e instanceof TranslationError);
  assert.equal(e.kind, 'auth');
  assert.match(e.message, /APIキー/);
  assert.match(e.message, /bad key/);
});

test('403 on localhost is forbidden_local with OLLAMA_ORIGINS hint', () => {
  const e = classifyHttpError(403, '', { url: LOCAL });
  assert.equal(e.kind, 'forbidden_local');
  assert.match(e.message, /OLLAMA_ORIGINS/);
});

test('403 on a cloud API is auth', () => {
  assert.equal(classifyHttpError(403, '', { url: CLOUD }).kind, 'auth');
});

test('429 carries retryAfterMs from a seconds header', () => {
  const e = classifyHttpError(429, '', { url: CLOUD, retryAfter: '2' });
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterMs, 2000);
});

test('5xx is server, other 4xx is config', () => {
  assert.equal(classifyHttpError(503, '', { url: CLOUD }).kind, 'server');
  assert.equal(classifyHttpError(404, '{"error":{"message":"model not found"}}', { url: CLOUD }).kind, 'config');
  assert.equal(classifyHttpError(400, 'plain text body', { url: CLOUD }).message.includes('plain text body'), true);
});

test('parseRetryAfter handles seconds, HTTP dates and garbage', () => {
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('soon'), undefined);
  const ms = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
  assert.ok(ms > 3000 && ms <= 5000, `got ${ms}`);
});

test('isLocalUrl', () => {
  assert.equal(isLocalUrl('http://localhost:1234/v1'), true);
  assert.equal(isLocalUrl('http://127.0.0.1:1234/v1'), true);
  assert.equal(isLocalUrl('https://openrouter.ai/api/v1'), false);
  assert.equal(isLocalUrl('not a url'), false);
});

test('networkError message depends on locality', () => {
  assert.match(networkError(LOCAL).message, /起動/);
  assert.equal(networkError(LOCAL).kind, 'network');
  assert.doesNotMatch(networkError(CLOUD).message, /起動/);
});

test('toErrorPayload serializes known and unknown errors', () => {
  assert.deepEqual(toErrorPayload(new TranslationError('auth', 'x')), { kind: 'auth', message: 'x' });
  assert.deepEqual(toErrorPayload(new Error('boom')), { kind: 'unknown', message: 'boom' });
});

test('kind sets', () => {
  assert.deepEqual([...FATAL_KINDS].sort(), ['auth', 'config', 'forbidden_local', 'network']);
  assert.deepEqual([...RETRYABLE_KINDS].sort(), ['network', 'rate_limit', 'server']);
});
