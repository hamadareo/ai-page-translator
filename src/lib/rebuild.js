import { serializeRun, parseMarked, matchesTokens, collapse } from './extract.js';

export function createDomState() {
  return { seen: new WeakMap(), records: [], titleWritten: null, fits: new Map(), lineFits: new Map(), baselines: new WeakMap() };
}

/** 拡張機能が書いた内容のまま残っているテキストノードか */
export function isOwnText(state, node) {
  return state.seen.get(node) === node.data;
}

const MIN_FIT_SCALE = 0.6;
const FIT_SEARCH_DEPTH = 10;
const RELAXED_WHITE_SPACE = { nowrap: 'normal', pre: 'pre-wrap' };

const hasNoTransform = (style) => !style.transform || style.transform === 'none';

function resetAttr(el, attr) {
  if (attr === null) el.removeAttribute('style');
  else el.setAttribute('style', attr);
}

function originFor(style) {
  const align = style.textAlign;
  if (align === 'center') return 'top center';
  if (align === 'right' || align === 'end') return 'top right';
  return 'top left';
}

/** 要素を ratio 倍に縮小し、復元用の記録を返す */
function scaleElement(state, el, ratio, origin) {
  const record = { kind: 'fit', target: el, originalAttr: el.getAttribute('style') };
  el.style.setProperty('transform', `scale(${Number(ratio.toFixed(3))})`);
  el.style.setProperty('transform-origin', origin);
  record.writtenAttr = el.getAttribute('style');
  state.records.push(record);
  return record;
}

/**
 * 自動で折り返さない指定のまま訳文が横にはみ出したら、
 * 少しなら縮小して1行に収め、大きくはみ出すなら折り返しを許可する
 */
function relaxWhiteSpace(state, el) {
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle?.(el);
  const relaxed = RELAXED_WHITE_SPACE[style?.whiteSpace];
  if (!relaxed || el.scrollWidth <= el.clientWidth + 1) return;
  const ratio = el.clientWidth / el.scrollWidth;
  if (ratio >= MIN_FIT_SCALE && hasNoTransform(style)) {
    // はみ出した行は中央揃えでも左端から並ぶので、左上を基準に縮める
    scaleElement(state, el, ratio, 'top left');
    return;
  }
  const record = {
    kind: 'style',
    el,
    originalAttr: el.getAttribute('style'),
    value: el.style.getPropertyValue('white-space'),
    priority: el.style.getPropertyPriority('white-space'),
  };
  el.style.setProperty('white-space', relaxed, 'important');
  record.writtenAttr = el.getAttribute('style');
  state.records.push(record);
}

function restoreStyle(record) {
  const { el, originalAttr, writtenAttr, value, priority } = record;
  // ページ側がその後スタイルを変えていなければ、元の属性文字列をそのまま戻す
  if (el.getAttribute('style') === writtenAttr) {
    if (originalAttr === null) el.removeAttribute('style');
    else el.setAttribute('style', originalAttr);
    return;
  }
  if (value) el.style.setProperty('white-space', value, priority);
  else el.style.removeProperty('white-space');
}

/** 高さ固定の枠（Canva などのサイトビルダー）からあふれた訳文を、収まる比率で縮小する */

function findFixedBox(el) {
  for (let a = el, d = 0; a && d < FIT_SEARCH_DEPTH; a = a.parentElement, d++) {
    if (a.style?.height) return a;
  }
  return null;
}

/** 枠に収めるときの縮小の下限。これより小さくすると読めなくなるので、あふれたままにする */
const MIN_BOX_SCALE = 0.4;
/** 1行のまま縮める候補を試す、短い文の目安（レイアウトを測れない環境向け） */
const SHORT_TEXT_LENGTH = 40;

/** 置き換え前のテキストが何行で表示されていたか（測れなければ 0） */
function lineCount(nodes) {
  const doc = nodes[0]?.ownerDocument;
  const range = doc?.createRange?.();
  if (!range?.getClientRects) return 0;
  range.setStartBefore(nodes[0]);
  range.setEndAfter(nodes.at(-1));
  const tops = [];
  for (const rect of range.getClientRects()) {
    if (rect.width < 1 || rect.height < 1) continue;
    if (!tops.some((top) => Math.abs(top - rect.top) < rect.height / 2)) tops.push(rect.top);
  }
  return tops.length;
}

