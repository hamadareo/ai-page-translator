import { STATUS_HOST_ID } from './extract.js';

export function statusText(status) {
  switch (status.state) {
    case 'translating':
      return status.phase || `翻訳中… ${status.done}/${status.total}`;
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

export function createStatusOverlay(doc, { dimAfterMs = 4000 } = {}) {
  let host = null;
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

  function hide() {
    clearTimeout(timer);
    host?.remove();
    host = null;
  }

  function update(status) {
    const text = statusText(status);
    if (!text) return hide();
    ensure();
    clearTimeout(timer);
    message.textContent = text;
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
  };
}
