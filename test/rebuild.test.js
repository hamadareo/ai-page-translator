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

test('applyRun keeps the original text nodes so framework references stay attached', () => {
  const { document, state, units } = setup('<p>Hello <b>world</b> again</p>');
  const p = document.querySelector('p');
  const [hello, again] = [p.firstChild, p.lastChild];
  const world = p.querySelector('b').firstChild;
  assert.equal(applyRun(state, units[0], '<g0>世界</g0>こんにちは'), 'applied');
  assert.equal(p.innerHTML, '<b>世界</b>こんにちは');
  assert.equal(world.parentNode, p.querySelector('b'));
  assert.equal(world.data, '世界');
  assert.equal(hello.parentNode, p, 'reused for the first piece');
  assert.equal(again.parentNode, p, 'unused original stays attached, emptied');
  assert.equal(again.data, '');
  assert.doesNotThrow(() => p.removeChild(again));
  assert.doesNotThrow(() => p.insertBefore(document.createTextNode('x'), hello));
});

test('restoreAll puts reused text back unless the page rewrote it', () => {
  const { document, state, units } = setup('<p>One</p><p>Two</p>');
  const [one, two] = [...document.querySelectorAll('p')].map((p) => p.firstChild);
  applyRun(state, units[0], '一');
  applyRun(state, units[1], '二');
  two.data = 'Fresh';
  restoreAll(state, document);
  assert.equal(one.data, 'One');
  assert.equal(two.data, 'Fresh');
});

test('self-closing g output is a mismatch, not an emptied link', () => {
  const { document, state, units } = setup('<p>Go <a href="/x">home</a></p>');
  assert.equal(applyRun(state, units[0], '<g0/>へ行く'), 'mismatch');
  assert.equal(document.querySelector('a').textContent, 'home');
});

test('restoreAll keeps going when one record cannot be restored', () => {
  const { document, state, units } = setup('<p id="a">Click <a>here</a></p><p id="b">Two</p>');
  applyRun(state, units[0], '<g0>ここ</g0>をクリック');
  applyRun(state, units[1], '二');
  const pa = document.getElementById('a');
  const link = pa.querySelector('a');
  link.remove();
  link.appendChild(pa); // the page nests the paragraph inside its own link
  assert.doesNotThrow(() => restoreAll(state, document));
  assert.equal(document.getElementById('b').textContent, 'Two');
});

test('applyRun works for units collected with ignoreTranslateNo', () => {
  const { document } = makeDocument('<div translate="no"><p>Hello <b>world</b></p></div>');
  const state = createDomState();
  const [unit] = collectUnits(document.body, { ignoreTranslateNo: true });
  assert.equal(applyRun(state, unit, 'こんにちは <g0>世界</g0>'), 'applied');
  assert.equal(document.querySelector('p').innerHTML, 'こんにちは <b>世界</b>');
});

function stubOverflow(el, scrollWidth, clientWidth) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => clientWidth });
}

test('a nowrap paragraph that overflows after translation is allowed to wrap', () => {
  const { document } = makeDocument('<p style="white-space: nowrap">Continuous Fall<br>Detection</p>');
  const p = document.querySelector('p');
  stubOverflow(p, 500, 100);
  const state = createDomState();
  const [unit] = collectUnits(document.body);
  assert.equal(applyRun(state, unit, '連続的な<x0/>転倒検出'), 'applied');
  assert.equal(p.style.getPropertyValue('white-space'), 'normal');
  assert.equal(p.style.getPropertyPriority('white-space'), 'important');
});

test('nowrap text that still fits is left alone', () => {
  const { document } = makeDocument('<p style="white-space: nowrap">Home</p>');
  const p = document.querySelector('p');
  stubOverflow(p, 80, 100);
  const state = createDomState();
  applyRun(state, collectUnits(document.body)[0], 'ホーム');
  assert.equal(p.style.getPropertyValue('white-space'), 'nowrap');
});

test('white-space: pre becomes pre-wrap when it overflows', () => {
  const { document } = makeDocument('<div style="white-space: pre">Long line here</div>');
  const div = document.querySelector('div');
  stubOverflow(div, 500, 100);
  const state = createDomState();
  applyRun(state, collectUnits(document.body)[0], 'とても長い行');
  assert.equal(div.style.getPropertyValue('white-space'), 'pre-wrap');
});