/**
 * 高さ固定の枠から訳文があふれたら、「そのまま」「折り返す」「1行のまま」の候補を実際に測り、
 * 縮小が最も少なくて済む表示方法を選んで、枠に収まるまで縮小する
 */
function undoFit(fits, key) {
  const fit = fits.get(key);
  if (!fit) return;
  resetAttr(fit.target, fit.originalAttr);
  fit.writtenAttr = fit.originalAttr;
  fits.delete(key);
}

function fitBox(state, box, from, singleLineAllowed) {
  const view = box.ownerDocument.defaultView;
  if (!view?.getComputedStyle) return;
  // 縮小前の大きさで測り直す（行の横幅合わせは行ごと、枠の高さ合わせは枠ごとに管理する）
  undoFit(state.fits, box);
  undoFit(state.lineFits, from);
  const limit = Math.max(box.clientHeight, state.baselines.get(box) ?? 0);
  const fromAttr = from.getAttribute('style');
  const baseWhiteSpace = view.getComputedStyle(from).whiteSpace;
  const tryWhiteSpace = (whiteSpace) => {
    resetAttr(from, fromAttr);
    if (whiteSpace) from.style.setProperty('white-space', whiteSpace, 'important');
    const widthScale = from.scrollWidth > from.clientWidth + 1 ? from.clientWidth / from.scrollWidth : 1;
    const heightScale = limit && box.scrollHeight > limit + 2 ? limit / box.scrollHeight : 1;
    return { whiteSpace, widthScale, heightScale, scale: Math.min(widthScale, heightScale) };
  };

  const candidates = [tryWhiteSpace(null)];
  if (RELAXED_WHITE_SPACE[baseWhiteSpace]) candidates.push(tryWhiteSpace(RELAXED_WHITE_SPACE[baseWhiteSpace]));
  if (singleLineAllowed && baseWhiteSpace !== 'nowrap') candidates.push(tryWhiteSpace('nowrap'));
  const best = candidates.reduce((a, b) => (b.scale > a.scale + 0.01 ? b : a));

  resetAttr(from, fromAttr);
  if (best.whiteSpace) {
    from.style.setProperty('white-space', best.whiteSpace, 'important');
    state.records.push({ kind: 'fit', target: from, originalAttr: fromAttr, writtenAttr: from.getAttribute('style') });
  }
  if (best.scale >= 1 || best.scale < MIN_BOX_SCALE) return;

  if (best.widthScale < 1 && hasNoTransform(view.getComputedStyle(from))) {
    // 横幅が足りない: その行自体を左上基準で縮める（はみ出した行は中央揃えでも左端から並ぶ）
    state.lineFits.set(from, scaleElement(state, from, Math.max(best.widthScale, MIN_BOX_SCALE), 'top left'));
  }

  // 行を縮めてもまだ枠の高さからあふれるなら、枠の中身全体を縮める
  const height = box.scrollHeight;
  if (!limit || height <= limit + 2) return;
  const ratio = limit / height;
  if (ratio < MIN_BOX_SCALE) return;
  let target = null;
  for (let a = from; a && a !== box; a = a.parentElement) {
    if (hasNoTransform(view.getComputedStyle(a))) target = a;
  }
  if (!target) return;
  state.fits.set(box, scaleElement(state, target, ratio, originFor(view.getComputedStyle(from))));
}

function restoreFit(record) {
  const { target, originalAttr, writtenAttr } = record;
  if (writtenAttr === originalAttr) return;
  if (target.getAttribute('style') === writtenAttr) return resetAttr(target, originalAttr);
  target.style.removeProperty('transform');
  target.style.removeProperty('transform-origin');
}

/** 見た目の行に分けるためだけの要素（Canva などが1行ずつ span で包み、br で改行する） */
const LINE_WRAPPERS = new Set(['span', 'font']);
const LINE_BREAKS = new Set(['br', 'wbr']);
const ANY_TAG = /<\/?[gcx]\d+\s*\/?>/g;

/**
 * 行を包む要素と改行だけでできた段落か。行ごとに分かれたリンクは、
 * すべて同じリンク先で、文字がどれもそのリンクの中にあるときだけ1つのリンクとみなす
 */
