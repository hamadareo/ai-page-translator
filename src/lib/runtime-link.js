/**
 * content script から拡張機能本体への送信。拡張機能が再読み込みされると、開いていたページに
 * 古い content script が残り、chrome.runtime.sendMessage がその場で例外を投げる
 * （"Extension context invalidated"）。それを Promise の失敗に変え、接続が切れたことを1回だけ知らせる。
 */
export function createRuntimeLink(runtime, { onLost = () => {} } = {}) {
  let lost = false;
  const alive = () => Boolean(runtime?.id);
  const markLost = () => {
    if (lost) return;
    lost = true;
    onLost();
  };

  function send(message) {
    if (!alive()) {
      markLost();
      return Promise.reject(new Error('Extension context invalidated.'));
    }
    try {
      return Promise.resolve(runtime.sendMessage(message));
    } catch (err) {
      if (!alive()) markLost();
      return Promise.reject(err);
    }
  }

  return { alive, send };
}
