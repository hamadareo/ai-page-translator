import { openaiProvider } from './openai.js';
import { compatProvider } from './openai-compatible.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { parseTranslations } from '../prompt.js';
import { TranslationError, classifyHttpError, networkError } from '../errors.js';

export const PROVIDERS = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  compat: compatProvider,
};

/** @returns {Promise<string[]>} */
export async function callProvider(providerId, texts, targetLang, config, { fetch = globalThis.fetch, signal } = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new TranslationError('config', `未対応のプロバイダです: ${providerId}`);
  const { url, init } = provider.buildRequest(texts, targetLang, config);

  let res;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw networkError(url);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw classifyHttpError(res.status, body, { url, retryAfter: res.headers.get('retry-after') });
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new TranslationError('bad_response', '応答がJSONではありません');
  }
  return parseTranslations(provider.extractText(json), texts.length);
}
