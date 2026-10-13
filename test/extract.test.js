import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUnits, serializeRun, parseMarked, matchesTokens, textUnitsOf, collectTitleUnit, collapse, STATUS_HOST_ID,
} from '../src/lib/extract.js';
import { makeDocument } from './helpers/dom.js';

const texts = (html) => collectUnits(makeDocument(html).document.body).map((u) => u.text);

test('paragraph-level units', () => {
  assert.deepEqual(texts('<h1>Title</h1><p>First para.</p><ul><li>One</li><li>Two</li></ul>'), ['Title', 'First para.', 'One', 'Two']);
});

test('inline elements become g tags, code becomes c, void becomes x', () => {
  assert.deepEqual(texts('<p>Click <a href="/x">here</a> to <b>continue</b>.</p>'), ['Click <g0>here</g0> to <g1>continue</g1>.']);
  assert.deepEqual(texts('<p>Run <code>npm test</code> now</p>'), ['Run <c0>npm test</c0> now']);
  assert.deepEqual(texts('<p>a<br>b <img src="x.png"> c</p>'), ['a<x0/>b <x1/> c']);
  assert.deepEqual(texts('<p>A <a href="#"><em>deep</em> link</a></p>'), ['A <g0><g1>deep</g1> link</g0>']);
});

test('whitespace is collapsed and trimmed', () => {
  assert.deepEqual(texts('<p>\n   Hello\n   <b>world</b>   </p>'), ['Hello <g0>world</g0>']);
});

test('skips excluded content', () => {
  const html = `
    <script>var a = "Hello";</script><style>p{}</style><pre>Code block</pre>
    <textarea>Typed</textarea><div translate="no">Keep</div><div class="notranslate">Keep</div>
    <div contenteditable="true">Editing</div><div id="${STATUS_HOST_ID}">Status</div>
    <p>Visible</p>`;
  assert.deepEqual(texts(html), ['Visible']);
});

test('non-translatable inline elements inside a paragraph become x tags', () => {
  assert.deepEqual(texts('<p>Hi <span class="notranslate">Bob</span>!</p>'), ['Hi <x0/>!']);
});

test('standalone code and letterless text are skipped', () => {
  assert.deepEqual(texts('<div><code>x = 1</code></div><p>123 - 456</p><p>  </p>'), []);
});

test('text runs split around block children', () => {
  assert.deepEqual(texts('<div>Intro text<p>Para</p>Tail text</div>'), ['Intro text', 'Para', 'Tail text']);
});

test('inline elements containing blocks are walked as blocks', () => {
  assert.deepEqual(texts('<a href="#"><div>Card title</div><span>desc</span></a>'), ['Card title', '<g0>desc</g0>']);
});

test('iframes and media split runs instead of becoming tokens', () => {
  assert.deepEqual(texts('<div>Before<iframe src="about:blank"></iframe>After</div>'), ['Before', 'After']);
});

test('escapes literal tag-like text', () => {
  assert.deepEqual(texts('<p>a &lt;g0&gt; &amp; b</p>'), ['a &lt;g0&gt; &amp; b']);
});

test('isSettled filters units and receives translatable text nodes only', () => {
  const { document } = makeDocument('<p>One <code>x</code></p><p>Two</p>');
  const seen = [];
  const units = collectUnits(document.body, {
    isSettled: (nodes) => {
      seen.push(nodes.map((n) => n.data));
      return nodes[0].data === 'Two';
    },
  });
  assert.deepEqual(units.map((u) => u.text), ['One <c0>x</c0>']);
  assert.deepEqual(seen, [['One '], ['Two']]);
});

test('units expose parent, nodes and textNodes', () => {
  const { document } = makeDocument('<p id="p">Hi <b>there</b></p>');
  const [u] = collectUnits(document.body);
  assert.equal(u.kind, 'run');
  assert.equal(u.parent, document.getElementById('p'));
  assert.equal(u.nodes.length, 2);
  assert.deepEqual(u.textNodes.map((n) => n.data), ['Hi ', 'there']);
});

test('serializeRun returns tokens indexed by id', () => {
  const { document } = makeDocument('<p>A <a>b</a><br><code>c</code></p>');
  const { text, tokens } = serializeRun([...document.querySelector('p').childNodes]);
  assert.equal(text, 'A <g0>b</g0><x1/><c2>c</c2>');
  assert.deepEqual(tokens.map((t) => [t.type, t.node.nodeName]), [['g', 'A'], ['x', 'BR'], ['c', 'CODE']]);
});

test('parseMarked builds a tree and unescapes text', () => {
  assert.deepEqual(parseMarked('x <g1>y <x0 /></g1> &lt;z&gt;'), [
    { type: 'text', value: 'x ' },
    { type: 'g', id: 1, children: [{ type: 'text', value: 'y ' }, { type: 'x', id: 0 }] },
    { type: 'text', value: ' <z>' },
  ]);
  assert.deepEqual(parseMarked('<g0/>'), [{ type: 'g', id: 0, children: [] }]);
});

test('parseMarked rejects broken structure', () => {
  assert.throws(() => parseMarked('<g0>a'));
  assert.throws(() => parseMarked('a</g0>'));
  assert.throws(() => parseMarked('<g0><g1>a</g0></g1>'));
});

test('matchesTokens requires every token exactly once with the right type', () => {
  const tokens = [{ type: 'g' }, { type: 'x' }];
  assert.equal(matchesTokens(parseMarked('<x1/><g0>a</g0>'), tokens), true);
  assert.equal(matchesTokens(parseMarked('<g0>a</g0>'), tokens), false);
  assert.equal(matchesTokens(parseMarked('<g0>a</g0><x1/><x1/>'), tokens), false);
  assert.equal(matchesTokens(parseMarked('<c0>a</c0><x1/>'), tokens), false);
  assert.equal(matchesTokens(parseMarked('<g0>a</g0><x1/><x2/>'), tokens), false);
});

test('textUnitsOf splits a run into its text nodes', () => {
  const { document } = makeDocument('<p>Click <a>here</a> now <code>x</code></p>');
  const [u] = collectUnits(document.body);
  assert.deepEqual(textUnitsOf(u).map((t) => [t.kind, t.text]), [['text', 'Click'], ['text', 'here'], ['text', 'now']]);
});

test('collectTitleUnit', () => {
  const { document } = makeDocument('', { title: '  My   page ' });
  assert.deepEqual(collectTitleUnit(document, () => false), { kind: 'title', text: 'My page' });
  assert.equal(collectTitleUnit(document, () => true), null);
  assert.equal(collectTitleUnit(makeDocument('', { title: '123' }).document, () => false), null);
});

test('collapse', () => {
  assert.equal(collapse('  a \n\t b  '), 'a b');
});
