import { cacheKey } from './cache.js';
import { callProvider } from './providers/index.js';
import { withRetry } from './retry.js';
import { TranslationError } from './errors.js';
import { validateSettings } from './settings.js';

/** 応答が使えない（bad_response）ときはバッチを半分に分けて再依頼する。最後まで失敗した要素は null。 */
export async function translateWithSplit(texts, translateOnce) {
  if (!texts.length) return [];
  try {
    return await translateOnce(texts);
  } catch (err) {
    if (err?.kind !== 'bad_response') throw err;
    if (texts.length === 1) return [null];
    const mid = Math.ceil(texts.length / 2);
    const left = await translateWithSplit(texts.slice(0, mid), translateOnce);
    const right = await translateWithSplit(texts.slice(mid), translateOnce);
    return [...left, ...right];
  }
}

export function createTranslateService({ getSettings, cache, limiter, call = callProvider, fetch, sleep }) {
  return async function translateTexts(texts) {
    const settings = await getSettings();
    const invalid = validateSettings(settings);
    if (invalid) throw new TranslationError('config', invalid);
    limiter.setMax(settings.concurrency);

    const { provider, targetLang } = settings;
    const config = settings.providers[provider];
    const keys = await Promise.all(texts.map((t) => cacheKey(provider, config.model, targetLang, t)));
    const cached = await cache.getMany(keys);
    const result = cached.map((v) => v ?? null);
    const missing = [];
    cached.forEach((v, i) => {
      if (v === undefined) missing.push(i);
    });
    if (!missing.length) return result;

    const once = (subset) =>
      limiter.run(() => withRetry(() => call(provider, subset, targetLang, config, { fetch }), { sleep }));
    const translated = await translateWithSplit(missing.map((i) => texts[i]), once);

    const entries = [];
    missing.forEach((index, j) => {
      result[index] = translated[j];
      if (translated[j] != null) entries.push({ key: keys[index], value: translated[j] });
    });
    if (entries.length) {
      try {
        await cache.setMany(entries);
      } catch {
        // 保存に失敗しても訳文は返す（キャッシュは最適化にすぎない）
      }
    }
    return result;
  };
}
