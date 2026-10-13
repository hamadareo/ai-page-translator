import { serializeRun, parseMarked, matchesTokens, collapse } from './extract.js';

export function createDomState() {
  return { seen: new WeakMap(), records: [], titleWritten: null };
}

/** 拡張機能が書いた内容のまま残っているテキストノードか */
export function isOwnText(state, node) {
  return state.seen.get(node) === node.data;
}

function isRunIntact(unit) {
  return unit.nodes.every((n, i) => n.parentNode === unit.parent && (i === 0 || unit.nodes[i - 1].nextSibling === n));
}

export function applyRun(state, unit, translated) {
  if (!isRunIntact(unit)) return 'stale';
  const { text, tokens } = serializeRun(unit.nodes);
  if (text !== unit.text) return 'stale';

  let tree;
  try {
    tree = parseMarked(translated.trim());
  } catch {
    return 'mismatch';
  }
  if (!tree.length || !matchesTokens(tree, tokens)) return 'mismatch';

  const doc = unit.parent.ownerDocument;
  const elementChildren = tokens
    .filter((t) => t.type !== 'x')
    .map((t) => ({ node: t.node, children: [...t.node.childNodes] }));
  const marker = doc.createComment('apt');
  unit.parent.insertBefore(marker, unit.nodes[0]);

  const created = [];
  const build = (nodes) =>
    nodes.map((n) => {
      if (n.type === 'text') {
        const t = doc.createTextNode(n.value);
        created.push(t);
        return t;
      }
      const { node } = tokens[n.id];
      if (n.type !== 'x') node.replaceChildren(...build(n.children));
      return node;
    });
  const top = build(tree);

  for (const n of unit.nodes) if (n.parentNode === unit.parent) n.remove();
  for (const n of top) unit.parent.insertBefore(n, marker);
  marker.remove();

  for (const t of created) state.seen.set(t, t.data);
  state.records.push({ kind: 'run', parent: unit.parent, originals: unit.nodes.slice(), elementChildren, current: top });
  return 'applied';
}

export function applyText(state, unit, translated) {
  const { node } = unit;
  const value = translated.trim();
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
  const value = translated.trim();
  if (!value) return 'failed';
  if (collapse(doc.title) !== unit.text) return 'stale';
  const original = doc.title;
  doc.title = value;
  state.titleWritten = doc.title;
  state.records.push({ kind: 'title', original, written: doc.title });
  return 'applied';
}

function restoreRun(doc, record) {
  const { parent, current, originals, elementChildren } = record;
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
    if (record.kind === 'run') restoreRun(doc, record);
    else if (record.kind === 'text' && record.node.data === record.written) record.node.data = record.original;
    else if (record.kind === 'title' && doc.title === record.written) doc.title = record.original;
  }
  state.records = [];
  state.seen = new WeakMap();
  state.titleWritten = null;
}
