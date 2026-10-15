import { STATUS_HOST_ID } from './extract.js';

const WAIT_NOTICE_MS = 10000;

export function statusText(status, now = Date.now()) {
  switch (status.state) {
    case 'translating': {
      if (status.phase) return status.phase;
      const text = `翻訳中… ${status.done}/${status.total}`;
      const waited = status.progressAt == null ? 0 : now - status.progressAt;
      return waited >= WAIT_NOTICE_MS ? `${text}（応答待ち ${Math.floor(waited / 1000)}秒）` : text;
    }
    case 'done':
      if (!status.failed) return '翻訳完了';
      return status.error ? `翻訳完了（${status.failed}件失敗: ${status.error.message}）` : `翻訳完了（${status.failed}件失敗）`;
    case 'stopped':
      return `停止しました（${status.done}/${status.total}）`;
    case 'error':
      return `エラー: ${status.error?.message ?? '不明なエラー'}`;
    default:
      return '';
  }
}

const CSS = `
  :host { all: initial; }
  .box {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; gap: 8px; align-items: center; max-width: 360px; padding: 8px 12px;
    border-radius: 8px; background: #1f2937; color: #f9fafb;
    font: 13px/1.4 system-ui, -apple-system, "Hiragino Sans", sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, .25); transition: opacity .3s, transform .3s;
  }
  .box.error { background: #b91c1c; }
  .box.dim { opacity: .45; transform: scale(.9); transform-origin: bottom right; }
  .close { all: unset; cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1; }
`;

export function createStatusOverlay(doc, {
  dimAfterMs = 4000,
  now = Date.now,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
} = {}) {
  let host = null;
  let ticker = null;
  let last = null;
  let box = null;
  let message = null;
  let timer = null;

  function ensure() {
    if (host?.isConnected) return;
    host = doc.createElement('div');
    host.id = STATUS_HOST_ID;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="box" role="status" aria-live="polite"><span class="msg"></span><button type="button" class="close" aria-label="閉じる">×</button></div>`;
    box = root.querySelector('.box');
    message = root.querySelector('.msg');
    root.querySelector('.close').addEventListener('click', hide);
    doc.documentElement.appendChild(host);
  }

  function stopTicker() {
    if (ticker != null) clearInterval(ticker);
    ticker = null;
  }

  function render() {
    message.textContent = statusText(last, now());
  }

  function hide() {
    stopTicker();
    clearTimeout(timer);
    host?.remove();
    host = null;
  }

  function update(status) {
    if (!statusText(status, now())) return hide();
    ensure();
    clearTimeout(timer);
    last = status;
    render();
    // 翻訳中は1秒ごとに描き直して応答待ちの秒数を進める
    if (status.state === 'translating') ticker ??= setInterval(() => host?.isConnected && render(), 1000);
    else stopTicker();
    box.classList.toggle('error', status.state === 'error');
    box.classList.remove('dim');
    if (status.state === 'done' || status.state === 'stopped') {
      timer = setTimeout(() => box?.classList.add('dim'), dimAfterMs);
    }
  }

  return {
    update,
    hide,
    get element() {
      return host;
    },
    get text() {
      return message?.textContent ?? '';
    },
  };
}
