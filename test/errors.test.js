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
  assert.deepEqual([...FATAL_KINDS].sort(), ['auth', 'config', 'forbidden_local', 'network', 'quota']);
  assert.deepEqual([...RETRYABLE_KINDS].sort(), ['network', 'rate_limit', 'server', 'timeout']);
});

test('429 caused by an exhausted quota is a fatal quota error, not a retryable rate limit', () => {
  const gemini = classifyHttpError(429, '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}', { url: CLOUD });
  assert.equal(gemini.kind, 'quota');
  assert.match(gemini.message, /利用上限/);
  const openai = classifyHttpError(429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}', { url: CLOUD });
  assert.equal(openai.kind, 'quota');
  assert.ok(FATAL_KINDS.has('quota'));
  assert.ok(!RETRYABLE_KINDS.has('quota'));
  assert.ok(RETRYABLE_KINDS.has('timeout'));
  assert.equal(classifyHttpError(429, '{"error":{"message":"Too many requests"}}', { url: CLOUD }).kind, 'rate_limit');
});

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';

function geminiQuotaBody(quotaId, retryDelay) {
  const details = [
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaValue: '10' }],
    },
  ];
  if (retryDelay) details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
  return JSON.stringify({
    error: {
      code: 429,
      message: `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10\nPlease retry in ${retryDelay ?? '1s'}.`,
      status: 'RESOURCE_EXHAUSTED',
      details,
    },
  });
}

test('Gemini free-tier per-minute limit is a retryable rate limit that waits as long as Google asks', () => {
  const e = classifyHttpError(429, geminiQuotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '41s'), { url: GEMINI });
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterMs, 41000);
  assert.match(e.message, /1分あたり/);
});

test('Gemini per-minute token limit is also a rate limit, and fractional delays are kept', () => {
  const e = classifyHttpError(429, geminiQuotaBody('GenerateContentInputTokensPerModelPerMinute-FreeTier', '12.5s'), { url: GEMINI });
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterMs, 12500);
});

test('Gemini per-day limit stays a fatal quota error that says when it resets', () => {
  const e = classifyHttpError(429, geminiQuotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '3600s'), { url: GEMINI });
  assert.equal(e.kind, 'quota');
  assert.match(e.message, /1日/);
});

test('without a RetryInfo, the "Please retry in" hint in the message is used', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota. Please retry in 7.2s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }],
    },
  });
  const e = classifyHttpError(429, body, { url: GEMINI });
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterMs, 7200);
});
