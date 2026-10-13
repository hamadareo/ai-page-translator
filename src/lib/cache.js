export const CACHE_KEY = 'translationCache';

export async function cacheKey(provider, model, targetLang, text) {
  const data = new TextEncoder().encode(`${provider}|${model}|${targetLang}|${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 値は { v: 訳文, t: 最終利用時刻 } として1つのオブジェクトにまとめて保存する */
export function createCache(storage, { maxEntries = 5000, now = Date.now } = {}) {
  let loading = null;

  const load = () => {
    loading ??= storage.get(CACHE_KEY).then((r) => new Map(Object.entries(r[CACHE_KEY] ?? {})));
    return loading;
  };

  return {
    async getMany(keys) {
      const map = await load();
      const t = now();
      return keys.map((k) => {
        const entry = map.get(k);
        if (!entry) return undefined;
        entry.t = t;
        return entry.v;
      });
    },

    async setMany(entries) {
      const map = await load();
      const t = now();
      for (const { key, value } of entries) map.set(key, { v: value, t });
      if (map.size > maxEntries) {
        const oldest = [...map.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, map.size - maxEntries);
        for (const [k] of oldest) map.delete(k);
      }
      await storage.set({ [CACHE_KEY]: Object.fromEntries(map) });
    },

    async clear() {
      loading = Promise.resolve(new Map());
      await storage.remove(CACHE_KEY);
    },

    async size() {
      return (await load()).size;
    },
  };
}