function isLineOnly(unit, tokens) {
  const links = tokens.filter(({ type, node }) => type === 'g' && node.localName === 'a').map(({ node }) => node);
  const ok = tokens.every(({ type, node }) =>
    type === 'x' ? LINE_BREAKS.has(node.localName) : type === 'g' && (node.localName === 'a' || LINE_WRAPPERS.has(node.localName)));
  if (!ok || new Set(links.map((a) => a.getAttribute('href'))).size > 1) return false;
  return !links.length || unit.textNodes.every((n) => links.some((a) => a.contains(n)));
}

/**
 * モデルが記号の対応を崩したとき、記号を除いた訳文を原文の最初の文字の位置にまとめ、
 * 残りの文字は空に、改行は取り除いた木を作る（行の要素は残すので、元に戻せる）
 */
// 記号を外した跡は、英数字どうしの間だけ空白にする（日本語の文中には空白を入れない）
function plainText(translated) {
  const stripped = translated
    .replace(ANY_TAG, '\u0000')
    .replace(/(?<=[A-Za-z0-9])\u0000+(?=[A-Za-z0-9])/g, ' ')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (stripped && parseMarked(stripped)[0]?.value) || null;
}

const leavesOf = (nodes, out = []) => {
  for (const n of nodes) {
    if (n.type === 'text') out.push(collapse(n.value));
    else if (n.children) leavesOf(n.children, out);
  }
  return out.filter(Boolean);
};

/** 訳文を要素の外に置き、要素の中には原文をそのまま残した応答なら、外にある訳文だけを返す */
function echoedOutside(source, tree) {
  if (!tree || !hoistsText(source, tree)) return null;
  const sourceTexts = new Set(leavesOf(parseMarked(source)));
  if (!leavesOf(tree.filter((n) => n.type !== 'text')).every((t) => sourceTexts.has(t))) return null;
  return collapse(tree.filter((n) => n.type === 'text').map((n) => n.value).join('')) || null;
}

function plainTree(source, text) {
  let placed = false;
  const rewrite = (nodes) =>
    nodes
      .filter((n) => n.type !== 'x')
      .map((n) => {
        if (n.type !== 'text') return { ...n, children: rewrite(n.children) };
        if (placed || !n.value.trim()) return { ...n, value: '' };
        placed = true;
        return { ...n, value: text };
      });
  return rewrite(parseMarked(source));
}

/** 原文では文字がすべて要素の中にあったのに、訳では要素の外に出ている（モデルが記号を崩した） */
function hoistsText(source, tree) {
  const outside = (nodes) => nodes.some((n) => n.type === 'text' && n.value.trim());
  return !outside(parseMarked(source)) && outside(tree);
}

function isRunIntact(unit) {
  return unit.nodes.every((n, i) => n.parentNode === unit.parent && (i === 0 || unit.nodes[i - 1].nextSibling === n));
}

export function applyRun(state, unit, translated) {
  if (!isRunIntact(unit)) return 'stale';
  const { text, tokens } = serializeRun(unit.nodes, unit.options);
  if (text !== unit.text) return 'stale';

  let tree = null;
  try {
    tree = parseMarked(translated.trim());
  } catch {
    // 記号の対応が崩れた応答。下で地の文として扱えるか確かめる
  }
  if (!tree?.length || !matchesTokens(tree, tokens) || hoistsText(unit.text, tree)) {
    if (!isLineOnly(unit, tokens)) return 'mismatch';
    const text = echoedOutside(unit.text, tree) ?? plainText(translated);
    tree = text && plainTree(unit.text, text);
    if (!tree) return 'mismatch';
  }

  const doc = unit.parent.ownerDocument;
  const box = findFixedBox(unit.parent);
  if (box && !state.baselines.has(box)) state.baselines.set(box, box.scrollHeight);
  const originalLines = box ? lineCount(unit.nodes) : 0;
  const singleLineAllowed = originalLines
    ? originalLines === 1
    : unit.text.length <= SHORT_TEXT_LENGTH && !/<x\d+\/>/.test(unit.text);
  const elementChildren = tokens
    .filter((t) => t.type !== 'x')
    .map((t) => ({ node: t.node, children: [...t.node.childNodes] }));
  const marker = doc.createComment('apt');
  unit.parent.insertBefore(marker, unit.nodes[0]);

  // 元のテキストノードを使い回す（React などのフレームワークが参照を保持しているため）
  const isText = (n) => n.nodeType === 3;
  const pools = new Map(tokens.filter((t) => t.type !== 'x').map((t) => [t.node, [...t.node.childNodes].filter(isText)]));
  const reused = [];
  const written = [];
  const write = (node, value) => {
    reused.push({ node, original: node.data, written: value });
    node.data = value;
    written.push(node);
    return node;
  };
  const build = (nodes, pool) => {
    const out = nodes.map((n) => {
      if (n.type === 'text') {
        if (pool.length) return write(pool.shift(), n.value);
        const t = doc.createTextNode(n.value);
        written.push(t);
        return t;
      }
      const { node } = tokens[n.id];
      if (n.type !== 'x') node.replaceChildren(...build(n.children, pools.get(node)));
      return node;
    });
    // 使わなかった元のテキストノードも空にして残す（外すと参照先が DOM から消える）
    for (const leftover of pool.splice(0)) out.push(write(leftover, ''));
    return out;
  };
  const top = build(tree, unit.nodes.filter(isText));

  for (const n of unit.nodes) if (n.parentNode === unit.parent) n.remove();
  for (const n of top) unit.parent.insertBefore(n, marker);
  marker.remove();

  for (const t of written) state.seen.set(t, t.data);
  state.records.push({ kind: 'run', parent: unit.parent, originals: unit.nodes.slice(), elementChildren, current: top, reused });
  if (box) fitBox(state, box, unit.parent, singleLineAllowed);
  else relaxWhiteSpace(state, unit.parent);
  return 'applied';
}