test('restoreAll removes the wrap fix and restores the exact markup', () => {
  const html = '<p class="k">One<br>Two</p><div style="color: red; white-space: nowrap">Three</div>';
  const { document } = makeDocument(`<style>.k { white-space: nowrap; }</style>${html}`);
  const [p, div] = [document.querySelector('p'), document.querySelector('div')];
  stubOverflow(p, 500, 100);
  stubOverflow(div, 500, 100);
  const state = createDomState();
  const units = collectUnits(document.body);
  assert.equal(applyRun(state, units[0], '一<x0/>二'), 'applied');
  assert.equal(applyRun(state, units[1], '三'), 'applied');
  assert.equal(p.style.getPropertyValue('white-space'), 'normal', 'stylesheet nowrap is detected too');
  restoreAll(state, document);
  assert.equal(document.body.innerHTML, `<style>.k { white-space: nowrap; }</style>${html}`);
});

/** jsdom has no layout: pretend the box content is 20px tall per character and the box is `height` tall. */
function stubBox(box, height) {
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => height });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => box.textContent.length * 20 });
}

test('content that overflows a fixed-height box after translation is scaled to fit', () => {
  const { document } = makeDocument('<div id="box" style="height: 100px"><div id="inner"><p>Short</p></div></div>');
  stubBox(document.getElementById('box'), 100);
  const state = createDomState();
  assert.equal(applyRun(state, collectUnits(document.body)[0], 'ながいやくぶん'), 'applied');
  const inner = document.getElementById('inner');
  assert.equal(inner.style.transform, 'scale(0.714)');
  assert.equal(inner.style.transformOrigin, 'top left');
});

test('overflow that existed before translation is not counted', () => {
  const { document } = makeDocument('<div id="box" style="height: 50px"><div id="inner"><p>Short</p></div></div>');
  stubBox(document.getElementById('box'), 50);
  const state = createDomState();
  applyRun(state, collectUnits(document.body)[0], 'ながい');
  assert.equal(document.getElementById('inner').style.transform, '');
});

test('no scaling when it would need to shrink below 60%', () => {
  const { document } = makeDocument('<div id="box" style="height: 100px"><div id="inner"><p>Short</p></div></div>');
  stubBox(document.getElementById('box'), 100);
  const state = createDomState();
  applyRun(state, collectUnits(document.body)[0], 'とてもながいやくぶん');
  assert.equal(document.getElementById('inner').style.transform, '');
});

test('an element that already has a transform is never overwritten', () => {
  const { document } = makeDocument('<div id="box" style="height: 100px"><div id="inner" style="transform: rotate(1deg)"><p style="text-align: center">Short</p></div></div>');
  stubBox(document.getElementById('box'), 100);
  const state = createDomState();
  applyRun(state, collectUnits(document.body)[0], 'ながいやくぶん');
  assert.equal(document.getElementById('inner').style.transform, 'rotate(1deg)');
  const p = document.querySelector('p');
  assert.equal(p.style.transform, 'scale(0.714)');
  assert.equal(p.style.transformOrigin, 'top center');
});

test('the scale is recomputed when another paragraph in the same box is translated', () => {
  const { document } = makeDocument('<div id="box" style="height: 120px"><div id="inner"><p>One</p><p>Two</p></div></div>');
  stubBox(document.getElementById('box'), 120);
  const state = createDomState();
  const units = collectUnits(document.body);
  applyRun(state, units[0], 'いちいちいちい');
  assert.equal(document.getElementById('inner').style.transform, 'scale(0.6)');
  applyRun(state, units[1], 'にに');
  assert.equal(document.getElementById('inner').style.transform, 'scale(0.667)');
});

test('restoreAll removes the fit scaling and restores the exact markup', () => {
  const html = '<div id="box" style="height: 100px"><div id="inner" class="c"><p>Short</p></div></div>';
  const { document } = makeDocument(html);
  stubBox(document.getElementById('box'), 100);
  const state = createDomState();
  applyRun(state, collectUnits(document.body)[0], 'ながいやくぶん');
  assert.notEqual(document.body.innerHTML, html);
  restoreAll(state, document);
  assert.equal(document.body.innerHTML, html);
});
