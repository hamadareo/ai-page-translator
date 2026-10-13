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
    const [{ createPageTranslator }, { createStatusOverlay }] = await Promise.all([
      import(chrome.runtime.getURL('src/lib/page-translator.js')),
      import(chrome.runtime.getURL('src/lib/status-overlay.js')),
    ]);
    const overlay = createStatusOverlay(document);
    return createPageTranslator({
      document,
      isInViewport,
      sendMessage: (message) =>
        chrome.runtime.sendMessage(message).catch((err) => ({
          ok: false,
          error: { kind: 'unknown', message: String(err?.message ?? err) },
        })),
      onStatus: (status) => {
        overlay.update(status);
        chrome.runtime.sendMessage({ type: 'progress', status }).catch(() => {});
      },
    });
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
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const action = actions[message?.type];
    if (!action) return false;
    ready.then(
      (translator) => sendResponse({ ok: true, status: action(translator) }),
      (err) => sendResponse({ ok: false, error: { kind: 'unknown', message: String(err?.message ?? err) } }),
    );
    return true;
  });
})();