// 地の文（タグなしの原文）なのにモデルが付けてきた <gN>・<cN>・<xN/> を取り除く
const STRAY_TAG = /<\/?[gc]\d+>|<x\d+\/>/g;
const plainOf = (translated) => translated.replace(STRAY_TAG, '').trim();

/** 2語以上の原文が訳文の前後にそのまま付いていたら取り除く（ローカルのモデルにある癖） */
function dropEcho(value, source) {
  const s = source.trim();
  if (!/\s/.test(s) || value.length <= s.length) return value;
  if (value.endsWith(s)) return value.slice(0, -s.length).trim();
  if (value.startsWith(s)) return value.slice(s.length).trim();
  return value;
}

export function applyText(state, unit, translated) {
  const { node } = unit;
  const value = dropEcho(plainOf(translated), unit.text);
  if (!value) return 'failed';
  if (!node.parentNode || collapse(node.data) !== unit.text) return 'stale';
  const original = node.data;
  const lead = original.match(/^\s*/)[0];
  const trail = original.match(/\s*$/)[0];
  node.data = lead + value + trail;
  state.seen.set(node, node.data);
  state.records.push({ kind: 'text', node, original, written: node.data });
  return 'applied';
}

export function applyTitle(state, doc, unit, translated) {
  const value = plainOf(translated);
  if (!value) return 'failed';
  if (collapse(doc.title) !== unit.text) return 'stale';
  const original = doc.title;
  doc.title = value;
  state.titleWritten = doc.title;
  state.records.push({ kind: 'title', original, written: doc.title });
  return 'applied';
}

function restoreRun(doc, record) {
  const { parent, current, originals, elementChildren, reused } = record;
  for (const { node, original, written } of reused) if (node.data === written) node.data = original;
  const first = current.find((n) => n.parentNode === parent);
  if (!first) return;
  const marker = doc.createComment('apt');
  parent.insertBefore(marker, first);
  for (const n of current) if (n.parentNode === parent) n.remove();
  for (const { node, children } of elementChildren) node.replaceChildren(...children);
  for (const n of originals) parent.insertBefore(n, marker);
  marker.remove();
}

export function restoreAll(state, doc) {
  for (const record of state.records.reverse()) {
    try {
      if (record.kind === 'run') restoreRun(doc, record);
      else if (record.kind === 'style') restoreStyle(record);
      else if (record.kind === 'fit') restoreFit(record);
      else if (record.kind === 'text' && record.node.data === record.written) record.node.data = record.original;
      else if (record.kind === 'title' && doc.title === record.written) doc.title = record.original;
    } catch {
      // ページ側が DOM を組み替えて戻せない記録は飛ばし、残りを復元する
    }
  }
  state.records = [];
  state.seen = new WeakMap();
  state.titleWritten = null;
  state.fits = new Map();
  state.lineFits = new Map();
  state.baselines = new WeakMap();
}
