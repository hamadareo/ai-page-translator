import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDomState, applyRun, applyText, applyTitle, restoreAll, isOwnText } from '../src/lib/rebuild.js';
import { collectUnits, textUnitsOf, collectTitleUnit } from '../src/lib/extract.js';
import { makeDocument } from './helpers/dom.js';

function setup(html, title = '') {
  const { document } = makeDocument(html, { title });
  return { document, state: createDomState(), units: collectUnits(document.body) };
}

test('applyRun reorders tags and reuses the original elements', () => {
  const { document, state, units } = setup('<p>Click <a href="/x" class="k">here</a> to <b>continue</b>.</p>');
  const link = document.querySelector('a');
  let clicked = 0;
  link.addEventListener('click', () => clicked++);
  assert.equal(applyRun(state, units[0], '<g1>続行</g1>するには<g0>ここ</g0>をクリック。'), 'applied');
  const p = document.querySelector('p');
  assert.equal(p.innerHTML, '<b>続行</b>するには<a href="/x" class="k">ここ</a>をクリック。');
  assert.equal(document.querySelector('a'), link);
  link.click();
  assert.equal(clicked, 1);
  for (const n of [...p.childNodes].filter((n) => n.nodeType === 3)) assert.equal(isOwnText(state, n), true);
});

test('restoreAll returns the exact original markup', () => {
  const html = '<h1>Title</h1><p>Click <a href="/x">here</a> to <b>go <i>now</i></b>.<br>Next</p><div>Intro<p>Para</p>Tail</div>';
  const { document, state, units } = setup(html, 'Page');
  for (const u of units) assert.equal(applyRun(state, u, `訳:${u.text}`), 'applied');
  const title = collectTitleUnit(document, () => false);
  assert.equal(applyTitle(state, document, title, 'ページ'), 'applied');
  assert.notEqual(document.body.innerHTML, html);
  restoreAll(state, document);
  assert.equal(document.body.innerHTML, html);
  assert.equal(document.title, 'Page');
  assert.deepEqual(state.records, []);
});

test('mismatched tags leave the DOM untouched', () => {
  const { document, state, units } = setup('<p>Click <a>here</a></p>');
  const before = document.body.innerHTML;
  assert.equal(applyRun(state, units[0], 'ここをクリック'), 'mismatch');
  assert.equal(applyRun(state, units[0], '<g0>ここ'), 'mismatch');
  assert.equal(applyRun(state, units[0], '   '), 'mismatch');
  assert.equal(document.body.innerHTML, before);
});

test('stale when the page changed the run meanwhile', () => {
  const { document, state, units } = setup('<p>Hello</p>');
  units[0].nodes[0].data = 'Changed';
  assert.equal(applyRun(state, units[0], 'こんにちは'), 'stale');
  assert.equal(document.querySelector('p').textContent, 'Changed');
  const fresh = collectUnits(document.body)[0];
  fresh.nodes[0].remove();
  assert.equal(applyRun(state, fresh, 'x'), 'stale');
});

test('applyText keeps surrounding whitespace and restores', () => {
  const { document, state, units } = setup('<p>Click <a>here</a> now.</p>');
  const parts = textUnitsOf(units[0]);
  assert.equal(applyText(state, parts[0], 'クリック'), 'applied');
  assert.equal(applyText(state, parts[1], 'ここ'), 'applied');
  assert.equal(applyText(state, parts[2], '今。'), 'applied');
  assert.equal(document.querySelector('p').innerHTML, 'クリック <a>ここ</a> 今。');
  assert.equal(applyText(state, parts[0], 'again'), 'stale');
  assert.equal(applyText(state, { kind: 'text', node: document.createTextNode('x'), text: 'x' }, ''), 'failed');
  restoreAll(state, document);
  assert.equal(document.querySelector('p').innerHTML, 'Click <a>here</a> now.');
});

test('re-translating translated content restores in the right order', () => {
  const { document, state, units } = setup('<p>Hello <b>world</b></p>');
  applyRun(state, units[0], 'こんにちは <g0>世界</g0>');
  document.querySelector('p').append(' extra');
  const again = collectUnits(document.body)[0];
  assert.equal(applyRun(state, again, 'こんにちは <g0>世界</g0> 追加'), 'applied');
  restoreAll(state, document);
  assert.equal(document.querySelector('p').innerHTML, 'Hello <b>world</b> extra');
});

test('restoreAll tolerates content the page removed', () => {
  const { document, state, units } = setup('<p id="a">One</p><p id="b">Two</p>');
  applyRun(state, units[0], '一');
  applyRun(state, units[1], '二');
  document.getElementById('a').remove();
  assert.doesNotThrow(() => restoreAll(state, document));
  assert.equal(document.body.innerHTML, '<p id="b">Two</p>');
});

test('keeps literal tag-like text as text', () => {
  const { document, state, units } = setup('<p>a &lt;g0&gt; b</p>');
  assert.equal(applyRun(state, units[0], 'あ &lt;g0&gt; い'), 'applied');
  assert.equal(document.querySelector('p').textContent, 'あ <g0> い');
});

test('applyTitle is stale when the page retitled itself and failed on empty output', () => {
  const { document, state } = setup('', 'Page');
  const unit = collectTitleUnit(document, () => false);
  assert.equal(applyTitle(state, document, unit, ' '), 'failed');
  document.title = 'Other';
  assert.equal(applyTitle(state, document, unit, 'ページ'), 'stale');
});
