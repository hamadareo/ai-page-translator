export const STATUS_HOST_ID = 'apt-status-host';

const TEXT = 3;
const ELEMENT = 1;
const COMMENT = 8;

/** 段落の中で目印タグ化してよいインライン要素 */
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
]);
/** 中身を訳さないインライン要素（<cN> タグ） */
const CODE_LIKE = new Set(['code', 'kbd', 'samp']);
/** 子を持たないインライン要素（<xN/> タグ） */
const VOID_INLINE = new Set(['br', 'img', 'wbr']);
/** 中身を翻訳しない要素 */
const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'pre', 'textarea', 'input', 'select', 'option',
  'svg', 'math', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'head',
]);
/** DOM 上で移動させると状態が壊れる要素。段落を区切る境界として扱う */
const BOUNDARY = new Set(['iframe', 'object', 'embed', 'video', 'audio', 'canvas']);

const LETTER = /\p{L}/u;

export const collapse = (s) => s.replace(/\s+/g, ' ').trim();

export function isExcluded(el) {
  if (SKIP.has(el.localName)) return true;
  if (el.id === STATUS_HOST_ID) return true;
  if (el.getAttribute('translate') === 'no') return true;
  if (el.classList?.contains('notranslate')) return true;
  const editable = el.getAttribute('contenteditable');
  return editable !== null && editable !== 'false';
}

/** 段落内で中身ごと1つの <xN/> として扱うノード */
function isOpaque(node) {
  if (node.nodeType !== ELEMENT) return node.nodeType !== TEXT;
  return VOID_INLINE.has(node.localName) || isExcluded(node);
}

function isPureInline(el) {
  if (!INLINE.has(el.localName) || isExcluded(el)) return false;
  for (const child of el.children) {
    if (BOUNDARY.has(child.localName)) return false;
    if (isOpaque(child)) continue;
    if (!isPureInline(child)) return false;
  }
  return true;
}

function collectTextNodes(nodes, { skipCode }) {
  const out = [];
  const visit = (n) => {
    if (n.nodeType === TEXT) {
      out.push(n);
      return;
    }
    if (n.nodeType !== ELEMENT || isOpaque(n)) return;
    if (skipCode && CODE_LIKE.has(n.localName)) return;
    n.childNodes.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function serializeRun(nodes) {
  const tokens = [];
  const serialize = (n) => {
    if (n.nodeType === TEXT) return escapeText(n.data);
    const id = tokens.length;
    if (isOpaque(n)) {
      tokens.push({ type: 'x', node: n });
      return `<x${id}/>`;
    }
    const type = CODE_LIKE.has(n.localName) ? 'c' : 'g';
    tokens.push({ type, node: n });
    const inner = [...n.childNodes].map(serialize).join('');
    return `<${type}${id}>${inner}</${type}${id}>`;
  };
  return { text: collapse(nodes.map(serialize).join('')), tokens };
}

export function collectUnits(root, { isSettled = () => false } = {}) {
  const units = [];

  const flush = (parent, run) => {
    if (!run.length) return;
    const textNodes = collectTextNodes(run, { skipCode: true }).filter((n) => LETTER.test(n.data));
    if (!textNodes.length || isSettled(textNodes)) return;
    units.push({ kind: 'run', parent, nodes: run, text: serializeRun(run).text, textNodes });
  };

  const walk = (el) => {
    let run = [];
    for (const child of [...el.childNodes]) {
      if (child.nodeType === TEXT || child.nodeType === COMMENT) {
        run.push(child);
      } else if (child.nodeType !== ELEMENT) {
        continue;
      } else if (BOUNDARY.has(child.localName)) {
        flush(el, run);
        run = [];
      } else if (isOpaque(child) || isPureInline(child)) {
        run.push(child);
      } else {
        flush(el, run);
        run = [];
        if (!isExcluded(child)) walk(child);
      }
    }
    flush(el, run);
  };

  if (!isExcluded(root)) walk(root);
  return units;
}

const TAG = /<(\/)?([gcx])(\d+)\s*(\/)?>/g;

export function parseMarked(str) {
  const root = { children: [] };
  const stack = [root];
  let last = 0;
  const pushText = (s) => {
    if (s) stack.at(-1).children.push({ type: 'text', value: unescapeText(s) });
  };
  for (const m of str.matchAll(TAG)) {
    pushText(str.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, type, idText, selfClosing] = m;
    const id = Number(idText);
    if (closing) {
      const top = stack.at(-1);
      if (stack.length === 1 || top.type !== type || top.id !== id) throw new Error(`unexpected </${type}${id}>`);
      stack.pop();
    } else if (type === 'x') {
      stack.at(-1).children.push({ type: 'x', id });
    } else {
      if (selfClosing) throw new Error(`self-closing <${type}${id}/>`);
      const node = { type, id, children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
    }
  }
  pushText(str.slice(last));
  if (stack.length !== 1) throw new Error('unclosed tag');
  return root.children;
}

export function matchesTokens(tree, tokens) {
  const counts = new Array(tokens.length).fill(0);
  let ok = true;
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') continue;
      if (tokens[n.id]?.type !== n.type) {
        ok = false;
        return;
      }
      counts[n.id]++;
      if (n.children) visit(n.children);
    }
  };
  visit(tree);
  return ok && counts.every((c) => c === 1);
}

export function textUnitsOf(unit) {
  return unit.textNodes.map((node) => ({ kind: 'text', node, text: collapse(node.data) }));
}

export function collectTitleUnit(doc, isSettled) {
  const title = doc.title;
  if (!LETTER.test(title) || isSettled(title)) return null;
  return { kind: 'title', text: collapse(title) };
}
