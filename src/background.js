import { loadSettings, validateSettings, effectiveLimits } from './lib/settings.js';
import { createCache } from './lib/cache.js';
import { createLimiter } from './lib/limiter.js';
import { createTranslateService } from './lib/translate-service.js';
import { callProvider } from './lib/providers/index.js';
import { toErrorPayload, TranslationError } from './lib/errors.js';
import { ensureLmStudio, listLmStudioModels, shareInFlight } from './lib/lmstudio.js';
import { createFollower } from './lib/follow.js';

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
// 複数のタブや接続テストから同時に呼ばれても、起動と読み込みは1回だけにする
const ensureLmStudioOnce = shareInFlight(ensureLmStudio, (config) => `${config.model}|${config.baseUrl}`);

/** LM Studio を使う設定なら、必要に応じて起動とモデル読み込みを済ませる */
function prepareProvider(settings, tabId) {
  if (settings.provider !== 'lmstudio') return Promise.resolve();
  const onProgress = (text) => {
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'phase', text }).catch(() => {});
  };
  return keepAlive(() => ensureLmStudioOnce(settings.providers.lmstudio, { sendNativeMessage, onProgress }));
}

// 「クリックした先のページも自動で翻訳する」: 翻訳中のタブでページが移ったら、移った先でも翻訳を始める
const ALL_SITES = { origins: ['<all_urls>'] };
const follower = createFollower({
  storage: chrome.storage.session,
  isEnabled: async () => (await loadSettings(storage)).followLinks && chrome.permissions.contains(ALL_SITES),
  inject: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'translate' });
  },
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => void follower.onUpdated(tabId, changeInfo, tab));
chrome.tabs.onRemoved.addListener((tabId) => void follower.onRemoved(tabId));

const handlers = {
  async follow({ tabId, on }) {
    await (on ? follower.start(tabId) : follower.stop(tabId));
    return {};
  },
  async translateBatch({ texts }, sender) {
    const tabId = sender?.tab?.id;
    const showPhase = (text) => {
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'phase', text }).catch(() => {});
    };
    let waited = false;
    const onWait = (ms) => {
      waited = true;
      showPhase(`利用上限のため ${Math.ceil(ms / 1000)} 秒待ってから続けます…`);
    };
    try {
      return { translations: await keepAlive(() => translateTexts(texts, { onWait })) };
    } finally {
      if (waited) showPhase(null);
    }
  },
  async getConfig(_message, sender) {
    const s = await loadSettings(storage);
    assertValid(s);
    await prepareProvider(s, sender?.tab?.id);
    return { ...effectiveLimits(s), ignoreTranslateNo: s.ignoreTranslateNo };
  },
  async testConnection({ settings }) {
    assertValid(settings);
    await prepareProvider(settings, null);
    const [sample] = await callProvider(settings.provider, ['Hello, world!'], settings.targetLang, settings.providers[settings.provider]);
    return { sample };
  },
  async listLmStudioModels({ baseUrl }) {
    return { models: await listLmStudioModels({ sendNativeMessage, baseUrl }) };
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
