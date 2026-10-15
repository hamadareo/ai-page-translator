import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusText, createStatusOverlay } from '../src/lib/status-overlay.js';
import { STATUS_HOST_ID } from '../src/lib/extract.js';
import { makeDocument } from './helpers/dom.js';

const base = { done: 0, total: 0, failed: 0, error: null };

test('statusText for each state', () => {
  assert.equal(statusText({ ...base, state: 'idle' }), '');
  assert.equal(statusText({ ...base, state: 'translating', done: 12, total: 40 }), '翻訳中… 12/40');
  assert.equal(statusText({ ...base, state: 'done' }), '翻訳完了');
  assert.equal(statusText({ ...base, state: 'done', failed: 2 }), '翻訳完了（2件失敗）');
  assert.equal(
    statusText({ ...base, state: 'done', failed: 2, error: { kind: 'rate_limit', message: 'レート制限' } }),
    '翻訳完了（2件失敗: レート制限）',
  );
  assert.equal(statusText({ ...base, state: 'stopped', done: 3, total: 9 }), '停止しました（3/9）');
  assert.equal(statusText({ ...base, state: 'error', error: { kind: 'auth', message: 'APIキーを確認してください' } }), 'エラー: APIキーを確認してください');
});

test('overlay appears while active and disappears when idle', () => {
  const { document } = makeDocument('<p>x</p>');
  const overlay = createStatusOverlay(document);
  overlay.update({ ...base, state: 'translating', total: 1 });
  const host = document.getElementById(STATUS_HOST_ID);
  assert.ok(host);
  assert.equal(host.parentNode, document.documentElement);
  overlay.update({ ...base, state: 'done', done: 1, total: 1 });
  assert.equal(document.querySelectorAll(`#${STATUS_HOST_ID}`).length, 1);
  overlay.update({ ...base, state: 'idle' });
  assert.equal(document.getElementById(STATUS_HOST_ID), null);
  overlay.hide();
});

test('statusText shows the phase while translating', () => {
  assert.equal(statusText({ ...base, state: 'translating', phase: 'LM Studio を起動しています…' }), 'LM Studio を起動しています…');
  assert.equal(statusText({ ...base, state: 'translating', phase: null, done: 1, total: 2 }), '翻訳中… 1/2');
});
