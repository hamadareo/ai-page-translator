import { loadSettings, validateSettings } from './lib/settings.js';
import { createCache } from './lib/cache.js';
import { createLimiter } from './lib/limiter.js';
import { createTranslateService } from './lib/translate-service.js';
import { callProvider } from './lib/providers/index.js';
import { toErrorPayload, TranslationError } from './lib/errors.js';

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

const handlers = {
  async translateBatch({ texts }) {
    return { translations: await translateTexts(texts) };
  },
  async getConfig() {
    const s = await loadSettings(storage);
    assertValid(s);
    return { maxUnitsPerBatch: s.maxUnitsPerBatch, maxCharsPerBatch: s.maxCharsPerBatch, concurrency: s.concurrency };
  },
  async testConnection({ settings }) {
    assertValid(settings);
    const [sample] = await callProvider(settings.provider, ['Hello, world!'], settings.targetLang, settings.providers[settings.provider]);
    return { sample };
  },
  async clearCache() {
    await cache.clear();
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(
    (data) => sendResponse({ ok: true, ...data }),
    (err) => sendResponse({ ok: false, error: toErrorPayload(err) }),
  );
  return true;
});
