export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'compat', 'lmstudio'];

/** APIキーが不要で、ベースURLを持つプロバイダ */
const LOCAL_PROVIDERS = new Set(['compat', 'lmstudio']);

export const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  compat: 'OpenAI互換 / ローカルLLM',
  lmstudio: 'LM Studio（ローカル）',
};

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  provider: 'openai',
  targetLang: '日本語',
  maxUnitsPerBatch: 40,
  maxCharsPerBatch: 3000,
  concurrency: 3,
  ignoreTranslateNo: false,
  followLinks: false,
  providers: {
    openai: { apiKey: '', model: 'gpt-5.5' },
    anthropic: { apiKey: '', model: 'claude-opus-5-5' },
    gemini: { apiKey: '', model: 'gemini-3.8-flash' },
    compat: { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1', jsonMode: false },
    lmstudio: { model: '', baseUrl: 'http://localhost:1234/v1', autoStart: true },
  },
};

export function mergeSettings(stored) {
  const s = stored ?? {};
  const providers = {};
  for (const id of PROVIDER_IDS) {
    providers[id] = { ...DEFAULT_SETTINGS.providers[id], ...(s.providers?.[id] ?? {}) };
  }
  return { ...DEFAULT_SETTINGS, ...s, providers };
}

/** @returns {string|null} */
export function validateSettings(s) {
  if (!PROVIDER_IDS.includes(s.provider)) return 'プロバイダが不正です';
  const p = s.providers[s.provider];
  if (!p.model?.trim()) return 'モデル名を設定してください';
  if (!LOCAL_PROVIDERS.has(s.provider) && !p.apiKey?.trim()) return 'APIキーを設定してください';
  if (LOCAL_PROVIDERS.has(s.provider)) {
    let url;
    try {
      url = new URL(p.baseUrl);
    } catch {
      return 'ベースURLが不正です';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'ベースURLが不正です';
  }
  if (!s.targetLang?.trim()) return '翻訳先言語を設定してください';
  if (!(s.maxUnitsPerBatch >= 1) || !(s.maxCharsPerBatch >= 1)) return 'バッチ上限が不正です';
  if (!(s.concurrency >= 1)) return '同時リクエスト数は1以上にしてください';
  return null;
}

/**
 * 手元の LLM には小さなまとまりを送る。LM Studio は同時に処理できるので2件ずつ送る
 * （M3 Pro + gemma-3-12b の実測で1件ずつより約1.6倍速い。3件では伸びが小さい）
 */
const LOCAL_LIMITS = { maxUnitsPerBatch: 10, maxCharsPerBatch: 1000, concurrency: 2 };

/** 実際に使う送り方（まとまりの大きさと同時数） */
export function effectiveLimits(s) {
  const limits = { maxUnitsPerBatch: s.maxUnitsPerBatch, maxCharsPerBatch: s.maxCharsPerBatch, concurrency: s.concurrency };
  if (s.provider !== 'lmstudio') return limits;
  return {
    maxUnitsPerBatch: Math.min(limits.maxUnitsPerBatch, LOCAL_LIMITS.maxUnitsPerBatch),
    maxCharsPerBatch: Math.min(limits.maxCharsPerBatch, LOCAL_LIMITS.maxCharsPerBatch),
    concurrency: Math.min(limits.concurrency, LOCAL_LIMITS.concurrency),
  };
}

export async function loadSettings(storage) {
  const result = await storage.get(SETTINGS_KEY);
  return mergeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(storage, settings) {
  await storage.set({ [SETTINGS_KEY]: settings });
}
