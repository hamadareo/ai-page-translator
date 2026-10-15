(() => {
  if (globalThis.__aptContentLoaded) return;
  globalThis.__aptContentLoaded = true;

  const isInViewport = (unit) => {
    const el = unit.kind === 'run' ? unit.parent : unit.kind === 'text' ? unit.node.parentElement : null;
    if (!el) return true;
    const rect = el.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= window.innerHeight;
  };

  const ready = (async () => {
    const [{ createPageTranslator }, { createStatusOverlay }, { createRuntimeLink }] = await Promise.all([
      import(chrome.runtime.getURL('src/lib/page-translator.js')),
      import(chrome.runtime.getURL('src/lib/status-overlay.js')),
      import(chrome.runtime.getURL('src/lib/runtime-link.js')),
    ]);
    const overlay = createStatusOverlay(document);
    let translator = null;
    // 拡張機能が再読み込みされたら、このページに残った古い翻訳は静かに止める
    const link = createRuntimeLink(chrome.runtime, {
      onLost: () => {
        overlay.hide();
        translator?.stop();
      },
    });
    translator = createPageTranslator({
      document,
      isInViewport,
      sendMessage: (message) =>
        link.send(message).catch((err) => ({
          ok: false,
          error: { kind: 'unknown', message: String(err?.message ?? err) },
        })),
      onStatus: (status) => {
        // 送信で接続が切れたことに気づく（切れていれば onLost で止まり、表示も更新しない）
        link.send({ type: 'progress', status }).catch(() => {});
        if (link.alive()) overlay.update(status);
      },
    });
    return translator;
  })();

  const actions = {
    translate: (t) => {
      t.translate();
      return t.getStatus();
    },
    stop: (t) => {
      t.stop();
      return t.getStatus();
    },
    restore: (t) => {
      t.restore();
      return t.getStatus();
    },
    status: (t) => t.getStatus(),
    phase: (t, message) => {
      t.setPhase(message.text);
      return t.getStatus();
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const action = actions[message?.type];
    if (!action) return false;
    ready.then(
      (translator) => sendResponse({ ok: true, status: action(translator, message) }),
      (err) => sendResponse({ ok: false, error: { kind: 'unknown', message: String(err?.message ?? err) } }),
    );
    return true;
  });
})();
