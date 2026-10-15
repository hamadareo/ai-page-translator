import { loadSettings, validateSettings } from './lib/settings.js';
import { createCache } from './lib/cache.js';
import { createLimiter } from './lib/limiter.js';
import { createTranslateService } from './lib/translate-service.js';
import { callProvider } from './lib/providers/index.js';
import { toErrorPayload, TranslationError } from './lib/errors.js';
import { ensureLmStudio, listLmStudioModels } from './lib/lmstudio.js';

const storage = chrome.storage.local;
const cache = createCache(storage);
const translateTexts = createTranslateService({
  getSettings: () => loadSettings(storage),
  cache,
  limiter: createLimiter(3),
});

function assertValid(settings) {
  const invalid = validateSettings(settings);
  if (invalid) throw new TranslationError('config', invalid);
}

// 応答待ちの間に service worker がアイドル終了されないよう、拡張機能 API を定期的に呼ぶ
let inFlight = 0;
let keepAliveTimer = null;
async function keepAlive(work) {
  if (inFlight++ === 0) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    return await work();
  } finally {
    if (--inFlight === 0) clearInterval(keepAliveTimer);
  }
}

const sendNativeMessage = (host, message) => chrome.runtime.sendNativeMessage(host, message);

/** LM Studio を使う設定なら、必要に応じて起動とモデル読み込みを済ませる */
function prepareProvider(settings, tabId) {
  if (settings.provider !== 'lmstudio') return Promise.resolve();
  const onProgress = (text) => {
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'phase', text }).catch(() => {});
  };
  return keepAlive(() => ensureLmStudio(settings.providers.lmstudio, { sendNativeMessage, onProgress }));
}

const handlers = {
  async translateBatch({ texts }) {
    return { translations: await keepAlive(() => translateTexts(texts)) };
  },
  async getConfig(_message, sender) {
    const s = await loadSettings(storage);
    assertValid(s);
    await prepareProvider(s, sender?.tab?.id);
    return {
      maxUnitsPerBatch: s.maxUnitsPerBatch,
      maxCharsPerBatch: s.maxCharsPerBatch,
      concurrency: s.concurrency,
      ignoreTranslateNo: s.ignoreTranslateNo,
    };
  },
  async testConnection({ settings }) {
    assertValid(settings);
    await prepareProvider(settings, null);
    const [sample] = await callProvider(settings.provider, ['Hello, world!'], settings.targetLang, settings.providers[settings.provider]);
    return { sample };
  },
  async listLmStudioModels() {
    return { models: await listLmStudioModels({ sendNativeMessage }) };
  },
  async clearCache() {
    await cache.clear();
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender).then(
    (data) => sendResponse({ ok: true, ...data }),
    (err) => sendResponse({ ok: false, error: toErrorPayload(err) }),
  );
  return true;
});
