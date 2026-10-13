import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageTranslator } from '../src/lib/page-translator.js';
import { makeDocument } from './helpers/dom.js';

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(html) {
  const { window, document } = makeDocument(html, { title: 'Hello page' });
  const ctl = { failWith: null, translate: (t) => `[ja]${t}` };
  const batches = [];
  const sendMessage = async (msg) => {
    if (msg.type === 'getConfig') return { ok: true, maxUnitsPerBatch: 40, maxCharsPerBatch: 3000, concurrency: 2 };
    if (msg.type === 'translateBatch') {
      batches.push(msg.texts);
      if (ctl.failWith) return { ok: false, error: ctl.failWith };
      return { ok: true, translations: msg.texts.map((t) => ctl.translate(t)) };
    }
    throw new Error(`unexpected ${msg.type}`);
  };
  const statuses = [];
  const pt = createPageTranslator({
    document, sendMessage, onStatus: (s) => statuses.push(s), debounceMs: 10, MutationObserverImpl: window.MutationObserver,
  });
  return { document, pt, ctl, batches, statuses };
}

test('translates body and title, keeping elements', async () => {
  const { document, pt, statuses } = setup('<p>Click <a href="/x">here</a> now.</p><p>Second</p>');
  const link = document.querySelector('a');
  const status = await pt.translate();
  assert.equal(document.querySelector('p').innerHTML, '[ja]Click <a href="/x">here</a> now.');
  assert.equal(document.querySelectorAll('p')[1].textContent, '[ja]Second');
  assert.equal(document.title, '[ja]Hello page');
  assert.equal(document.querySelector('a'), link);
  assert.deepEqual(status, { state: 'done', done: 3, total: 3, failed: 0, error: null });
  assert.equal(statuses[0].state, 'translating');
  pt.stop();
});

test('restore brings back the original page', async () => {
  const html = '<p>Click <a href="/x">here</a> now.</p><p>Second</p>';
  const { document, pt } = setup(html);
  await pt.translate();
  pt.restore();
  assert.equal(document.body.innerHTML, html);
  assert.equal(document.title, 'Hello page');
  assert.equal(pt.getStatus().state, 'idle');
});

test('translates content added later', async () => {
  const { document, pt } = setup('<p>First</p>');
  await pt.translate();
  const p = document.createElement('p');
  p.textContent = 'Later';
  document.body.append(p);
  await waitFor(() => p.textContent === '[ja]Later');
  assert.equal(pt.getStatus().state, 'done');
  pt.stop();
});

test('re-translates text the page rewrites after translation', async () => {
  const { document, pt } = setup('<p>First</p><p>Second</p>');
  await pt.translate();
  const second = document.querySelectorAll('p')[1];
  second.firstChild.data = 'Rewritten';
  await waitFor(() => second.textContent === '[ja]Rewritten');
  pt.stop();
});

test('a fatal error stops everything and leaves the page unchanged', async () => {
  const { document, pt, ctl } = setup('<p>One</p>');
  ctl.failWith = { kind: 'auth', message: 'APIキーを確認してください' };
  const status = await pt.translate();
  assert.equal(status.state, 'error');
  assert.equal(status.error.kind, 'auth');
  assert.equal(document.querySelector('p').textContent, 'One');
});

test('retries everything after a fatal error once translate is pressed again', async () => {
  const { document, pt, ctl } = setup('<p>One</p>');
  ctl.failWith = { kind: 'auth', message: 'x' };
  await pt.translate();
  ctl.failWith = null;
  const status = await pt.translate();
  assert.equal(status.state, 'done');
  assert.equal(document.querySelector('p').textContent, '[ja]One');
  pt.stop();
});

test('a config error from getConfig is reported', async () => {
  const { document } = makeDocument('<p>One</p>');
  const pt = createPageTranslator({
    document,
    sendMessage: async () => ({ ok: false, error: { kind: 'config', message: 'APIキーを設定してください' } }),
  });
  const status = await pt.translate();
  assert.equal(status.state, 'error');
  assert.equal(status.error.message, 'APIキーを設定してください');
});

test('non-fatal batch failures are counted and translation finishes', async () => {
  const { pt, ctl } = setup('<p>One</p><p>Two</p>');
  ctl.failWith = { kind: 'rate_limit', message: 'slow' };
  const status = await pt.translate();
  assert.equal(status.state, 'done');
  assert.equal(status.failed, 3);
  assert.equal(status.done, 3);
  pt.stop();
});

test('null translations count as failures', async () => {
  const { document, pt, ctl } = setup('<p>One</p><p>Two</p>');
  ctl.translate = (t) => (t === 'Two' ? null : `[ja]${t}`);
  const status = await pt.translate();
  assert.equal(status.failed, 1);
  assert.equal(document.querySelectorAll('p')[1].textContent, 'Two');
  pt.stop();
});

test('falls back to per-text-node translation when tags do not match', async () => {
  const { document, pt, ctl, batches } = setup('<p>Click <a href="/x">here</a> now.</p>');
  ctl.translate = (t) => `[ja]${t.replace(/<\/?[gcx]\d+\/?>/g, '')}`;
  const link = document.querySelector('a');
  const status = await pt.translate();
  assert.equal(document.querySelector('p').innerHTML, '[ja]Click <a href="/x">[ja]here</a> [ja]now.');
  assert.equal(document.querySelector('a'), link);
  assert.deepEqual(batches.at(-1), ['Click', 'here', 'now.']);
  assert.equal(status.total, 5);
  assert.equal(status.done, 5);
  pt.stop();
});

test('stop ends observation of new content', async () => {
  const { document, pt } = setup('<p>One</p>');
  await pt.translate();
  pt.stop();
  assert.equal(pt.getStatus().state, 'stopped');
  const p = document.createElement('p');
  p.textContent = 'Later';
  document.body.append(p);
  await sleep(50);
  assert.equal(p.textContent, 'Later');
});

test('translate while already running is a no-op', async () => {
  const { pt, batches } = setup('<p>One</p>');
  await Promise.all([pt.translate(), pt.translate()]);
  assert.equal(batches.length, 1);
  pt.stop();
});
