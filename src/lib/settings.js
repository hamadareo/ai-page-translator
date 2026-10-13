export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'compat'];

export const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  compat: 'OpenAI互換 / ローカルLLM',
};

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  provider: 'openai',
  targetLang: '日本語',
  maxUnitsPerBatch: 40,
  maxCharsPerBatch: 3000,
  concurrency: 3,
  ignoreTranslateNo: false,
  providers: {
    openai: { apiKey: '', model: 'gpt-5.5' },
    anthropic: { apiKey: '', model: 'claude-opus-5-5' },
    gemini: { apiKey: '', model: 'gemini-3.8-flash' },
    compat: { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1', jsonMode: false },
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
  if (s.provider !== 'compat' && !p.apiKey?.trim()) return 'APIキーを設定してください';
  if (s.provider === 'compat') {
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

export async function loadSettings(storage) {
  const result = await storage.get(SETTINGS_KEY);
  return mergeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(storage, settings) {
  await storage.set({ [SETTINGS_KEY]: settings });
}
