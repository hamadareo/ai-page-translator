import { openaiProvider } from './openai.js';
import { compatProvider } from './openai-compatible.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { lmstudioProvider } from './lmstudio.js';
import { parseTranslations } from '../prompt.js';
import { TranslationError, classifyHttpError, networkError } from '../errors.js';

export const PROVIDERS = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  compat: compatProvider,
  lmstudio: lmstudioProvider,
};

/** @returns {Promise<string[]>} */
/** 返事のない要求を打ち切るまでの時間 */
export const REQUEST_TIMEOUT_MS = 120000;

export async function callProvider(providerId, texts, targetLang, config, { fetch = globalThis.fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new TranslationError('config', `未対応のプロバイダです: ${providerId}`);
  const { url, init } = provider.buildRequest(texts, targetLang, config);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timeoutError = () =>
    new TranslationError('timeout', `応答に時間がかかりすぎたため打ち切りました（${Math.round(timeoutMs / 1000)}秒）`);

  try {
    let res;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw timeoutError();
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
      if (timedOut) throw timeoutError();
      throw new TranslationError('bad_response', '応答がJSONではありません');
    }
    return parseTranslations(provider.extractText(json), texts.length);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
