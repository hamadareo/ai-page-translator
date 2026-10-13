import { collectUnits, textUnitsOf, collectTitleUnit } from './extract.js';
import { createDomState, isOwnText, applyRun, applyText, applyTitle, restoreAll } from './rebuild.js';
import { makeBatches } from './batch.js';
import { FATAL_KINDS } from './errors.js';

const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };
const NO_BACKGROUND = { kind: 'unknown', message: 'バックグラウンドに接続できません' };

export function createPageTranslator({
  document,
  sendMessage,
  onStatus = () => {},
  debounceMs = 500,
  MutationObserverImpl = globalThis.MutationObserver,
  isInViewport = () => true,
}) {
  const dom = createDomState();
  let status = { state: 'idle', done: 0, total: 0, failed: 0, error: null };
  let session = 0;
  let config = null;
  let observer = null;
  let timer = null;
  let queue = Promise.resolve();
  // 送信済み（翻訳待ち・失敗含む）の原文。「翻訳」を押し直すたびにリセットして失敗分を再試行する
  let claimed = new WeakMap();
  let claimedTitle = null;

  const emit = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };

  const isSettledNodes = (nodes) => nodes.every((n) => isOwnText(dom, n) || claimed.get(n) === n.data);
  const isSettledTitle = (title) => title === dom.titleWritten || title === claimedTitle;

  function claim(unit) {
    if (unit.kind === 'run') for (const n of unit.textNodes) claimed.set(n, n.data);
    else if (unit.kind === 'text') claimed.set(unit.node, unit.node.data);
    else claimedTitle = document.title;
  }

  function apply(unit, translated) {
    if (unit.kind === 'run') return applyRun(dom, unit, translated);
    if (unit.kind === 'text') return applyText(dom, unit, translated);
    return applyTitle(dom, document, unit, translated);
  }

  function scheduleScan(id) {
    clearTimeout(timer);
    timer = setTimeout(() => scan(id), debounceMs);
  }

  function startObserver(id) {
    stopObserver();
    observer = new MutationObserverImpl(() => scheduleScan(id));
    observer.observe(document.documentElement, OBSERVE_OPTIONS);
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
  }

  /** 自分の DOM 書き換えを監視対象にしない */
  function withObserverPaused(fn) {
    if (!observer) return fn();
    const pending = observer.takeRecords();
    observer.disconnect();
    try {
      return fn();
    } finally {
      observer.observe(document.documentElement, OBSERVE_OPTIONS);
      if (pending.length) scheduleScan(session);
    }
  }

  function fail(error) {
    session++;
    stopObserver();
    emit({ state: 'error', error });
  }

  async function translateUnits(id, units) {
    const batches = makeBatches(units.map((u) => u.text), {
      maxUnits: config.maxUnitsPerBatch,
      maxChars: config.maxCharsPerBatch,
    }).map((indices) => indices.map((i) => units[i]));
    const fallback = [];

    const worker = async () => {
      while (batches.length && id === session) {
        const batch = batches.shift();
        const res = await sendMessage({ type: 'translateBatch', texts: batch.map((u) => u.text) });
        if (id !== session) return;
        if (!res?.ok) {
          const error = res?.error ?? NO_BACKGROUND;
          if (FATAL_KINDS.has(error.kind)) return fail(error);
          emit({ done: status.done + batch.length, failed: status.failed + batch.length, error });
          continue;
        }
        let failed = 0;
        withObserverPaused(() => {
          batch.forEach((unit, i) => {
            const translated = res.translations[i];
            if (translated == null) return void failed++;
            const result = apply(unit, translated);
            if (result === 'failed') failed++;
            else if (result === 'mismatch') fallback.push(...textUnitsOf(unit));
          });
        });
        emit({ done: status.done + batch.length, failed: status.failed + failed });
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker));
    if (fallback.length && id === session) {
      emit({ total: status.total + fallback.length });
      await translateUnits(id, fallback);
    }
  }

  async function runScan(id) {
    try {
      const units = collectUnits(document.body, { isSettled: isSettledNodes });
      const title = collectTitleUnit(document, isSettledTitle);
      if (title) units.unshift(title);
      if (units.length) {
        units.forEach(claim);
        units.sort((a, b) => Number(isInViewport(b)) - Number(isInViewport(a)));
        emit({ state: 'translating', total: status.total + units.length });
        await translateUnits(id, units);
      }
      if (id === session && status.state === 'translating') emit({ state: 'done' });
    } catch (err) {
      if (id === session) fail({ kind: 'unknown', message: String(err?.message ?? err) });
    }
  }

  function scan(id) {
    queue = queue.then(() => (id === session ? runScan(id) : undefined));
    return queue;
  }

  async function translate() {
    if (status.state === 'translating' || status.state === 'done') return status;
    const id = ++session;
    claimed = new WeakMap();
    claimedTitle = null;
    emit({ state: 'translating', done: 0, total: 0, failed: 0, error: null });
    const res = await sendMessage({ type: 'getConfig' });
    if (id !== session) return status;
    if (!res?.ok) {
      fail(res?.error ?? NO_BACKGROUND);
      return status;
    }
    config = res;
    startObserver(id);
    await scan(id);
    return status;
  }

  function stop() {
    session++;
    stopObserver();
    if (status.state !== 'idle') emit({ state: 'stopped' });
  }

  function restore() {
    session++;
    stopObserver();
    restoreAll(dom, document);
    emit({ state: 'idle', done: 0, total: 0, failed: 0, error: null });
  }

  return { translate, stop, restore, getStatus: () => status };
}
